/**
 * Pure helpers behind live editing by several editors (`NetworkContext`): which records a batch of ops touches, which
 * records changed between two versions of the document, and replaying this editor's unsent batches onto a document
 * other editors changed. A batch that touches a record someone else changed (or deleted) is dropped, not merged: the
 * user is told and sees the other editor's version.
 */
import {AnyNetworkRecord, NetworkCollectionName, networkCollectionNames, NetworkDocument} from '@shared/network/records'
import {applyOps, NetworkOp} from '@shared/network/ops'

/** `<collection>:<id>`, or `meta` for the document's name and description. */
export type RecordKey = string

export const recordKey = (collection: NetworkCollectionName, id: string): RecordKey => `${collection}:${id}`
export const META_KEY: RecordKey = 'meta'

export function parseRecordKey(key: RecordKey): { collection: NetworkCollectionName; id: string } | undefined {
    const i = key.indexOf(':')
    return i > 0 ? {collection: key.slice(0, i) as NetworkCollectionName, id: key.slice(i + 1)} : undefined
}

/** The records a batch of ops writes or deletes. */
export function touchedKeys(ops: NetworkOp[]): Set<RecordKey> {
    const keys = new Set<RecordKey>()
    for (const op of ops) {
        if (op.type === 'upsert') keys.add(recordKey(op.collection, op.record.id))
        else if (op.type === 'delete') keys.add(recordKey(op.collection, op.id))
        else keys.add(META_KEY)
    }
    return keys
}

export type RecordChange = 'added' | 'changed' | 'deleted'

/** Records that differ between two versions of a document (`meta` when the name or description differ). */
export function diffDocs(before: NetworkDocument, after: NetworkDocument): Map<RecordKey, RecordChange> {
    const changes = new Map<RecordKey, RecordChange>()
    if (before.name !== after.name || (before.description ?? '') !== (after.description ?? '')) changes.set(META_KEY, 'changed')
    for (const c of networkCollectionNames) {
        const a = (before[c] ?? []) as AnyNetworkRecord[], b = (after[c] ?? []) as AnyNetworkRecord[]
        if (a === b) continue
        const old = new Map(a.map(r => [r.id, r]))
        for (const r of b) {
            const prev = old.get(r.id)
            if (!prev) changes.set(recordKey(c, r.id), 'added')
            else if (prev !== r && JSON.stringify(prev) !== JSON.stringify(r)) changes.set(recordKey(c, r.id), 'changed')
            old.delete(r.id)
        }
        for (const id of old.keys()) changes.set(recordKey(c, id), 'deleted')
    }
    return changes
}

/** One `apply()` of this editor, not yet acknowledged by the server. */
export interface PendingBatch {
    ops: NetworkOp[]
}

export interface RebaseResult<B extends PendingBatch> {
    /** The confirmed document with the kept batches applied: what the editor shows. */
    doc: NetworkDocument
    kept: B[]
    /** Batches that touch a record changed by someone else, or no longer apply; with the records in conflict. */
    dropped: { batch: B; conflicts: RecordKey[]; error?: string }[]
}

/** Replays unsent batches onto `confirmed`, dropping each one that touches a record in `changed` or fails to apply. */
export function rebase<B extends PendingBatch>(confirmed: NetworkDocument, pending: B[], changed: ReadonlyMap<RecordKey, RecordChange>): RebaseResult<B> {
    let doc = confirmed
    const kept: B[] = [], dropped: RebaseResult<B>['dropped'] = []
    for (const batch of pending) {
        const conflicts = [...touchedKeys(batch.ops)].filter(k => changed.has(k))
        if (conflicts.length) {
            dropped.push({batch, conflicts})
            continue
        }
        try {
            doc = applyOps(doc, batch.ops)
            kept.push(batch)
        } catch (e) {
            dropped.push({batch, conflicts: [], error: (e as Error).message})
        }
    }
    return {doc, kept, dropped}
}

/** Whether a batch (an undo / redo step) touches any of the changed records. */
export const touchesAny = (ops: NetworkOp[], changed: ReadonlyMap<RecordKey, RecordChange>): boolean => [...touchedKeys(ops)].some(k => changed.has(k))
