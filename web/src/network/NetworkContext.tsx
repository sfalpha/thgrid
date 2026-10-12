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
 */
import {createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState} from 'react'
import type {NetworkCollectionName, NetworkDocument, AnyNetworkRecord} from '@shared/network/records'
import {applyOps, emptyLinesOps, findRecord, NetworkOp} from '@shared/network/ops'
import {validateNetworkDocument} from '@shared/network/validation'
import type {ValidationIssue} from '@shared/templates/validation'
import {api, ApiError, JournalState} from '../api/client'
import {linesRemovedBy, linesRemovedNote} from './deleteLines'

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
    // Serialises journal appends and tracks the server-side last seq.
    const queue = useRef<Promise<unknown>>(Promise.resolve())
    const lastSeq = useRef(0)
    const stateRef = useRef<LoadedState | null>(null)
    stateRef.current = state

    const reload = useCallback(async () => {
        setLoadError(undefined)
        setSyncError(undefined)
        try {
            const w = await api.networks.working(networkId)
            lastSeq.current = w.journal.lastSeq
            setState({doc: w.document, savedRevision: w.savedRevision, savedAt: w.savedAt, journal: w.journal})
            setUndoStack([])
            setRedoStack([])
        } catch (e) {
            setLoadError((e as Error).message)
        }
    }, [networkId])

    useEffect(() => {
        setState(null)
        setSelection(null)
        void reload()
    }, [reload])

    const push = useCallback((ops: NetworkOp[]) => {
        const current = stateRef.current
        if (!current) return false
        let nextDoc: NetworkDocument
        try {
            nextDoc = applyOps(current.doc, ops)
        } catch (e) {
            setSyncError((e as Error).message)
            return false
        }
        const next: LoadedState = {...current, doc: nextDoc, journal: {...current.journal, entries: current.journal.entries + ops.length}}
        stateRef.current = next
        setState(next)
        const expected = lastSeq.current
        lastSeq.current += ops.length
        queue.current = queue.current
            .then(() => api.networks.append(networkId, ops, expected))
            .then(r => {
                lastSeq.current = r.lastSeq
                setState(s => s ? {...s, journal: {...s.journal, lastSeq: r.lastSeq, entries: r.entries}} : s)
            })
            .catch(e => {
                const msg = e instanceof ApiError && e.issues.length ? `${e.message}: ${e.issues.map(i => i.message).join('; ')}` : (e as Error).message
                setSyncError(`Could not record the change on the server (${msg}). Reload to resynchronise.`)
            })
        return true
    }, [networkId])

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
        const confirmed = new Set(opts.confirmedLineIds ?? [])
        const removed = linesRemovedBy(current.doc, ops).filter(l => !confirmed.has(l.id))
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
            lastSeq.current = 0
            setState({doc: r.document, savedRevision: r.document.revision, savedAt: r.document.updatedAt, journal: {baseRevision: r.document.revision, entries: 0, lastSeq: 0, stale: false}})
            setUndoStack([])
            setRedoStack([])
            setSyncError(undefined)
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
    }, [networkId])

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

    const issues = useMemo(() => state ? validateNetworkDocument(state.doc) : [], [state])

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
    } : null, [state, networkId, issues, syncError, busy, undoStack.length, redoStack.length, selection, apply, undo, redo, save, discard, reload, exportJson])

    if (loadError) {
        return (
            <div className="main">
                <div className="notice error">Could not load network "{networkId}": {loadError}</div>
                <button type="button" onClick={() => void reload()}>Retry</button>
            </div>
        )
    }
    if (!value) return <div className="empty">Loading network…</div>
    return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
