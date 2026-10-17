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
import {circuitsOnPath, linesOfCircuit, recordById} from '@shared/network/lookup'
import {circuitEndConnection, connectionVoltage, takeOffCircuit, takeOffVoltage} from '@shared/network/migrate'
import {junctionConnectionNaming, takeOffConnectionNaming} from '@shared/network/naming'
import {energizedVsRated, TransmissionVoltage, transmissionTypeOf} from '@shared/models/transmission.voltage'
import {effectiveVoltage, nodeRunningVoltage, runningVoltagesAt} from '@shared/network/lines'

export {circuitEndConnection, connectionVoltage, takeOffCircuit, takeOffVoltage}

const circuitNode = (circuitId: string, end: CircuitEnd): NetworkNodeRef => ({kind: NetworkNodeKind.TRANSMISSION_CIRCUIT, id: circuitId, terminal: end})

/**
 * Op that sets the circuit's energized voltage to the voltage of the
 * connection it has just joined (`conn` as it will be after the attach):
 * a yard's (or its take-off's), or at a junction the one the circuits
 * already there run at (`nodeRunningVoltage`). Nothing when the circuit is
 * unknown here, the voltage is unknown, or it already matches.
 */
export function energizeCircuitOps(doc: NetworkDocument, circuitId: string, conn: ConnectionRecord): NetworkOp[] {
    const circuit = doc.circuits.find(c => c.id === circuitId)
    const v = nodeRunningVoltage(doc, conn, circuitId)
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
        const group = recordById(doc.substationGroups, ref.id)
        return group ? group.groupName : ref.id
    }
    if (ref.kind === ConnectionJunctionKind.SUBSTATION) {
        const yard = recordById(doc.substations, ref.id)
        const group = yard && recordById(doc.substationGroups, yard.groupId)
        return yard ? `${group?.groupName ?? ''} ${yard.yardName}`.trim() : ref.id
    }
    const j = recordById(doc.junctions, ref.id)
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
    /** Voltage of a new take-off connection (the take-off's circuit) when it is to differ from the take-off's, e.g. a secondary / auxiliary line; the take-off's otherwise. */
    voltage?: TransmissionVoltage
}

/**
 * Ops that set a take-off's voltage, which lives on its circuit (`takeOffCircuit`): the TRANSMISSION connection holding
 * it, else the in-yard connection it is wired into; `undefined` clears it (the yard's applies). Undefined when the
 * take-off has no circuit yet (free and not wired in the yard): it is at the yard's voltage.
 */
export function setTakeOffVoltageOps(doc: NetworkDocument, takeOffId: string, voltage: TransmissionVoltage | undefined): NetworkOp[] | undefined {
    const circuit = takeOffCircuit(doc, takeOffId)
    const target = circuit.line ?? circuit.yard.find(c => c.voltage) ?? circuit.yard[0]
    if (!target) return undefined
    return target.voltage === voltage ? [] : [{type: 'upsert', collection: 'connections', record: {...target, voltage}}]
}

/**
 * Joins the circuit end to the take-off's connection (created when the take-off
 * is still free, at the take-off's voltage or `opts.voltage`) and energizes the
 * circuit at the connection's voltage. The circuit must be detached at that end.
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
        voltage: opts.voltage ?? takeOffVoltage(doc, takeOffId),
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
    /** Voltage the end's connection runs at: the take-off's or the yard's, or the circuits joined at a junction node. */
    expected: TransmissionVoltage
    connection: ConnectionRecord
}

/** Something worth knowing about a circuit end's voltage that needs no fixing (shown in blue). */
export interface EndVoltageInfo {
    end: CircuitEnd
    connection: ConnectionRecord
    text: string
}

/**
 * The voltage at each connected end against the circuit's effective one (`energized` and `rated` as being edited, else
 * the record's: energized, else rated); a de-energized circuit (0 V) has nothing to compare. `mismatches`, warnings: at
 * a yard the take-off's or the yard's voltage differs; at a junction the circuits it joins there run at another voltage
 * (or at several). `info`: at a junction, the circuits it joins at the same voltage, and a node whose nominal voltage
 * differs (the nominal voltage does not restrict the circuits there).
 */
export function endVoltageNotes(doc: NetworkDocument, circuitId: string, energized?: TransmissionVoltage, rated?: TransmissionVoltage): { mismatches: EnergizedMismatch[]; info: EndVoltageInfo[] } {
    const out: { mismatches: EnergizedMismatch[]; info: EndVoltageInfo[] } = {mismatches: [], info: []}
    const circuit = recordById(doc.circuits, circuitId)
    const effective = energized ?? rated ?? effectiveVoltage(circuit)
    // de-energized on purpose (0 V): not a mismatch with the live nodes it stays attached to
    if (!effective || effective === TransmissionVoltage.DE_ENERGIZED) return out
    for (const end of [CIRCUIT_END_FROM, CIRCUIT_END_TO] as CircuitEnd[]) {
        const connection = circuitEndConnection(doc, circuitId, end)
        if (!connection) continue
        if (connection.junction.kind === ConnectionJunctionKind.SUBSTATION) {
            const expected = connectionVoltage(doc, connection)
            if (expected && expected !== effective) out.mismatches.push({end, expected, connection})
            continue
        }
        const node = connection.name ?? connection.id
        const {voltages, circuits} = runningVoltagesAt(doc, connection, [circuitId])
        const other = voltages.find(v => v !== effective)
        if (other) {
            out.mismatches.push({end, expected: other, connection})
            continue
        }
        const nominal = connection.voltage && connection.voltage !== effective ? `; node ${node} is nominally ${connection.voltage}` : ''
        if (circuits.length) out.info.push({end, connection, text: `joins ${circuits.map(c => c.name).join(', ')} at node ${node}, all at ${effective}${nominal}`})
        else if (nominal) out.info.push({end, connection, text: `ends open at node ${node} (no other circuit there)${nominal}`})
    }
    return out
}

/** The ends whose connection runs at another voltage than the circuit (warnings; see `endVoltageNotes`). */
export const energizedMismatches = (doc: NetworkDocument, circuitId: string, energized?: TransmissionVoltage, rated?: TransmissionVoltage): EnergizedMismatch[] =>
    endVoltageNotes(doc, circuitId, energized, rated).mismatches

/**
 * A circuit energized beyond what it is rated for, as a short warning: above its rating, or at another current type
 * (AC on a DC circuit or the other way round). Running below its rating, or de-energized, is fine (undefined).
 */
export function ratingProblem(rated?: TransmissionVoltage, energized?: TransmissionVoltage): string | undefined {
    const how = energizedVsRated(rated, energized)
    if (how === 'typeMismatch') return `energized ${energized} (${transmissionTypeOf(energized)}) on a ${rated} (${transmissionTypeOf(rated)}) circuit`
    if (how === 'higher') return `energized ${energized} above its rated ${rated}`
    return undefined
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
    const c = recordById(doc.circuits, circuitId)
    const path = c && recordById(doc.paths, c.pathId)
    const from = circuitEndRef(doc, circuitId, CIRCUIT_END_FROM)
    const to = circuitEndRef(doc, circuitId, CIRCUIT_END_TO)
    const mismatch = !!path && ((!!from && !!path.from && !atPathEnd(doc, from, path.from)) || (!!to && !!path.to && !atPathEnd(doc, to, path.to)))
    return {looseFrom: !from, looseTo: !to, mismatch, energized: c ? energizedMismatches(doc, c.id) : []}
}

/**
 * Short attention markers for lists: loose ends, an end away from its path, energized voltage differing from a
 * connection (`energizedMismatches`) or beyond the rating (`ratingProblem`; running below it is fine), a circuit that is
 * a section of no line; a circuit without a path that is not attached at both ends
 * cannot be drawn on the map.
 */
export function circuitWarnings(doc: NetworkDocument, circuitId: string): string[] {
    const st = circuitStatus(doc, circuitId)
    const c = recordById(doc.circuits, circuitId)
    return [
        c && !c.pathId && (st.looseFrom || st.looseTo) ? 'no path: not drawn' : '',
        st.looseFrom ? `loose ${CIRCUIT_END_FROM}` : '',
        st.looseTo ? `loose ${CIRCUIT_END_TO}` : '',
        st.mismatch ? 'end differs from path' : '',
        ...st.energized.map(m => `energized ${effectiveVoltage(c) ?? 'not set'} ≠ ${m.expected} at ${m.end}`),
        ratingProblem(c?.voltage, c?.energizedVoltage) ?? '',
        linesOfCircuit(doc, circuitId).length ? '' : 'no line',
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
    const p = recordById(doc.paths, pathId)
    const circuits = circuitsOnPath(doc, pathId)
    const loose = circuits.filter(c => {
        const s = circuitStatus(doc, c.id)
        return s.looseFrom || s.looseTo
    }).length
    return {noFrom: !p?.from, noTo: !p?.to, unused: circuits.length === 0, looseCircuits: loose}
}

export const END_LABEL: Record<CircuitEnd, string> = {[CIRCUIT_END_FROM]: 'From', [CIRCUIT_END_TO]: 'To'}
