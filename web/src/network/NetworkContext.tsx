/**
 * Editing session for one network. Both editors (map and substation) share it.
 *
 * - Loads the working document (saved + journal) from the backend.
 * - `apply(ops)` applies ops locally first (optimistic) and appends them to the
 *   server journal; the journal is the crash-safe record of unsaved edits.
 * - Undo/redo are implemented with inverse ops, so they are journaled too.
 * - A line exists only while it has circuits: `apply` removes the lines a batch
 *   leaves without any, and asks first whenever a batch removes lines the
 *   caller did not have the user confirm (`ApplyOptions.confirmedLineIds`).
 * - `save()` commits the journal as a new version; `discard()` drops it.
 * - Several editors at once: the server streams a change event per journal append, save, discard and rollback
 *   (`/events`); the editor then pulls the entries it has not seen (`/journal?after=`), or the whole working document
 *   after a save / discard / rollback, and replays its own unsent batches on top (`journalSync.rebase`). A batch that
 *   touches a record someone else changed or deleted is dropped; so is one the server refuses. The user is told in a
 *   dialog, which also names a record whose open, unapplied form (`useDraftGuard`) was changed under it; a selected
 *   record that was deleted is deselected, closing its panel.
 */
import {createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState} from 'react'
import type {NetworkCollectionName, NetworkDocument, AnyNetworkRecord} from '@shared/network/records'
import {applyOps, emptyLinesOps, findRecord, NetworkOp} from '@shared/network/ops'
import {validateNetworkDocument} from '@shared/network/validation'
import type {ValidationIssue} from '@shared/templates/validation'
import {api, ApiError, CLIENT_ID, JournalState, NetworkChangeEvent} from '../api/client'
import {linesRemovedBy, linesRemovedNote} from './deleteLines'
import {diffDocs, META_KEY, parseRecordKey, PendingBatch, rebase, RebaseResult, RecordChange, RecordKey, touchesAny} from './journalSync'
import {collectionLabel} from './RegenerateBox'

export interface Selection {
    collection: NetworkCollectionName
    id: string
}

/** Options of `NetworkEditor.apply`. */
export interface ApplyOptions {
    /** Lines the user already agreed to remove (e.g. in the delete-line dialog): no second warning for them. */
    confirmedLineIds?: string[]
}

export interface NetworkEditor {
    networkId: string
    doc: NetworkDocument
    savedRevision: number
    savedAt: string
    journal: JournalState
    issues: ValidationIssue[]
    /** Error while talking to the journal; edits are kept locally until reload. */
    syncError?: string
    busy: boolean
    dirty: boolean
    canUndo: boolean
    canRedo: boolean
    selection: Selection | null
    select: (sel: Selection | null) => void
    apply: (ops: NetworkOp[], opts?: ApplyOptions) => boolean
    undo: () => void
    redo: () => void
    save: (force?: boolean) => Promise<boolean>
    discard: () => Promise<void>
    reload: () => Promise<void>
    exportJson: (working?: boolean) => void
    /** Marks a record as having an open form with unapplied edits until the returned function is called (`useDraftGuard`). */
    trackDraft?: (id: string) => () => void
}

const Ctx = createContext<NetworkEditor | null>(null)

/** Exposed for tests that render editor components with a prepared editor object. */
export const NetworkEditorContext = Ctx

export function useNetworkEditor(): NetworkEditor {
    const ctx = useContext(Ctx)
    if (!ctx) throw new Error('useNetworkEditor must be used inside <NetworkProvider>')
    return ctx
}

interface LoadedState {
    doc: NetworkDocument
    savedRevision: number
    savedAt: string
    journal: JournalState
}

/** What the server has acknowledged: the saved document plus every journal entry up to `journal.lastSeq`. */
interface Confirmed {
    doc: NetworkDocument
    savedRevision: number
    savedAt: string
    journal: JournalState
}

/** Tells the provider that a form of record `id` holds edits not applied yet, so a change by another editor is reported. */
export function useDraftGuard(id: string, dirty: boolean): void {
    const track = useContext(Ctx)?.trackDraft
    useEffect(() => (dirty && track ? track(id) : undefined), [id, dirty, track])
}

/** `site CTI`, `circuit TCC_…`: a record as the conflict dialog names it. */
function keyLabel(docs: NetworkDocument[], key: RecordKey): string {
    if (key === META_KEY) return 'the network name / description'
    const ref = parseRecordKey(key)
    if (!ref) return key
    for (const d of docs) {
        const r = findRecord(d, ref.collection, ref.id) as { name?: string; yardName?: string } | undefined
        if (r) return `${collectionLabel(ref.collection)} ${r.name ?? r.yardName ?? ref.id}`
    }
    return `${collectionLabel(ref.collection)} ${ref.id}`
}

const changeVerb = (c: RecordChange | undefined) => c === 'deleted' ? 'deleted' : c === 'added' ? 'added' : 'changed'

/** Retries of one batch the server refused because the journal moved on, before giving up. */
const MAX_APPEND_RETRIES = 5
/** While the event stream is down, pull this often. */
const FALLBACK_PULL_MS = 30_000

function inverseOps(doc: NetworkDocument, ops: NetworkOp[]): NetworkOp[] {
    // Compute inverses sequentially against the evolving document, then reverse.
    const inverses: NetworkOp[] = []
    let current = doc
    for (const op of ops) {
        switch (op.type) {
            case 'upsert': {
                const prev = findRecord(current, op.collection, op.record.id)
                inverses.push(prev ? {type: 'upsert', collection: op.collection, record: prev as AnyNetworkRecord} : {type: 'delete', collection: op.collection, id: op.record.id})
                break
            }
            case 'delete': {
                const prev = findRecord(current, op.collection, op.id)
                if (prev) inverses.push({type: 'upsert', collection: op.collection, record: prev as AnyNetworkRecord})
                break
            }
            case 'meta':
                inverses.push({type: 'meta', name: op.name !== undefined ? current.name : undefined, description: op.description !== undefined ? (current.description ?? '') : undefined})
                break
        }
        current = applyOps(current, [op])
    }
    return inverses.reverse()
}

export function NetworkProvider({networkId, children}: { networkId: string; children: ReactNode }) {
    const [state, setState] = useState<LoadedState | null>(null)
    const [loadError, setLoadError] = useState<string | undefined>()
    const [syncError, setSyncError] = useState<string | undefined>()
    const [busy, setBusy] = useState(false)
    const [selection, setSelection] = useState<Selection | null>(null)
    const [undoStack, setUndoStack] = useState<NetworkOp[][]>([])
    const [redoStack, setRedoStack] = useState<NetworkOp[][]>([])
    /** Lines of the "changed by another editor" dialog; null while closed. */
    const [notice, setNotice] = useState<string[] | null>(null)
    // Every exchange with the journal runs on this chain, one at a time: sends of this editor's batches and pulls of others'.
    const queue = useRef<Promise<unknown>>(Promise.resolve())
    const confirmed = useRef<Confirmed | null>(null)
    /** This editor's batches not acknowledged yet, oldest first; `state.doc` is `confirmed.doc` with them applied. */
    const pending = useRef<PendingBatch[]>([])
    const flushQueued = useRef(false)
    const pullQueued = useRef(false)
    const drafts = useRef(new Map<string, number>())
    const selectionRef = useRef<Selection | null>(null)
    selectionRef.current = selection
    const stateRef = useRef<LoadedState | null>(null)
    stateRef.current = state

    const pendingOps = () => pending.current.reduce((n, b) => n + b.ops.length, 0)

    /** Publishes the confirmed state with the unsent batches on top (`doc` when already computed). */
    const publish = useCallback((doc?: NetworkDocument) => {
        const c = confirmed.current
        if (!c) return
        const shown = doc ?? pending.current.reduce((d, b) => applyOps(d, b.ops), c.doc)
        const next: LoadedState = {doc: shown, savedRevision: c.savedRevision, savedAt: c.savedAt, journal: {...c.journal, entries: c.journal.entries + pendingOps()}}
        stateRef.current = next
        setState(next)
    }, [])

    const enqueue = useCallback((job: () => Promise<void>) => {
        queue.current = queue.current.then(job).catch(e => setSyncError((e as Error).message))
        return queue.current
    }, [])

    /**
     * Moves the confirmed state to `next` (other editors' changes), replays the unsent batches on top, and reports
     * dropped batches and changed records with open forms or a deleted selection.
     */
    const integrate = useCallback((next: Confirmed, refused: RebaseResult<PendingBatch>['dropped'] = []) => {
        const prev = confirmed.current
        const shownBefore = stateRef.current?.doc
        const changed = prev ? diffDocs(prev.doc, next.doc) : new Map<RecordKey, RecordChange>()
        confirmed.current = next
        const {doc, kept, dropped} = rebase(next.doc, pending.current, changed)
        pending.current = kept
        publish(doc)
        if (!changed.size && !refused.length) return
        setUndoStack(s => s.filter(b => !touchesAny(b, changed)))
        setRedoStack(s => s.filter(b => !touchesAny(b, changed)))
        const docs = [next.doc, ...(shownBefore ? [shownBefore] : [])]
        const lines: string[] = []
        for (const d of [...refused, ...dropped]) {
            const what = d.conflicts.length
                ? d.conflicts.slice(0, 4).map(k => `${keyLabel(docs, k)} (${changeVerb(changed.get(k))})`).join(', ') + (d.conflicts.length > 4 ? `, … ${d.conflicts.length - 4} more` : '')
                : undefined
            lines.push(what
                ? `Your change was not recorded: another editor changed the same data first — ${what}.`
                : `Your change was not recorded: it no longer applies after another editor's changes${d.error ? ` (${d.error})` : ''}.`)
        }
        const sel = selectionRef.current
        for (const [key, change] of changed) {
            const ref = parseRecordKey(key)
            if (!ref) continue
            const isSelected = !!sel && sel.collection === ref.collection && sel.id === ref.id
            if (change === 'deleted' && isSelected) {
                setSelection(null)
                lines.push(`${keyLabel(docs, key)} was deleted by another editor; its panel was closed.`)
            } else if (change !== 'added' && drafts.current.has(ref.id)) {
                lines.push(`${keyLabel(docs, key)} was ${changeVerb(change)} by another editor while you were editing it; the form now shows their version.`)
            }
        }
        if (lines.length) setNotice(n => [...(n ?? []), ...lines])
    }, [publish])

    /** Reloads the whole working document (after a save, discard or rollback elsewhere, or when entries are missing). */
    const resync = useCallback(async (refused: RebaseResult<PendingBatch>['dropped'] = []) => {
        const w = await api.networks.working(networkId)
        integrate({doc: w.document, savedRevision: w.savedRevision, savedAt: w.savedAt, journal: w.journal}, refused)
    }, [networkId, integrate])

    /** Fetches the journal entries other editors appended since the last one seen and integrates them. */
    const pullNow = useCallback(async () => {
        const c = confirmed.current
        if (!c) return
        const r = await api.networks.journalSince(networkId, c.journal.lastSeq)
        const restarted = r.savedRevision !== c.savedRevision || r.baseRevision !== r.savedRevision || r.lastSeq < c.journal.lastSeq
            || (c.journal.lastSeq > 0 && r.startedAt !== c.journal.startedAt)
        if (restarted || (r.entries.length > 0 && r.entries[0].seq !== c.journal.lastSeq + 1)) return resync()
        if (!r.entries.length) return
        let doc: NetworkDocument
        try {
            doc = applyOps(c.doc, r.entries.map(e => e.op))
        } catch {
            return resync()
        }
        integrate({...c, doc, journal: {...c.journal, startedAt: r.startedAt, lastSeq: r.lastSeq, entries: r.lastSeq}})
    }, [networkId, integrate, resync])

    /** Sends the unsent batches in order; a refusal because the journal moved on pulls first and retries. */
    const flushNow = useCallback(async () => {
        let retries = 0
        while (pending.current.length) {
            const batch = pending.current[0]
            const c = confirmed.current
            if (!c) return
            try {
                const r = await api.networks.append(networkId, batch.ops, c.journal.lastSeq)
                pending.current = pending.current.filter(b => b !== batch)
                let doc: NetworkDocument
                try {
                    doc = applyOps(c.doc, batch.ops)
                } catch {
                    await resync()
                    continue
                }
                confirmed.current = {...c, doc, journal: {...c.journal, lastSeq: r.lastSeq, startedAt: r.startedAt, entries: r.entries}}
                retries = 0
                setState(s => s ? {...s, journal: {...s.journal, lastSeq: r.lastSeq, startedAt: r.startedAt, entries: r.entries + pendingOps()}} : s)
            } catch (e) {
                if (e instanceof ApiError && e.status === 409 && ++retries <= MAX_APPEND_RETRIES) {
                    await pullNow()
                    continue
                }
                if (e instanceof ApiError && e.status === 422) {
                    // The server cannot apply it to the journal as it now stands: drop it, show the server's state.
                    pending.current = pending.current.filter(b => b !== batch)
                    await resync([{batch, conflicts: [], error: e.issues.map(i => i.message).join('; ') || e.message}])
                    continue
                }
                const msg = e instanceof ApiError && e.issues.length ? `${e.message}: ${e.issues.map(i => i.message).join('; ')}` : (e as Error).message
                setSyncError(`Could not record the change on the server (${msg}). Reload to resynchronise.`)
                return
            }
        }
    }, [networkId, pullNow, resync])

    const requestFlush = useCallback(() => {
        if (flushQueued.current) return
        flushQueued.current = true
        void enqueue(async () => {
            flushQueued.current = false
            await flushNow()
        })
    }, [enqueue, flushNow])

    const requestPull = useCallback(() => {
        if (pullQueued.current) return
        pullQueued.current = true
        void enqueue(async () => {
            pullQueued.current = false
            await pullNow()
            if (pending.current.length) await flushNow()
        })
    }, [enqueue, pullNow, flushNow])

    const reload = useCallback(async () => {
        setLoadError(undefined)
        setSyncError(undefined)
        try {
            const w = await api.networks.working(networkId)
            pending.current = []
            confirmed.current = {doc: w.document, savedRevision: w.savedRevision, savedAt: w.savedAt, journal: w.journal}
            publish(w.document)
            setUndoStack([])
            setRedoStack([])
        } catch (e) {
            setLoadError((e as Error).message)
        }
    }, [networkId, publish])

    useEffect(() => {
        setState(null)
        setSelection(null)
        void reload()
    }, [reload])

    // Other editors' changes: one event per change; (re)connecting catches up with whatever was missed meanwhile.
    const loaded = state !== null
    useEffect(() => {
        if (!loaded) return
        const events = api.networks.events(networkId)
        events.onmessage = m => {
            let e: NetworkChangeEvent
            try {
                e = JSON.parse(m.data as string) as NetworkChangeEvent
            } catch {
                return
            }
            if (e.client === CLIENT_ID) return
            if (e.type === 'deleted') setLoadError('This network was deleted by another editor.')
            else requestPull()
        }
        events.onopen = () => requestPull()
        const fallback = window.setInterval(() => {
            if (events.readyState !== EventSource.OPEN) requestPull()
        }, FALLBACK_PULL_MS)
        return () => {
            window.clearInterval(fallback)
            events.close()
        }
    }, [loaded, networkId, requestPull])

    const push = useCallback((ops: NetworkOp[]) => {
        const current = stateRef.current
        if (!current || !confirmed.current) return false
        let nextDoc: NetworkDocument
        try {
            nextDoc = applyOps(current.doc, ops)
        } catch (e) {
            setSyncError((e as Error).message)
            return false
        }
        pending.current = [...pending.current, {ops}]
        const next: LoadedState = {...current, doc: nextDoc, journal: {...current.journal, entries: current.journal.entries + ops.length}}
        stateRef.current = next
        setState(next)
        requestFlush()
        return true
    }, [requestFlush])

    const apply = useCallback((requested: NetworkOp[], opts: ApplyOptions = {}) => {
        const current = stateRef.current
        if (!current || requested.length === 0) return false
        // Lines left without circuits go in the same step; removing lines the user did not choose to remove asks first.
        let ops = requested
        try {
            const prune = emptyLinesOps(applyOps(current.doc, requested))
            if (prune.length) ops = [...requested, ...prune]
        } catch {
            // the ops do not apply: push() reports it
        }
        const confirmedLines = new Set(opts.confirmedLineIds ?? [])
        const removed = linesRemovedBy(current.doc, ops).filter(l => !confirmedLines.has(l.id))
        if (removed.length && !window.confirm(`${linesRemovedNote(removed).trim()}\n\nContinue?`)) return false
        const inverse = inverseOps(current.doc, ops)
        if (!push(ops)) return false
        setUndoStack(s => [...s.slice(-99), inverse])
        setRedoStack([])
        return true
    }, [push])

    const undo = useCallback(() => {
        const current = stateRef.current
        const batch = undoStack[undoStack.length - 1]
        if (!current || !batch) return
        const redo = inverseOps(current.doc, batch)
        if (!push(batch)) return
        setUndoStack(s => s.slice(0, -1))
        setRedoStack(s => [...s, redo])
    }, [undoStack, push])

    const redo = useCallback(() => {
        const current = stateRef.current
        const batch = redoStack[redoStack.length - 1]
        if (!current || !batch) return
        const undoBatch = inverseOps(current.doc, batch)
        if (!push(batch)) return
        setRedoStack(s => s.slice(0, -1))
        setUndoStack(s => [...s, undoBatch])
    }, [redoStack, push])

    const save = useCallback(async (force = false) => {
        setBusy(true)
        try {
            await queue.current.catch(() => undefined)
            const r = await api.networks.save(networkId, force)
            confirmed.current = {doc: r.document, savedRevision: r.document.revision, savedAt: r.document.updatedAt, journal: {baseRevision: r.document.revision, entries: 0, lastSeq: 0, stale: false}}
            publish()
            setUndoStack([])
            setRedoStack([])
            setSyncError(undefined)
            if (pending.current.length) requestFlush()
            return true
        } catch (e) {
            if (e instanceof ApiError && e.status === 422) {
                setSyncError(`Cannot save: ${e.issues.length} validation issue(s). Fix them or save with force.`)
                return false
            }
            setSyncError((e as Error).message)
            return false
        } finally {
            setBusy(false)
        }
    }, [networkId, publish, requestFlush])

    const discard = useCallback(async () => {
        setBusy(true)
        try {
            await queue.current.catch(() => undefined)
            await api.networks.discard(networkId)
            await reload()
        } catch (e) {
            setSyncError((e as Error).message)
        } finally {
            setBusy(false)
        }
    }, [networkId, reload])

    const trackDraft = useCallback((id: string) => {
        drafts.current.set(id, (drafts.current.get(id) ?? 0) + 1)
        return () => {
            const n = (drafts.current.get(id) ?? 1) - 1
            if (n > 0) drafts.current.set(id, n)
            else drafts.current.delete(id)
        }
    }, [])

    const exportJson = useCallback((working = true) => {
        const current = stateRef.current
        if (!current) return
        const doc = working ? current.doc : undefined
        if (doc) {
            const blob = new Blob([JSON.stringify(doc, null, 2) + '\n'], {type: 'application/json'})
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            a.download = `${doc.id}.thgrid-network.json`
            document.body.appendChild(a)
            a.click()
            a.remove()
            URL.revokeObjectURL(url)
        } else {
            window.open(`/api/networks/${networkId}/export?download=true`, '_blank')
        }
    }, [networkId])

    // validated again only when the document changes (not when the journal acknowledges a batch)
    const doc = state?.doc
    const issues = useMemo(() => doc ? validateNetworkDocument(doc) : [], [doc])

    const value = useMemo<NetworkEditor | null>(() => state ? {
        networkId,
        doc: state.doc,
        savedRevision: state.savedRevision,
        savedAt: state.savedAt,
        journal: state.journal,
        issues,
        syncError,
        busy,
        dirty: state.journal.entries > 0,
        canUndo: undoStack.length > 0,
        canRedo: redoStack.length > 0,
        selection,
        select: setSelection,
        apply,
        undo,
        redo,
        save,
        discard,
        reload,
        exportJson,
        trackDraft,
    } : null, [state, networkId, issues, syncError, busy, undoStack.length, redoStack.length, selection, apply, undo, redo, save, discard, reload, exportJson, trackDraft])

    if (loadError) {
        return (
            <div className="main">
                <div className="notice error">Could not load network "{networkId}": {loadError}</div>
                <button type="button" onClick={() => void reload()}>Retry</button>
            </div>
        )
    }
    if (!value) return <div className="empty">Loading network…</div>
    return (
        <Ctx.Provider value={value}>
            {children}
            {notice && (
                <div className="sync-notice-backdrop">
                    <div className="panel sync-notice" role="alertdialog" aria-labelledby="sync-notice-title">
                        <h3 id="sync-notice-title" style={{marginTop: 0}}>Changed by another editor</h3>
                        <ul>{notice.map((l, i) => <li key={i}>{l}</li>)}</ul>
                        <p className="muted small">The data shown has been refreshed with their changes.</p>
                        <div className="toolbar"><button type="button" className="primary small" autoFocus onClick={() => setNotice(null)}>OK</button></div>
                    </div>
                </div>
            )}
        </Ctx.Provider>
    )
}
