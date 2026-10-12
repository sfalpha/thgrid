/**
 * Ops for attaching / detaching circuit ends and path ends. Shared by the map
 * panels and the circuit wizard so every place follows the same rules:
 *  - at a substation a circuit end joins the TRANSMISSION connection of a take-off,
 *  - at a junction it joins the single existing node there or starts a new, named one,
 *  - detaching a path end detaches the matching end of every circuit on the path.
 */
import {
    CIRCUIT_END_FROM,
    CIRCUIT_END_TO,
    CircuitEnd,
    ConnectionJunctionKind,
    ConnectionJunctionRef,
    ConnectionRecord,
    ConnectionScope,
    NetworkDocument,
    NetworkNodeKind,
    NetworkNodeRef,
    TransmissionCircuitRecord,
    TransmissionLineRecord,
    TransmissionPathRecord,
} from '@shared/network/records'
import {applyOps, NetworkOp, pickId} from '@shared/network/ops'
import {atPathEnd} from '@shared/network/refs'
import {circuitEndConnection, connectionVoltage} from '@shared/network/migrate'
import {junctionConnectionNaming, takeOffConnectionNaming} from '@shared/network/naming'
import {TransmissionVoltage} from '@shared/models/transmission.voltage'

export {circuitEndConnection, connectionVoltage}

const circuitNode = (circuitId: string, end: CircuitEnd): NetworkNodeRef => ({kind: NetworkNodeKind.TRANSMISSION_CIRCUIT, id: circuitId, terminal: end})

/**
 * Op that sets the circuit's energized voltage to the voltage of the
 * connection it has just joined (`conn` as it will be after the attach).
 * Nothing when the circuit is unknown here, the voltage is unknown, or it
 * already matches.
 */
export function energizeCircuitOps(doc: NetworkDocument, circuitId: string, conn: ConnectionRecord): NetworkOp[] {
    const circuit = doc.circuits.find(c => c.id === circuitId)
    const v = connectionVoltage(doc, conn)
    // a de-energized circuit (0 V) stays de-energized wherever its ends are attached
    if (!circuit || !v || circuit.energizedVoltage === v || circuit.energizedVoltage === TransmissionVoltage.DE_ENERGIZED) return []
    return [{type: 'upsert', collection: 'circuits', record: {...circuit, energizedVoltage: v}}]
}

/** Where this circuit end is connected (yard or junction), if anywhere. */
export function circuitEndRef(doc: NetworkDocument, circuitId: string, end: CircuitEnd): ConnectionJunctionRef | undefined {
    return circuitEndConnection(doc, circuitId, end)?.junction
}

export function sameRef(a?: ConnectionJunctionRef, b?: ConnectionJunctionRef): boolean {
    return !!a && !!b && a.kind === b.kind && a.id === b.id
}

/** Human readable name of a site, yard or junction reference. */
export function refLabel(doc: NetworkDocument, ref?: ConnectionJunctionRef): string {
    if (!ref) return '–'
    if (ref.kind === ConnectionJunctionKind.SUBSTATION_GROUP) {
        const group = doc.substationGroups.find(g => g.id === ref.id)
        return group ? group.groupName : ref.id
    }
    if (ref.kind === ConnectionJunctionKind.SUBSTATION) {
        const yard = doc.substations.find(s => s.id === ref.id)
        const group = yard && doc.substationGroups.find(g => g.id === yard.groupId)
        return yard ? `${group?.groupName ?? ''} ${yard.yardName}`.trim() : ref.id
    }
    const j = doc.junctions.find(x => x.id === ref.id)
    return j ? `Junction ${j.name ?? j.id}` : ref.id
}

/** Removes the circuit end from its connection; the connection is deleted when nothing else is left (a lone take-off counts as nothing). */
export function detachCircuitEndOps(doc: NetworkDocument, circuitId: string, end: CircuitEnd): NetworkOp[] {
    const conn = circuitEndConnection(doc, circuitId, end)
    if (!conn) return []
    const nodes = conn.nodes.filter(n => !(n.kind === NetworkNodeKind.TRANSMISSION_CIRCUIT && n.id === circuitId && n.terminal === end))
    const onlyTakeOff = nodes.length === 1 && nodes[0].kind === NetworkNodeKind.SUBSTATION_TAKE_OFF
    if (nodes.length === 0 || onlyTakeOff) return [{type: 'delete', collection: 'connections', id: conn.id}]
    return [{type: 'upsert', collection: 'connections', record: {...conn, nodes}}]
}

/** The take-off's TRANSMISSION connection, if the take-off is already connected. */
export function takeOffConnection(doc: NetworkDocument, takeOffId: string) {
    return doc.connections.find(c => c.scope === ConnectionScope.TRANSMISSION && c.nodes.some(n => n.kind === NetworkNodeKind.SUBSTATION_TAKE_OFF && n.id === takeOffId))
}

/** Electrical nodes (TRANSMISSION connections) at a junction. */
export function connectionsAtJunction(doc: NetworkDocument, junctionId: string) {
    return doc.connections.filter(c => c.junction.kind === ConnectionJunctionKind.TRANSMISSION_JUNCTION && c.junction.id === junctionId)
}

export interface NewConnectionOptions {
    /** Id of the new connection; generated when empty or invalid. */
    newId?: string
    /** Name of the new connection at a junction; `<junction>_<n>` when empty. */
    newName?: string
}

/**
 * Joins the circuit end to the take-off's connection (created, at the yard
 * voltage, when the take-off is still free) and energizes the circuit at the
 * connection's voltage. The circuit must be detached at that end.
 */
export function attachCircuitEndToTakeOffOps(doc: NetworkDocument, circuitId: string, end: CircuitEnd, takeOffId: string, opts: NewConnectionOptions = {}): NetworkOp[] {
    const takeOff = doc.takeOffs.find(t => t.id === takeOffId)
    if (!takeOff) return []
    const node = circuitNode(circuitId, end)
    const existing = takeOffConnection(doc, takeOffId)
    const naming = takeOffConnectionNaming(doc, takeOffId)
    const record: ConnectionRecord = existing ? {...existing, nodes: [...existing.nodes, node]} : {
        id: pickId(doc, opts.newId, naming.id), name: opts.newName?.trim() || naming.name, scope: ConnectionScope.TRANSMISSION,
        junction: {kind: ConnectionJunctionKind.SUBSTATION, id: takeOff.substationId},
        nodes: [{kind: NetworkNodeKind.SUBSTATION_TAKE_OFF, id: takeOffId}, node],
        voltage: takeOff.voltage ?? doc.substations.find(s => s.id === takeOff.substationId)?.voltage,
    }
    return [{type: 'upsert', collection: 'connections', record}, ...energizeCircuitOps(doc, circuitId, record)]
}

export interface JunctionAttachOptions extends NewConnectionOptions {
    /** Join this existing node instead of creating one. */
    connectionId?: string
    /** Force a new node even when exactly one exists. */
    forceNew?: boolean
}

/**
 * Joins the circuit end at a junction. By default it joins the single existing
 * node when there is exactly one, otherwise creates a new named node (at
 * `voltage`, the circuit's rated voltage); `opts` can pick a specific node or
 * force a new one with a chosen id / name. The circuit is energized at the
 * voltage of the node it joins.
 */
export function attachCircuitEndToJunctionOps(doc: NetworkDocument, circuitId: string, end: CircuitEnd, junctionId: string, voltage?: string, opts: JunctionAttachOptions = {}): NetworkOp[] {
    const node = circuitNode(circuitId, end)
    const existing = connectionsAtJunction(doc, junctionId)
    const target = opts.connectionId ? existing.find(c => c.id === opts.connectionId) : (!opts.forceNew && existing.length === 1 ? existing[0] : undefined)
    const naming = junctionConnectionNaming(doc, junctionId, opts.newName)
    const record: ConnectionRecord = target ? {...target, nodes: [...target.nodes, node], voltage: target.voltage ?? (voltage as TransmissionVoltage | undefined)} : {
        id: pickId(doc, opts.newId, naming.id), name: naming.name,
        scope: ConnectionScope.TRANSMISSION, junction: {kind: ConnectionJunctionKind.TRANSMISSION_JUNCTION, id: junctionId},
        nodes: [node], voltage: voltage as TransmissionVoltage | undefined,
    }
    return [{type: 'upsert', collection: 'connections', record}, ...energizeCircuitOps(doc, circuitId, record)]
}

/** Moves a circuit end at a junction into another node there (`connectionId`) or into a new node. */
export function moveCircuitEndOps(doc: NetworkDocument, circuitId: string, end: CircuitEnd, target: { connectionId: string } | NewConnectionOptions): NetworkOp[] {
    const current = circuitEndConnection(doc, circuitId, end)
    if (!current || current.junction.kind !== ConnectionJunctionKind.TRANSMISSION_JUNCTION) return []
    if ('connectionId' in target && target.connectionId === current.id) return []
    const detach = detachCircuitEndOps(doc, circuitId, end)
    const after = applyLocal(doc, detach)
    const circuit = doc.circuits.find(c => c.id === circuitId)
    const attach = 'connectionId' in target
        ? attachCircuitEndToJunctionOps(after, circuitId, end, current.junction.id, circuit?.voltage, {connectionId: target.connectionId})
        : attachCircuitEndToJunctionOps(after, circuitId, end, current.junction.id, circuit?.voltage, {forceNew: true, newId: target.newId, newName: target.newName})
    return [...detach, ...attach]
}

/** A circuit end, as the junction panel lists it. */
export interface CircuitEndRef {
    circuitId: string
    end: CircuitEnd
}

/** Circuit ends that belong at the junction (their path ends there) but are not attached anywhere. */
export function looseEndsAtJunction(doc: NetworkDocument, junctionId: string): CircuitEndRef[] {
    const here: ConnectionJunctionRef = {kind: ConnectionJunctionKind.TRANSMISSION_JUNCTION, id: junctionId}
    const out: CircuitEndRef[] = []
    for (const c of doc.circuits) {
        const path = c.pathId ? doc.paths.find(p => p.id === c.pathId) : undefined
        if (!path) continue
        for (const [end, pathEnd] of [[CIRCUIT_END_FROM, path.from], [CIRCUIT_END_TO, path.to]] as const) {
            if (pathEnd && atPathEnd(doc, here, pathEnd) && !circuitEndConnection(doc, c.id, end)) out.push({circuitId: c.id, end})
        }
    }
    return out
}

/**
 * Puts the chosen circuit ends into one node at the junction: the node that
 * already holds most of them takes the others (moved out of their nodes, or
 * attached when loose); when none is attached yet a new node is formed. A
 * node is never formed without circuit ends, and nodes left without any are
 * removed (see `detachCircuitEndOps`).
 */
export function formJunctionNodeOps(doc: NetworkDocument, junctionId: string, ends: CircuitEndRef[]): NetworkOp[] {
    if (ends.length === 0) return []
    const nodeOf = (d: NetworkDocument, e: CircuitEndRef) => {
        const conn = circuitEndConnection(d, e.circuitId, e.end)
        return conn && conn.junction.kind === ConnectionJunctionKind.TRANSMISSION_JUNCTION && conn.junction.id === junctionId ? conn : undefined
    }
    const counts = new Map<string, number>()
    for (const e of ends) {
        const n = nodeOf(doc, e)
        if (n) counts.set(n.id, (counts.get(n.id) ?? 0) + 1)
    }
    let target: string | undefined = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
    const ops: NetworkOp[] = []
    let probe = doc
    const push = (next: NetworkOp[]) => {
        ops.push(...next)
        probe = applyOps(probe, next)
    }
    for (const e of ends) {
        const current = nodeOf(probe, e)
        if (current && current.id === target) continue
        if (circuitEndConnection(probe, e.circuitId, e.end) && !current) continue   // attached elsewhere (not at this junction): leave it
        const voltage = probe.circuits.find(c => c.id === e.circuitId)?.voltage
        if (!target) {
            // the first end forms the node: moved into a new node, or attached as a new one
            push(current ? moveCircuitEndOps(probe, e.circuitId, e.end, {}) : attachCircuitEndToJunctionOps(probe, e.circuitId, e.end, junctionId, voltage, {forceNew: true}))
            target = nodeOf(probe, e)?.id
        } else push(current ? moveCircuitEndOps(probe, e.circuitId, e.end, {connectionId: target}) : attachCircuitEndToJunctionOps(probe, e.circuitId, e.end, junctionId, voltage, {connectionId: target}))
    }
    return ops
}

/** Take-offs of a yard that are not yet used by a transmission connection. */
/** What a take-off carries: its transmission connection, the circuits whose end sits there and the lines those circuits are sections of. */
export function takeOffUsage(doc: NetworkDocument, takeOffId: string): { connection?: ConnectionRecord; circuits: TransmissionCircuitRecord[]; lines: TransmissionLineRecord[] } {
    const connection = takeOffConnection(doc, takeOffId)
    const circuits = connection ? connection.nodes.filter(n => n.kind === NetworkNodeKind.TRANSMISSION_CIRCUIT).map(n => doc.circuits.find(c => c.id === n.id)).filter((c): c is TransmissionCircuitRecord => !!c) : []
    const ids = new Set(circuits.map(c => c.id))
    const lines = circuits.length ? doc.lines.filter(l => l.circuitIds.some(id => ids.has(id))) : []
    return {connection, circuits, lines}
}

/** One line of text naming what uses a take-off: "circuit A (line L1), circuit B"; empty when free. */
export function describeTakeOffUsage(doc: NetworkDocument, takeOffId: string): string {
    const u = takeOffUsage(doc, takeOffId)
    return u.circuits.map(c => {
        const ls = doc.lines.filter(l => l.circuitIds.includes(c.id))
        return `circuit ${c.name}${ls.length ? ` (line ${ls.map(l => l.name).join(', ')})` : ''}`
    }).join(', ')
}

export function freeTakeOffs(doc: NetworkDocument, substationId: string) {
    const used = new Set(doc.connections.filter(c => c.scope === ConnectionScope.TRANSMISSION).flatMap(c => c.nodes.filter(n => n.kind === NetworkNodeKind.SUBSTATION_TAKE_OFF).map(n => n.id)))
    return doc.takeOffs.filter(t => t.substationId === substationId && !used.has(t.id))
}

/** Clears a path end and detaches that end of every circuit on the path. */
export function detachPathEndOps(doc: NetworkDocument, path: TransmissionPathRecord, end: CircuitEnd): NetworkOp[] {
    const ops: NetworkOp[] = [{type: 'upsert', collection: 'paths', record: {...path, [end === CIRCUIT_END_FROM ? 'from' : 'to']: undefined}}]
    // Detach circuits one at a time against the evolving document so two circuits in one connection both get removed.
    let current = doc
    for (const c of doc.circuits.filter(c => c.pathId === path.id)) {
        const detach = detachCircuitEndOps(current, c.id, end)
        ops.push(...detach)
        current = applyLocal(current, detach)
    }
    return ops
}

/** Sets a path end (the circuits are attached separately, through take-offs / junction nodes). */
export function attachPathEndOps(path: TransmissionPathRecord, end: CircuitEnd, ref: ConnectionJunctionRef): NetworkOp[] {
    return [{type: 'upsert', collection: 'paths', record: {...path, [end === CIRCUIT_END_FROM ? 'from' : 'to']: ref}}]
}

function applyLocal(doc: NetworkDocument, ops: NetworkOp[]): NetworkDocument {
    let connections = doc.connections
    for (const op of ops) {
        if (op.type === 'delete' && op.collection === 'connections') connections = connections.filter(c => c.id !== op.id)
        else if (op.type === 'upsert' && op.collection === 'connections') connections = connections.map(c => c.id === op.record.id ? op.record as typeof c : c)
    }
    return {...doc, connections}
}

/* ---------- status helpers for lists ---------- */

export interface EnergizedMismatch {
    end: CircuitEnd
    /** Voltage of the connection at that end. */
    expected: TransmissionVoltage
    connection: ConnectionRecord
}

/**
 * Connected ends whose connection voltage differs from `energized` (the
 * circuit's energized voltage, or a draft value being edited). An end whose
 * connection voltage is unknown never mismatches.
 */
export function energizedMismatches(doc: NetworkDocument, circuitId: string, energized?: TransmissionVoltage): EnergizedMismatch[] {
    const out: EnergizedMismatch[] = []
    // de-energized on purpose (0 V): not a mismatch with the live nodes it stays attached to
    if (energized === TransmissionVoltage.DE_ENERGIZED) return out
    for (const end of [CIRCUIT_END_FROM, CIRCUIT_END_TO] as CircuitEnd[]) {
        const connection = circuitEndConnection(doc, circuitId, end)
        const expected = connection && connectionVoltage(doc, connection)
        if (connection && expected && expected !== energized) out.push({end, expected, connection})
    }
    return out
}

export interface CircuitStatus {
    looseFrom: boolean
    looseTo: boolean
    /** An end is connected somewhere other than its path end. */
    mismatch: boolean
    /** Connected ends whose connection voltage differs from the circuit's energized voltage. */
    energized: EnergizedMismatch[]
}

export function circuitStatus(doc: NetworkDocument, circuitId: string): CircuitStatus {
    const c = doc.circuits.find(x => x.id === circuitId)
    const path = c && doc.paths.find(p => p.id === c.pathId)
    const from = circuitEndRef(doc, circuitId, CIRCUIT_END_FROM)
    const to = circuitEndRef(doc, circuitId, CIRCUIT_END_TO)
    const mismatch = !!path && ((!!from && !!path.from && !atPathEnd(doc, from, path.from)) || (!!to && !!path.to && !atPathEnd(doc, to, path.to)))
    return {looseFrom: !from, looseTo: !to, mismatch, energized: c ? energizedMismatches(doc, c.id, c.energizedVoltage) : []}
}

/**
 * Short attention markers for lists: loose ends, an end away from its path, energized voltage differing from a
 * connection; a circuit without a path that is not attached at both ends cannot be drawn on the map.
 */
export function circuitWarnings(doc: NetworkDocument, circuitId: string): string[] {
    const st = circuitStatus(doc, circuitId)
    const c = doc.circuits.find(x => x.id === circuitId)
    return [
        c && !c.pathId && (st.looseFrom || st.looseTo) ? 'no path: not drawn' : '',
        st.looseFrom ? `loose ${CIRCUIT_END_FROM}` : '',
        st.looseTo ? `loose ${CIRCUIT_END_TO}` : '',
        st.mismatch ? 'end differs from path' : '',
        ...st.energized.map(m => `energized ${c?.energizedVoltage ?? 'not set'} ≠ ${m.expected} at ${m.end}`),
    ].filter(Boolean)
}

export interface PathStatus {
    noFrom: boolean
    noTo: boolean
    unused: boolean
    /** Some circuit on the path has a loose end. */
    looseCircuits: number
}

export function pathStatus(doc: NetworkDocument, pathId: string): PathStatus {
    const p = doc.paths.find(x => x.id === pathId)
    const circuits = doc.circuits.filter(c => c.pathId === pathId)
    const loose = circuits.filter(c => {
        const s = circuitStatus(doc, c.id)
        return s.looseFrom || s.looseTo
    }).length
    return {noFrom: !p?.from, noTo: !p?.to, unused: circuits.length === 0, looseCircuits: loose}
}

export const END_LABEL: Record<CircuitEnd, string> = {[CIRCUIT_END_FROM]: 'From', [CIRCUIT_END_TO]: 'To'}
