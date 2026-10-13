/**
 * Editing operations on a `NetworkDocument`.
 *
 * The UI never writes the document directly: every edit is an op that is
 * applied locally and appended to the server-side journal. On save the journal
 * is replayed onto the last saved version. Ops are small, replayable and
 * JSON-serialisable; `applyOps` is pure.
 */
import {
    AnyNetworkRecord,
    ConnectionJunctionKind,
    ConnectionRecord,
    ConnectionScope,
    NetworkCollectionName,
    networkCollectionNames,
    NetworkDocument,
    NetworkNodeKind,
    NetworkRecordOf,
    NETWORK_ID_PATTERN,
    sameNode,
} from "./records";

export type NetworkOp =
    | { type: 'upsert'; collection: NetworkCollectionName; record: AnyNetworkRecord }
    | { type: 'delete'; collection: NetworkCollectionName; id: string }
    | { type: 'meta'; name?: string; description?: string }

export interface JournalEntry {
    /** 1-based, strictly increasing per network journal. */
    seq: number
    at: string
    op: NetworkOp
}

export interface NetworkJournal {
    networkId: string
    /** Revision of the saved document the entries apply to. */
    baseRevision: number
    entries: JournalEntry[]
}

export class NetworkOpError extends Error {
    constructor(public readonly op: NetworkOp, message: string) {
        super(message)
        this.name = 'NetworkOpError'
    }
}

function cloneDoc(doc: NetworkDocument): NetworkDocument {
    const copy = {...doc}
    // a collection added after the document was loaded (an editor session across an upgrade) starts empty
    for (const c of networkCollectionNames) (copy as any)[c] = [...(doc[c] ?? [])]
    return copy
}

/** Applies one op to a shallow copy of the document. Throws `NetworkOpError` when the op cannot apply. */
export function applyOp(doc: NetworkDocument, op: NetworkOp): NetworkDocument {
    const next = cloneDoc(doc)
    switch (op.type) {
        case 'upsert': {
            if (!networkCollectionNames.includes(op.collection)) throw new NetworkOpError(op, `unknown collection ${op.collection}`)
            const list = next[op.collection] as AnyNetworkRecord[]
            const i = list.findIndex(r => r.id === op.record.id)
            if (i >= 0) list[i] = op.record
            else list.push(op.record)
            return next
        }
        case 'delete': {
            if (!networkCollectionNames.includes(op.collection)) throw new NetworkOpError(op, `unknown collection ${op.collection}`)
            const list = next[op.collection] as AnyNetworkRecord[]
            const i = list.findIndex(r => r.id === op.id)
            if (i < 0) throw new NetworkOpError(op, `${op.collection}/${op.id} does not exist`)
            list.splice(i, 1)
            return next
        }
        case 'meta': {
            if (op.name !== undefined) next.name = op.name
            if (op.description !== undefined) next.description = op.description || undefined
            return next
        }
        default:
            throw new NetworkOpError(op, `unknown op type ${(op as { type: string }).type}`)
    }
}

export function applyOps(doc: NetworkDocument, ops: NetworkOp[]): NetworkDocument {
    return ops.reduce(applyOp, doc)
}

export function findRecord<C extends NetworkCollectionName>(doc: NetworkDocument, collection: C, id: string): NetworkRecordOf<C> | undefined {
    return (doc[collection] as NetworkRecordOf<C>[]).find(r => r.id === id)
}

/**
 * Ops that delete a record together with everything that depends on it, in an
 * order that keeps every intermediate document consistent. Connections that
 * reference a deleted node lose that node; a node at a junction goes with its
 * last circuit end, other connections when fewer than two nodes are left. A
 * deleted circuit leaves its lines, and a line left without sections goes.
 */
export function cascadeDeleteOps(doc: NetworkDocument, collection: NetworkCollectionName, id: string): NetworkOp[] {
    const ops: NetworkOp[] = []
    const deleted = new Set<string>()
    const del = (c: NetworkCollectionName, rid: string) => {
        const key = `${c}:${rid}`
        if (deleted.has(key)) return
        deleted.add(key)
        ops.push({type: 'delete', collection: c, id: rid})
    }
    const clearPathEnds = (locationId: string) => {
        for (const p of doc.paths) {
            if (p.from?.id !== locationId && p.to?.id !== locationId) continue
            ops.push({type: 'upsert', collection: 'paths', record: {...p, from: p.from?.id === locationId ? undefined : p.from, to: p.to?.id === locationId ? undefined : p.to}})
        }
    }
    /** Lines ending at a deleted yard or junction lose that end (they keep their sections). */
    const clearLineEnds = (locationId: string) => {
        for (const l of doc.lines) {
            if (l.from?.id !== locationId && l.to?.id !== locationId) continue
            ops.push({type: 'upsert', collection: 'lines', record: {...l, from: l.from?.id === locationId ? undefined : l.from, to: l.to?.id === locationId ? undefined : l.to}})
        }
    }
    const removeNodes = (predicate: (n: ConnectionRecord['nodes'][number]) => boolean) => {
        for (const conn of doc.connections) {
            if (deleted.has(`connections:${conn.id}`)) continue
            const remaining = conn.nodes.filter(n => !predicate(n))
            if (remaining.length === conn.nodes.length) continue
            // A node at a line junction stays while any circuit end is in it (a circuit may end there); elsewhere a node needs two.
            const atJunction = conn.scope === ConnectionScope.TRANSMISSION && conn.junction.kind === ConnectionJunctionKind.TRANSMISSION_JUNCTION
            if (atJunction ? !remaining.some(n => n.kind === NetworkNodeKind.TRANSMISSION_CIRCUIT) : remaining.length < 2) del('connections', conn.id)
            else ops.push({type: 'upsert', collection: 'connections', record: {...conn, nodes: remaining}})
        }
        // a yard link keeps standing with fewer (even no) nodes: it still names the two yards it joins
        for (const yc of doc.yardConnections ?? []) {
            if (deleted.has(`yardConnections:${yc.id}`)) continue
            const remaining = yc.nodes.filter(n => !predicate(n))
            if (remaining.length !== yc.nodes.length) ops.push({type: 'upsert', collection: 'yardConnections', record: {...yc, nodes: remaining}})
        }
    }

    switch (collection) {
        case 'substationGroups':
            clearPathEnds(id)
            // its extensions stay, as sites of their own
            for (const g of doc.substationGroups.filter(g => g.extensionOf === id)) {
                const {extensionOf: _, ...rest} = g
                ops.push({type: 'upsert', collection: 'substationGroups', record: rest})
            }
            for (const u of (doc.generationUnits ?? []).filter(u => u.groupId === id)) del('generationUnits', u.id)
            for (const s of doc.substations.filter(s => s.groupId === id)) ops.push(...cascadeDeleteOps(doc, 'substations', s.id))
            for (const j of doc.junctions.filter(j => j.groupId === id)) ops.push(...cascadeDeleteOps(doc, 'junctions', j.id))
            break
        case 'substations':
            clearPathEnds(id)
            clearLineEnds(id)
            for (const c of doc.connections.filter(c => c.junction.id === id)) del('connections', c.id)
            for (const yc of (doc.yardConnections ?? []).filter(yc => yc.yardAId === id || yc.yardBId === id)) del('yardConnections', yc.id)
            for (const b of doc.buses.filter(b => b.substationId === id)) del('buses', b.id)
            for (const e of doc.equipments.filter(e => e.substationId === id)) del('equipments', e.id)
            for (const t of doc.takeOffs.filter(t => t.substationId === id)) del('takeOffs', t.id)
            for (const b of doc.bays.filter(b => b.substationId === id)) del('bays', b.id)
            break
        case 'buses':
            removeNodes(n => n.kind === NetworkNodeKind.SUBSTATION_BUS && n.id === id)
            break
        case 'bays':
            for (const e of doc.equipments.filter(e => e.bayId === id)) {
                removeNodes(n => n.kind === NetworkNodeKind.EQUIPMENT_TERMINAL && n.id === e.id)
                del('equipments', e.id)
            }
            // take-offs survive without a bay; just detach them
            for (const t of doc.takeOffs.filter(t => t.bayId === id)) ops.push({type: 'upsert', collection: 'takeOffs', record: {...t, bayId: undefined}})
            break
        case 'equipments':
            removeNodes(n => n.kind === NetworkNodeKind.EQUIPMENT_TERMINAL && n.id === id)
            break
        case 'takeOffs':
            removeNodes(n => n.kind === NetworkNodeKind.SUBSTATION_TAKE_OFF && n.id === id)
            // equipment on its branch goes back into the bay column
            for (const e of doc.equipments.filter(e => e.takeOffId === id)) ops.push({type: 'upsert', collection: 'equipments', record: {...e, takeOffId: undefined}})
            break
        case 'junctions':
            clearPathEnds(id)
            clearLineEnds(id)
            for (const c of doc.connections.filter(c => c.junction.id === id)) del('connections', c.id)
            break
        case 'paths':
            // the circuits stay, without a path (drawn as dashed lines between their attached ends)
            for (const c of doc.circuits.filter(c => c.pathId === id)) {
                const {pathId: _, ...rest} = c
                ops.push({type: 'upsert', collection: 'circuits', record: rest})
            }
            break
        case 'circuits':
            removeNodes(n => n.kind === NetworkNodeKind.TRANSMISSION_CIRCUIT && n.id === id)
            // a line keeps its other sections; a line left without any is removed
            for (const l of doc.lines.filter(l => l.circuitIds.includes(id))) {
                const circuitIds = l.circuitIds.filter(x => x !== id)
                if (circuitIds.length) ops.push({type: 'upsert', collection: 'lines', record: {...l, circuitIds}})
                else del('lines', l.id)
            }
            break
        case 'lines':
            // the circuits of a line are kept
            break
        case 'connections':
        case 'yardConnections':
        case 'generationUnits':
            break
    }
    del(collection, id)
    // Connections removed by removeNodes() may be upserted earlier in `ops` and deleted later; applying in order is still consistent.
    return dedupe(ops)
}

/** Keeps the last op per (collection,id) for upserts that are later deleted, preserving order otherwise. */
function dedupe(ops: NetworkOp[]): NetworkOp[] {
    const deletedKeys = new Set(ops.filter(o => o.type === 'delete').map(o => `${(o as { collection: string }).collection}:${(o as { id: string }).id}`))
    return ops.filter(o => !(o.type === 'upsert' && deletedKeys.has(`${o.collection}:${o.record.id}`)))
}

/** Connections that include the node. */
export function connectionsOfNode(doc: NetworkDocument, node: ConnectionRecord['nodes'][number]): ConnectionRecord[] {
    return doc.connections.filter(c => c.nodes.some(n => sameNode(n, node)))
}

/** Ops removing the lines that have no circuit sections: a line exists only while it has at least one circuit. */
export function emptyLinesOps(doc: NetworkDocument): NetworkOp[] {
    return doc.lines.filter(l => l.circuitIds.length === 0).map(l => ({type: 'delete', collection: 'lines', id: l.id}))
}

/** True when some record of any collection already uses the id. */
export function idInUse(doc: NetworkDocument, id: string): boolean {
    for (const c of networkCollectionNames) if (((doc[c] ?? []) as AnyNetworkRecord[]).some(r => r.id === id)) return true
    return false
}

/** Reason an id chosen for a new record cannot be used, or undefined when it is fine. */
export function checkCreateId(doc: NetworkDocument, id: string): string | undefined {
    if (!NETWORK_ID_PATTERN.test(id)) return `id must match ${NETWORK_ID_PATTERN.source}`
    if (idInUse(doc, id)) return `id "${id}" is already used in this network`
    return undefined
}

/** The user's id when given and valid, otherwise a generated one. */
export function pickId(doc: NetworkDocument, custom: string | undefined, prefix: string): string {
    const c = custom?.trim()
    return c && !checkCreateId(doc, c) ? c : uniqueId(doc, prefix)
}

/** Reason a new id cannot be used, or undefined when it is fine. */
export function checkNewId(doc: NetworkDocument, oldId: string, newId: string): string | undefined {
    if (newId === oldId) return 'unchanged'
    if (!NETWORK_ID_PATTERN.test(newId)) return `id must match ${NETWORK_ID_PATTERN.source}`
    if (idInUse(doc, newId)) return `id "${newId}" is already used in this network`
    return undefined
}

/**
 * Ops that change a record's id and rewrite every reference to it
 * (parent ids, path / line ids, path ends, connection junctions and nodes).
 * The record is re-inserted under the new id and the old one deleted.
 */
export function renameRecordOps(doc: NetworkDocument, collection: NetworkCollectionName, oldId: string, newId: string): NetworkOp[] {
    const record = findRecord(doc, collection, oldId)
    if (!record) throw new Error(`${collection}/${oldId} does not exist`)
    const reason = checkNewId(doc, oldId, newId)
    if (reason) throw new Error(reason)
    const ops: NetworkOp[] = [{type: 'upsert', collection, record: {...record, id: newId} as AnyNetworkRecord}]
    const swap = (v?: string) => (v === oldId ? newId : v)
    const swapRef = <T extends { id: string } | undefined>(r: T): T => (r && r.id === oldId ? {...r, id: newId} : r)
    const up = (c: NetworkCollectionName, r: AnyNetworkRecord) => ops.push({type: 'upsert', collection: c, record: r})

    switch (collection) {
        case 'substationGroups':
            for (const s of doc.substations) if (s.groupId === oldId) up('substations', {...s, groupId: newId})
            for (const u of doc.generationUnits ?? []) if (u.groupId === oldId) up('generationUnits', {...u, groupId: newId})
            for (const j of doc.junctions) if (j.groupId === oldId) up('junctions', {...j, groupId: newId})
            for (const p of doc.paths) if (p.from?.id === oldId || p.to?.id === oldId) up('paths', {...p, from: swapRef(p.from), to: swapRef(p.to)})
            for (const g of doc.substationGroups) if (g.extensionOf === oldId && g.id !== oldId) up('substationGroups', {...g, extensionOf: newId})
            break
        case 'substations':
            for (const b of doc.buses) if (b.substationId === oldId) up('buses', {...b, substationId: newId})
            for (const b of doc.bays) if (b.substationId === oldId) up('bays', {...b, substationId: newId})
            for (const e of doc.equipments) if (e.substationId === oldId) up('equipments', {...e, substationId: newId})
            for (const t of doc.takeOffs) if (t.substationId === oldId) up('takeOffs', {...t, substationId: newId})
            for (const p of doc.paths) if (p.from?.id === oldId || p.to?.id === oldId) up('paths', {...p, from: swapRef(p.from), to: swapRef(p.to)})
            for (const l of doc.lines) if (l.from?.id === oldId || l.to?.id === oldId) up('lines', {...l, from: swapRef(l.from), to: swapRef(l.to)})
            for (const c of doc.connections) if (c.junction.id === oldId) up('connections', {...c, junction: {...c.junction, id: newId}})
            for (const yc of doc.yardConnections ?? []) if (yc.yardAId === oldId || yc.yardBId === oldId) up('yardConnections', {...yc, yardAId: yc.yardAId === oldId ? newId : yc.yardAId, yardBId: yc.yardBId === oldId ? newId : yc.yardBId})
            break
        case 'bays':
            for (const e of doc.equipments) if (e.bayId === oldId) up('equipments', {...e, bayId: newId})
            for (const t of doc.takeOffs) if (t.bayId === oldId) up('takeOffs', {...t, bayId: newId})
            break
        case 'buses':
        case 'equipments':
        case 'takeOffs':
        case 'circuits': {
            const kind = collection === 'buses' ? NetworkNodeKind.SUBSTATION_BUS : collection === 'equipments' ? NetworkNodeKind.EQUIPMENT_TERMINAL
                : collection === 'takeOffs' ? NetworkNodeKind.SUBSTATION_TAKE_OFF : NetworkNodeKind.TRANSMISSION_CIRCUIT
            for (const c of doc.connections) {
                if (!c.nodes.some(n => n.kind === kind && n.id === oldId)) continue
                up('connections', {...c, nodes: c.nodes.map(n => n.kind === kind && n.id === oldId ? {...n, id: newId} : n)})
            }
            if (collection === 'circuits') for (const l of doc.lines) if (l.circuitIds.includes(oldId)) up('lines', {...l, circuitIds: l.circuitIds.map(x => x === oldId ? newId : x)})
            if (collection === 'takeOffs') for (const e of doc.equipments) if (e.takeOffId === oldId) up('equipments', {...e, takeOffId: newId})
            for (const yc of doc.yardConnections ?? []) {
                if (!yc.nodes.some(n => n.kind === kind && n.id === oldId)) continue
                up('yardConnections', {...yc, nodes: yc.nodes.map(n => n.kind === kind && n.id === oldId ? {...n, id: newId} : n)})
            }
            break
        }
        case 'junctions':
            for (const p of doc.paths) if (p.from?.id === oldId || p.to?.id === oldId) up('paths', {...p, from: swapRef(p.from), to: swapRef(p.to)})
            for (const l of doc.lines) if (l.from?.id === oldId || l.to?.id === oldId) up('lines', {...l, from: swapRef(l.from), to: swapRef(l.to)})
            for (const c of doc.connections) if (c.junction.id === oldId) up('connections', {...c, junction: {...c.junction, id: newId}})
            break
        case 'paths':
            for (const c of doc.circuits) if (c.pathId === oldId) up('circuits', {...c, pathId: newId})
            break
        case 'lines':
        case 'connections':
        case 'yardConnections':
        case 'generationUnits':
            break
    }
    ops.push({type: 'delete', collection, id: oldId})
    return ops
}

/** Generates an id unique within the document: `<prefix>` or `<prefix>_<n>`. */
export function uniqueId(doc: NetworkDocument, prefix: string): string {
    const used = new Set<string>()
    for (const c of networkCollectionNames) for (const r of doc[c] ?? []) used.add(r.id)
    const base = prefix.replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^[_.-]+/, '') || 'item'
    if (!used.has(base)) return base
    for (let n = 2; ; n++) {
        const candidate = `${base}_${n}`
        if (!used.has(candidate)) return candidate
    }
}
