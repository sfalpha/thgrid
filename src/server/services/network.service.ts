import {
    NETWORK_DOCUMENT_FORMAT,
    NETWORK_DOCUMENT_VERSION,
    NetworkDocument,
    NetworkSummary,
    newNetworkDocument,
    toNetworkSummary,
} from "../../network/records";
import {applyOps, JournalEntry, NetworkJournal, NetworkOp, NetworkOpError} from "../../network/ops";
import {validateNetworkDocument, validateNetworkOps} from "../../network/validation";
import {migrateNetworkDocument} from "../../network/migrate";
import {slugifyTemplateId} from "../../templates/template";
import {validateTemplateId, ValidationIssue} from "../../templates/validation";
import {NetworkStore, NetworkVersionInfo} from "../storage/network.store";
import {BadRequestError, ConflictError, NotFoundError, ValidationError} from "../errors";

export interface CreateNetworkInput {
    id?: string
    name: string
    description?: string
}

export interface JournalState {
    baseRevision: number
    entries: number
    lastSeq: number
    /** True when the journal was recorded against another revision than the current saved document. */
    stale: boolean
    /** Set when replaying the journal failed; the working document then equals the saved one. */
    error?: string
}

export interface WorkingState {
    /** Saved document with the journal applied. */
    document: NetworkDocument
    savedRevision: number
    savedAt: string
    journal: JournalState
    /** Issues of the working document (what would block a save). */
    issues: ValidationIssue[]
}

export interface AppendResult {
    lastSeq: number
    appended: JournalEntry[]
    entries: number
}

export interface SaveResult {
    document: NetworkDocument
    archivedVersion?: string
    appliedEntries: number
}

export class NetworkService {
    /** Per-network promise chain so journal appends and saves never interleave. */
    private readonly locks = new Map<string, Promise<unknown>>()

    constructor(private readonly store: NetworkStore) {
    }

    private locked<T>(id: string, fn: () => Promise<T>): Promise<T> {
        const prev = this.locks.get(id) ?? Promise.resolve()
        const next = prev.catch(() => undefined).then(fn)
        this.locks.set(id, next)
        next.finally(() => {
            if (this.locks.get(id) === next) this.locks.delete(id)
        }).catch(() => undefined)
        return next
    }

    async list(): Promise<NetworkSummary[]> {
        const docs = await this.store.list()
        // files written before a collection existed are migrated on read, here too, so their counts are complete
        const summaries = await Promise.all(docs.map(async d => toNetworkSummary(migrateNetworkDocument(d).doc, (await this.store.getJournal(d.id))?.entries.length ?? 0)))
        return summaries.sort((a, b) => a.name.localeCompare(b.name))
    }

    async get(id: string): Promise<NetworkDocument> {
        const doc = await this.store.get(id)
        if (!doc) throw new NotFoundError(`Network ${id}`)
        return migrateNetworkDocument(doc).doc
    }

    async create(input: unknown): Promise<NetworkDocument> {
        const body = input as Partial<CreateNetworkInput> | undefined
        if (!body || typeof body !== 'object') throw new BadRequestError('body must be an object')
        if (typeof body.name !== 'string' || !body.name.trim()) throw new ValidationError([{path: 'name', message: 'name is required'}])
        if (body.description !== undefined && typeof body.description !== 'string') throw new ValidationError([{path: 'description', message: 'description must be a string'}])
        const id = body.id ?? slugifyTemplateId(body.name)
        const idIssues = validateTemplateId(id)
        if (idIssues.length) throw new ValidationError(idIssues, 'Could not derive a valid id from the name; supply "id" explicitly')
        return this.locked(id, async () => {
            if (await this.store.exists(id)) throw new ConflictError(`Network ${id} already exists`)
            const doc = newNetworkDocument(id, body.name!.trim())
            if (body.description) doc.description = body.description
            await this.store.save(doc)
            return doc
        })
    }

    async delete(id: string): Promise<{ archivedVersion?: string }> {
        await this.get(id)
        return this.locked(id, async () => ({archivedVersion: await this.store.delete(id)}))
    }

    /* ---------- journal ---------- */

    async journal(id: string): Promise<NetworkJournal> {
        await this.get(id)
        return (await this.store.getJournal(id)) ?? {networkId: id, baseRevision: (await this.get(id)).revision, entries: []}
    }

    private replay(doc: NetworkDocument, journal: NetworkJournal | undefined): { working: NetworkDocument; state: JournalState } {
        if (!journal || journal.entries.length === 0) {
            return {working: doc, state: {baseRevision: doc.revision, entries: 0, lastSeq: journal?.entries.at(-1)?.seq ?? 0, stale: false}}
        }
        const stale = journal.baseRevision !== doc.revision
        const base: JournalState = {baseRevision: journal.baseRevision, entries: journal.entries.length, lastSeq: journal.entries[journal.entries.length - 1].seq, stale}
        try {
            return {working: migrateNetworkDocument(applyOps(doc, journal.entries.map(e => e.op))).doc, state: base}
        } catch (e) {
            return {working: doc, state: {...base, error: (e as Error).message}}
        }
    }

    async working(id: string): Promise<WorkingState> {
        const doc = await this.get(id)
        const journal = await this.store.getJournal(id)
        const {working, state} = this.replay(doc, journal)
        return {document: working, savedRevision: doc.revision, savedAt: doc.updatedAt, journal: state, issues: validateNetworkDocument(working)}
    }

    /**
     * Appends ops to the journal. Each op must apply cleanly to the current
     * working document (otherwise nothing is appended). `expectedLastSeq`
     * detects a second editor: when given and different from the journal's
     * last seq the call fails with 409.
     */
    async appendOps(id: string, input: unknown): Promise<AppendResult> {
        const body = (input ?? {}) as { ops?: unknown; expectedLastSeq?: unknown }
        const issues = validateNetworkOps(body.ops)
        if (issues.length) throw new ValidationError(issues)
        const ops = body.ops as NetworkOp[]
        return this.locked(id, async () => {
            const doc = await this.get(id)
            const journal = (await this.store.getJournal(id)) ?? {networkId: id, baseRevision: doc.revision, entries: []}
            const lastSeq = journal.entries.length ? journal.entries[journal.entries.length - 1].seq : 0
            if (body.expectedLastSeq !== undefined && body.expectedLastSeq !== lastSeq) {
                throw new ConflictError(`Journal has moved on (expected last seq ${String(body.expectedLastSeq)}, actual ${lastSeq}); reload the network`, {lastSeq})
            }
            if (journal.baseRevision !== doc.revision) {
                throw new ConflictError(`Journal was recorded against revision ${journal.baseRevision} but the saved document is revision ${doc.revision}; discard the journal or reload`, {lastSeq})
            }
            const {working, state} = this.replay(doc, journal)
            if (state.error) throw new ConflictError(`Existing journal cannot be replayed: ${state.error}`)
            try {
                applyOps(working, ops)
            } catch (e) {
                if (e instanceof NetworkOpError) throw new ValidationError([{path: 'ops', message: e.message}], 'Operation cannot be applied')
                throw e
            }
            const now = new Date().toISOString()
            const appended: JournalEntry[] = ops.map((op, i) => ({seq: lastSeq + i + 1, at: now, op}))
            journal.entries.push(...appended)
            await this.store.putJournal(journal)
            return {lastSeq: lastSeq + ops.length, appended, entries: journal.entries.length}
        })
    }

    async discard(id: string): Promise<{ discarded: number }> {
        await this.get(id)
        return this.locked(id, async () => {
            const journal = await this.store.getJournal(id)
            await this.store.deleteJournal(id)
            return {discarded: journal?.entries.length ?? 0}
        })
    }

    /** Replays the journal onto the saved document, validates, archives the old version and writes the new one. */
    async save(id: string, opts: { force?: boolean } = {}): Promise<SaveResult> {
        await this.get(id)
        return this.locked(id, async () => {
            const doc = await this.get(id)
            const journal = await this.store.getJournal(id)
            const {working, state} = this.replay(doc, journal)
            if (state.error) throw new ConflictError(`Journal cannot be replayed: ${state.error}`)
            if (state.stale) throw new ConflictError(`Journal was recorded against revision ${state.baseRevision} but the saved document is revision ${doc.revision}`)
            const issues = validateNetworkDocument(working)
            // Warnings (severity "warning") never block a save; errors do unless forced.
            if (issues.some(i => i.severity !== 'warning') && !opts.force) throw new ValidationError(issues, 'Network has validation issues; fix them or save with ?force=true')
            const next: NetworkDocument = {...working, revision: doc.revision + 1, updatedAt: new Date().toISOString()}
            const archivedVersion = await this.store.save(next)
            await this.store.deleteJournal(id)
            return {document: next, archivedVersion, appliedEntries: state.entries}
        })
    }

    /* ---------- versions ---------- */

    async versions(id: string): Promise<NetworkVersionInfo[]> {
        await this.get(id)
        return this.store.listVersions(id)
    }

    async version(id: string, stamp: string): Promise<NetworkDocument> {
        await this.get(id)
        let doc: NetworkDocument | undefined
        try {
            doc = await this.store.getVersion(id, stamp)
        } catch (e) {
            if ((e as Error).message.startsWith('Unsafe')) throw new BadRequestError('Invalid version stamp')
            throw e
        }
        if (!doc) throw new NotFoundError(`Version ${stamp} of network ${id}`)
        return migrateNetworkDocument(doc).doc
    }

    /** Makes an archived version the current document (the replaced current document is archived first). Discards the journal. */
    async rollback(id: string, stamp: string): Promise<SaveResult> {
        const version = await this.version(id, stamp)
        return this.locked(id, async () => {
            const current = await this.get(id)
            const restored: NetworkDocument = {...version, id, revision: current.revision + 1, updatedAt: new Date().toISOString()}
            const archivedVersion = await this.store.save(restored)
            const journal = await this.store.getJournal(id)
            await this.store.deleteJournal(id)
            return {document: restored, archivedVersion, appliedEntries: journal?.entries.length ?? 0}
        })
    }

    /** Removes archived versions, keeping only the newest `keep` (0 = purge the whole history). The current document and journal are untouched. */
    async purgeVersions(id: string, keep = 0): Promise<{ deleted: number; kept: number; stamps: string[] }> {
        if (!Number.isInteger(keep) || keep < 0) throw new BadRequestError('keep must be a whole number of versions (0 = purge all)')
        await this.get(id)
        return this.locked(id, async () => {
            const stamps = await this.store.purgeVersions(id, keep)
            const kept = (await this.store.listVersions(id)).length
            return {deleted: stamps.length, kept, stamps}
        })
    }

    /* ---------- import / export ---------- */

    async export(id: string, opts: { working?: boolean } = {}): Promise<NetworkDocument> {
        return opts.working ? (await this.working(id)).document : this.get(id)
    }

    /**
     * Stores an uploaded document as a network. The id comes from `opts.id`,
     * then the document, then the name. Existing networks are only replaced
     * with `overwrite` (the old version is archived) and their journal is discarded.
     */
    async import(input: unknown, opts: { overwrite?: boolean; id?: string } = {}): Promise<{ document: NetworkDocument; archivedVersion?: string; replaced: boolean }> {
        const body = input as Partial<NetworkDocument> | undefined
        if (!body || typeof body !== 'object') throw new BadRequestError('body must be a network document')
        if (body.format !== NETWORK_DOCUMENT_FORMAT || body.version !== NETWORK_DOCUMENT_VERSION) {
            throw new BadRequestError(`body must be a ${NETWORK_DOCUMENT_FORMAT} version ${NETWORK_DOCUMENT_VERSION} document`)
        }
        const id = opts.id ?? body.id ?? (typeof body.name === 'string' ? slugifyTemplateId(body.name) : '')
        const idIssues = validateTemplateId(id)
        if (idIssues.length) throw new ValidationError(idIssues, 'Invalid network id')
        const candidate = migrateNetworkDocument({...body, id} as NetworkDocument).doc
        const issues = validateNetworkDocument(candidate)
        if (issues.length) throw new ValidationError(issues, 'Imported document is invalid')
        return this.locked(id, async () => {
            const existing = await this.store.get(id)
            if (existing && !opts.overwrite) throw new ConflictError(`Network ${id} already exists; pass ?overwrite=true to replace it`)
            const now = new Date().toISOString()
            const doc: NetworkDocument = {
                ...candidate,
                revision: existing ? existing.revision + 1 : (Number.isInteger(candidate.revision) ? candidate.revision : 0),
                createdAt: existing?.createdAt ?? candidate.createdAt ?? now,
                updatedAt: now,
            }
            const archivedVersion = await this.store.save(doc)
            await this.store.deleteJournal(id)
            return {document: doc, archivedVersion, replaced: !!existing}
        })
    }

    validate(doc: unknown): ValidationIssue[] {
        const migrated = doc && typeof doc === 'object' && Array.isArray((doc as NetworkDocument).connections) ? migrateNetworkDocument(doc as NetworkDocument).doc : doc
        return validateNetworkDocument(migrated)
    }
}
