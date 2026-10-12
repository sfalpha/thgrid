/**
 * Joining two circuits spliced at a junction back into one circuit on one
 * path (the reverse of a split). The node must hold exactly two circuit ends
 * of two circuits whose paths meet at the junction. The first circuit (the
 * one arriving at the junction, or the first node when both arrive / leave)
 * survives: it takes over the far end of the second one, its path is
 * extended through the junction with the second path's waypoints (or a
 * merged / reused path is used when the paths are shared or the user asks
 * for an existing route), lengths are added, lines replace the two sections
 * by the one, and the junction is removed when nothing else is left there.
 * Pure: returns ops plus a summary for the confirmation.
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
    TransmissionCircuitRecord,
    TransmissionLineRecord,
    TransmissionPathRecord,
} from '@shared/network/records'
import {applyOps, NetworkOp, uniqueId} from '@shared/network/ops'
import {pathNaming, regenerateNamingOps, RegenerateChange} from '@shared/network/naming'
import {atPathEnd, junctionRef, sameRef} from '@shared/network/refs'
import {circuitEndConnection} from './linkOps'
import {pathsBetween} from './lineWizard'

export interface JoinCircuitsOptions {
    /** Run the joined circuit on this existing path between the joined ends instead of extending / merging its own. */
    reusePathId?: string
}

interface Side {
    circuit: TransmissionCircuitRecord
    path: TransmissionPathRecord
    /** End of the circuit that sits in the node at the junction. */
    junctionEnd: CircuitEnd
    /** Connection at the other end, if attached. */
    farConnection?: ConnectionRecord
    /** Path end at the far side. */
    farEnd?: ConnectionJunctionRef
    /** Other circuits on the same path. */
    shared: boolean
}

export interface JoinCircuitsPlan {
    ops: NetworkOp[]
    /** The surviving circuit (as it will be) and the one merged into it. */
    merged?: TransmissionCircuitRecord
    removed?: TransmissionCircuitRecord
    /** The path the joined circuit runs on. */
    path?: { id: string; name: string; created: boolean; extended: boolean; reused: boolean }
    /** Paths that already run between the joined ends (candidates for `reusePathId`). */
    existingPaths: TransmissionPathRecord[]
    /** Paths deleted because no circuit uses them any more. */
    removedPaths: TransmissionPathRecord[]
    junctionRemoved: boolean
    /** Lines whose sections changed. */
    lines: TransmissionLineRecord[]
    /** Optional follow-up: re-derive the names / ids of the joined circuit and its path from the model rules. */
    regenerate: { ops: NetworkOp[]; changes: RegenerateChange[] }
    errors: string[]
    warnings: string[]
}

const circuitNode = (n: ConnectionRecord['nodes'][number]) => n.kind === NetworkNodeKind.TRANSMISSION_CIRCUIT

/** The two sides of a joinable node (exactly two circuit ends of two circuits whose paths meet at the junction), else a reason. */
function sides(doc: NetworkDocument, conn: ConnectionRecord): { sides: [Side, Side] } | { error: string } {
    if (conn.scope !== ConnectionScope.TRANSMISSION || conn.junction.kind !== ConnectionJunctionKind.TRANSMISSION_JUNCTION) return {error: 'only a node at a junction can be joined'}
    const ends = conn.nodes.filter(circuitNode)
    if (ends.length !== 2 || conn.nodes.length !== 2) return {error: 'the node must hold exactly two circuit ends'}
    if (ends[0].id === ends[1].id) return {error: 'both ends belong to the same circuit'}
    const jRef = junctionRef(conn.junction.id)
    const out: Side[] = []
    for (const n of ends) {
        const circuit = doc.circuits.find(c => c.id === n.id)
        const path = circuit && doc.paths.find(p => p.id === circuit.pathId)
        if (!circuit || !path) return {error: `circuit ${n.id} has no path`}
        const junctionEnd = (n.terminal === CIRCUIT_END_FROM ? CIRCUIT_END_FROM : CIRCUIT_END_TO) as CircuitEnd
        const pathEndHere = junctionEnd === CIRCUIT_END_FROM ? path.from : path.to
        if (!atPathEnd(doc, jRef, pathEndHere)) return {error: `path "${path.name}" does not end at this junction`}
        const farEndKey = junctionEnd === CIRCUIT_END_FROM ? CIRCUIT_END_TO : CIRCUIT_END_FROM
        out.push({
            circuit, path, junctionEnd,
            farConnection: circuitEndConnection(doc, circuit.id, farEndKey),
            farEnd: farEndKey === CIRCUIT_END_FROM ? path.from : path.to,
            shared: doc.circuits.some(c => c.id !== circuit.id && c.pathId === path.id),
        })
    }
    return {sides: [out[0], out[1]]}
}

/** Whether the node can be joined; the reason when it cannot. */
export function joinableReason(doc: NetworkDocument, conn: ConnectionRecord): string | undefined {
    const s = sides(doc, conn)
    return 'error' in s ? s.error : undefined
}

export function buildJoinCircuitsPlan(doc: NetworkDocument, connectionId: string, opts: JoinCircuitsOptions = {}): JoinCircuitsPlan {
    const fail = (errors: string[]): JoinCircuitsPlan => ({ops: [], existingPaths: [], removedPaths: [], junctionRemoved: false, lines: [], regenerate: {ops: [], changes: []}, errors, warnings: []})
    const conn = doc.connections.find(c => c.id === connectionId)
    if (!conn) return fail(['the connection no longer exists'])
    const s = sides(doc, conn)
    if ('error' in s) return fail([s.error])
    // The first side arrives at the junction (its TO end is here) when one of them does; the second leaves it.
    let [first, second] = s.sides
    if (first.junctionEnd === CIRCUIT_END_FROM && second.junctionEnd === CIRCUIT_END_TO) [first, second] = [second, first]
    const firstReversed = first.junctionEnd === CIRCUIT_END_FROM   // both leave the junction: the first is read backwards
    const secondReversed = second.junctionEnd === CIRCUIT_END_TO   // both arrive: the second is read backwards
    const junction = doc.junctions.find(j => j.id === conn.junction.id)
    const warnings: string[] = []
    const a = first.circuit, b = second.circuit
    if ((a.voltage ?? '') !== (b.voltage ?? '')) warnings.push(`rated voltages differ (${a.voltage ?? '–'} / ${b.voltage ?? '–'}): the joined circuit keeps ${a.voltage ?? 'none'}`)
    if ((a.energizedVoltage ?? '') !== (b.energizedVoltage ?? '')) warnings.push(`energized voltages differ (${a.energizedVoltage ?? '–'} / ${b.energizedVoltage ?? '–'})`)
    if ((a.bundle ?? 1) !== (b.bundle ?? 1)) warnings.push(`bundles differ (${a.bundle ?? 1} / ${b.bundle ?? 1}): the joined circuit keeps ${a.bundle ?? 1}`)
    if (JSON.stringify(a.conductor) !== JSON.stringify(b.conductor)) warnings.push('conductors differ: the joined circuit keeps the first one')
    if (!!a.planned !== !!b.planned) warnings.push('one circuit is planned, the other is not: the joined circuit keeps the first one\'s flag')
    const mergedFrom = first.farEnd, mergedTo = second.farEnd
    if (!mergedFrom || !mergedTo) return fail(['both paths need their far ends set before joining'])
    if (sameRef(mergedFrom, mergedTo)) warnings.push('the joined circuit would start and end at the same place')

    const ops: NetworkOp[] = []
    let probe = doc
    const push = (...next: NetworkOp[]) => {
        ops.push(...next)
        probe = applyOps(probe, next)
    }

    // 1. the node at the junction goes
    push({type: 'delete', collection: 'connections', id: conn.id})

    // 2. the far ends: the first circuit's far end is the joined FROM, the second's far end becomes the joined TO
    const retarget = (c: ConnectionRecord | undefined, circuitId: string, newCircuitId: string, terminal: CircuitEnd) => {
        if (!c) return
        const nodes = c.nodes.map(n => circuitNode(n) && n.id === circuitId ? {...n, id: newCircuitId, terminal} : n)
        push({type: 'upsert', collection: 'connections', record: {...c, nodes}})
    }
    retarget(first.farConnection, a.id, a.id, CIRCUIT_END_FROM)
    retarget(second.farConnection, b.id, a.id, CIRCUIT_END_TO)

    // 3. the route: waypoints of both paths through the junction, FROM → TO
    const wpsFirst = firstReversed ? [...first.path.waypoints].reverse() : first.path.waypoints
    const wpsSecond = secondReversed ? [...second.path.waypoints].reverse() : second.path.waypoints
    const waypoints = [...wpsFirst, ...(junction ? [junction.coords] : []), ...wpsSecond]
    const existingPaths = pathsBetween(doc, mergedFrom, mergedTo).filter(p => p.id !== first.path.id && p.id !== second.path.id)
    let path: TransmissionPathRecord
    let created = false, extended = false, reused = false
    const reuse = opts.reusePathId ? existingPaths.find(p => p.id === opts.reusePathId) : undefined
    if (opts.reusePathId && !reuse) return fail([`path ${opts.reusePathId} does not run between the joined ends`])
    if (reuse) {
        path = reuse
        reused = true
    } else if (!first.shared && !firstReversed) {
        path = {...first.path, to: mergedTo, waypoints}
        extended = true
        push({type: 'upsert', collection: 'paths', record: path})
    } else if (!second.shared && !secondReversed) {
        path = {...second.path, from: mergedFrom, waypoints}
        extended = true
        push({type: 'upsert', collection: 'paths', record: path})
    } else {
        const naming = pathNaming(probe, mergedFrom, mergedTo)
        path = {id: uniqueId(probe, naming.id), name: naming.name, from: mergedFrom, to: mergedTo, waypoints}
        created = true
        push({type: 'upsert', collection: 'paths', record: path})
    }
    // A reused path running the other way: the joined circuit follows it, so its ends swap.
    if (reused && sameRef(path.from, mergedTo)) {
        for (const c of probe.connections) {
            if (!c.nodes.some(n => circuitNode(n) && n.id === a.id)) continue
            push({type: 'upsert', collection: 'connections', record: {...c, nodes: c.nodes.map(n => circuitNode(n) && n.id === a.id ? {...n, terminal: n.terminal === CIRCUIT_END_FROM ? CIRCUIT_END_TO : CIRCUIT_END_FROM} : n)}})
        }
        warnings.push(`path "${path.name}" runs ${mergedTo.id} → ${mergedFrom.id}: the joined circuit follows its direction`)
    }

    // 4. the joined circuit: the first one, now on the route, with the lengths added; the second one goes
    const merged: TransmissionCircuitRecord = {
        ...a, pathId: path.id,
        lengthKm: a.lengthKm !== undefined && b.lengthKm !== undefined ? Number((a.lengthKm + b.lengthKm).toFixed(2)) : a.lengthKm ?? b.lengthKm,
    }
    push({type: 'upsert', collection: 'circuits', record: merged})
    push({type: 'delete', collection: 'circuits', id: b.id})

    // 5. lines: the two sections become one
    const lines: TransmissionLineRecord[] = []
    for (const l of doc.lines) {
        if (!l.circuitIds.includes(b.id) && !l.circuitIds.includes(a.id)) continue
        if (!l.circuitIds.includes(b.id)) continue
        const circuitIds = l.circuitIds.map(id => id === b.id ? a.id : id).filter((id, i, arr) => id !== a.id || arr.indexOf(a.id) === i)
        const updated = {...l, circuitIds}
        push({type: 'upsert', collection: 'lines', record: updated})
        lines.push(updated)
    }

    // 6. paths nobody uses any more
    const removedPaths: TransmissionPathRecord[] = []
    for (const p of [first.path, second.path]) {
        if (p.id === path.id) continue
        if (probe.circuits.some(c => c.pathId === p.id)) continue
        push({type: 'delete', collection: 'paths', id: p.id})
        removedPaths.push(p)
    }

    // 7. the junction, when it is a free one with nothing left
    let junctionRemoved = false
    if (junction && !junction.groupId) {
        const stillUsed = probe.connections.some(c => c.junction.kind === ConnectionJunctionKind.TRANSMISSION_JUNCTION && c.junction.id === junction.id)
            || probe.paths.some(p => sameRef(p.from, junctionRef(junction.id)) || sameRef(p.to, junctionRef(junction.id)))
        if (!stillUsed) {
            push({type: 'delete', collection: 'junctions', id: junction.id})
            junctionRemoved = true
        }
    }

    const regenerate = regenerateNamingOps(probe, [{collection: 'circuits', id: a.id}, {collection: 'paths', id: path.id}], {id: true, name: true})
    return {
        ops, merged: probe.circuits.find(c => c.id === a.id) ?? merged, removed: b,
        path: {id: path.id, name: path.name, created, extended, reused}, existingPaths, removedPaths, junctionRemoved, lines,
        regenerate: {ops: regenerate.ops, changes: regenerate.changes}, errors: [], warnings,
    }
}
