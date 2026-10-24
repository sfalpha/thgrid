/**
 * Swapping the ends of a transmission path: its FROM and TO exchange and its
 * waypoints are reversed (the route stays where it is). The circuits on it
 * follow its direction, so their FROM and TO ends swap too (the end markers
 * in every connection holding them flip; they stay attached where they are),
 * and the tower positions they set are mirrored, as the towers are seen from
 * the other end now (the left circuit of a pair is the right one, the first
 * tower the last), so they keep hanging where they did. Lines are not
 * touched: they run yard to yard whichever way their sections run.
 * Pure: returns ops plus the optional renames (the path is named
 * `<from>-<to>`, and its circuits after it).
 */
import {CIRCUIT_END_FROM, CIRCUIT_END_TO, CircuitGroupKind, circuitGroupKind, NetworkDocument, NetworkNodeKind, TransmissionCircuitRecord, TransmissionPathRecord} from '@shared/network/records'
import {applyOps, NetworkOp} from '@shared/network/ops'
import {regenerateNamingOps, RegenerateChange} from '@shared/network/naming'

export interface SwapPathPlan {
    ops: NetworkOp[]
    /** The path with its ends swapped. */
    path?: TransmissionPathRecord
    /** The circuits on the path, whose FROM and TO ends swap with it. */
    circuits: TransmissionCircuitRecord[]
    /** Circuits whose tower position (line group / number on the tower) was mirrored. */
    mirrored: TransmissionCircuitRecord[]
    /** Optional follow-up: names / ids of the path and its circuits by the model rules. */
    regenerate: { ops: NetworkOp[]; changes: RegenerateChange[] }
    errors: string[]
}

const flip = (t?: string) => (t === CIRCUIT_END_FROM ? CIRCUIT_END_TO : t === CIRCUIT_END_TO ? CIRCUIT_END_FROM : t)

/** Ops that swap the ends of `pathId` (see the module comment). */
export function buildSwapPathPlan(doc: NetworkDocument, pathId: string): SwapPathPlan {
    const plan: SwapPathPlan = {ops: [], circuits: [], mirrored: [], regenerate: {ops: [], changes: []}, errors: []}
    const path = doc.paths.find(p => p.id === pathId)
    if (!path) return {...plan, errors: ['the path no longer exists']}
    if (!path.from && !path.to) return {...plan, errors: [`path ${path.name} has no ends to swap`]}
    plan.path = {...path, from: path.to, to: path.from, waypoints: [...path.waypoints].reverse()}
    plan.ops.push({type: 'upsert', collection: 'paths', record: plan.path})

    plan.circuits = doc.circuits.filter(c => c.pathId === path.id)
    const ids = new Set(plan.circuits.map(c => c.id))
    for (const conn of doc.connections) {
        if (!conn.nodes.some(n => n.kind === NetworkNodeKind.TRANSMISSION_CIRCUIT && ids.has(n.id))) continue
        plan.ops.push({type: 'upsert', collection: 'connections', record: {...conn, nodes: conn.nodes.map(n => n.kind === NetworkNodeKind.TRANSMISSION_CIRCUIT && ids.has(n.id) ? {...n, terminal: flip(n.terminal)} : n)}})
    }

    // tower positions are seen from the FROM end: the towers set come in the other order, 1 / 2 (3 / 4, …) change sides;
    // duct banks and submarine groups likewise, each kind among itself
    const spanOf = (kind: CircuitGroupKind) => {
        const groups = plan.circuits.filter(c => circuitGroupKind(c) === kind).map(c => c.lineGroup).filter((g): g is number => g !== undefined)
        return groups.length ? Math.min(...groups) + Math.max(...groups) : 0
    }
    for (const c of plan.circuits) {
        if (c.lineGroup === undefined && c.groupCircuit === undefined) continue
        const span = spanOf(circuitGroupKind(c))
        const mirrored: TransmissionCircuitRecord = {
            ...c,
            lineGroup: c.lineGroup === undefined ? undefined : span - c.lineGroup,
            groupCircuit: c.groupCircuit === undefined ? undefined : c.groupCircuit % 2 === 1 ? c.groupCircuit + 1 : c.groupCircuit - 1,
        }
        plan.ops.push({type: 'upsert', collection: 'circuits', record: mirrored})
        plan.mirrored.push(mirrored)
    }

    const regenerate = regenerateNamingOps(applyOps(doc, plan.ops), [{collection: 'paths', id: path.id}, ...plan.circuits.map(c => ({collection: 'circuits' as const, id: c.id}))], {id: true, name: true})
    plan.regenerate = {ops: regenerate.ops, changes: regenerate.changes}
    return plan
}
