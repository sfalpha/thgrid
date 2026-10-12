/**
 * Bypassing a junction: the circuits that pass through it (two circuit ends
 * spliced in one node) are joined into one circuit each, running directly
 * between their far ends, so they no longer pass through the junction. Each
 * join is `buildJoinCircuitsPlan` (paths extended / merged, lines
 * re-sequenced, unused paths removed, the node at the junction removed, and
 * the junction itself when nothing is left there). In a tee (three or more
 * circuit ends in one node) only the chosen pair is taken out; the node keeps
 * the other ends. Pure: returns ops plus a summary for the confirmation.
 */
import {
    CircuitEnd,
    ConnectionJunctionKind,
    ConnectionJunctionRef,
    ConnectionRecord,
    NetworkDocument,
    NetworkNodeKind,
    NetworkNodeRef,
    TransmissionCircuitRecord,
    TransmissionLineRecord,
    TransmissionPathRecord,
    CIRCUIT_END_FROM,
} from '@shared/network/records'
import {applyOps, NetworkOp} from '@shared/network/ops'
import {regenerateNamingOps, RegenerateChange} from '@shared/network/naming'
import {buildJoinCircuitsPlan, joinableReason} from './joinCircuits'
import {circuitEndConnection, connectionsAtJunction, moveCircuitEndOps} from './linkOps'

/** Two circuit ends spliced at the junction: one circuit arriving and one leaving (or both arriving / leaving). */
export interface PassThrough {
    /** Stable key of the pair: `<circuit>:<end>|<circuit>:<end>`. */
    key: string
    connection: ConnectionRecord
    ends: [NetworkNodeRef, NetworkNodeRef]
    circuits: [TransmissionCircuitRecord, TransmissionCircuitRecord]
    /** Lines with the two circuits as consecutive sections. */
    lines: TransmissionLineRecord[]
    /** Where each circuit's path ends away from the junction. */
    farEnds: [ConnectionJunctionRef | undefined, ConnectionJunctionRef | undefined]
    /** Why it cannot be bypassed, if it cannot. */
    reason?: string
}

const isCircuitEnd = (n: NetworkNodeRef) => n.kind === NetworkNodeKind.TRANSMISSION_CIRCUIT
const endKey = (n: NetworkNodeRef) => `${n.id}:${n.terminal}`
const pairKey = (a: NetworkNodeRef, b: NetworkNodeRef) => [endKey(a), endKey(b)].sort().join('|')

function farEnd(doc: NetworkDocument, n: NetworkNodeRef): ConnectionJunctionRef | undefined {
    const circuit = doc.circuits.find(c => c.id === n.id)
    const path = circuit && doc.paths.find(p => p.id === circuit.pathId)
    return n.terminal === CIRCUIT_END_FROM ? path?.to : path?.from
}

/** Lines that have the two circuits as consecutive sections. */
function linesThrough(doc: NetworkDocument, a: string, b: string): TransmissionLineRecord[] {
    return doc.lines.filter(l => l.circuitIds.some((id, i) => (id === a && l.circuitIds[i + 1] === b) || (id === b && l.circuitIds[i + 1] === a)))
}

/**
 * Takes the pair out of a node holding more ends: the first end moves into a
 * new node, the second joins it. Returns the ops and the pair's node id (the
 * node itself when it holds just the pair).
 */
function isolatePair(doc: NetworkDocument, conn: ConnectionRecord, ends: [NetworkNodeRef, NetworkNodeRef]): { ops: NetworkOp[]; connectionId: string } {
    if (conn.nodes.length === 2) return {ops: [], connectionId: conn.id}
    const [a, b] = ends
    const first = moveCircuitEndOps(doc, a.id, a.terminal as CircuitEnd, {})
    const after = applyOps(doc, first)
    const node = circuitEndConnection(after, a.id, a.terminal as CircuitEnd)!
    const second = moveCircuitEndOps(after, b.id, b.terminal as CircuitEnd, {connectionId: node.id})
    return {ops: [...first, ...second], connectionId: node.id}
}

/**
 * What passes through the junction: every node holding exactly two circuit
 * ends, and in a tee every pair of circuit ends that are consecutive sections
 * of a line.
 */
export function passThroughs(doc: NetworkDocument, junctionId: string): PassThrough[] {
    const out: PassThrough[] = []
    for (const conn of connectionsAtJunction(doc, junctionId)) {
        const ends = conn.nodes.filter(isCircuitEnd)
        const pairs: [NetworkNodeRef, NetworkNodeRef][] = []
        if (ends.length === 2) pairs.push([ends[0], ends[1]])
        else if (ends.length > 2) {
            const seen = new Set<string>()
            for (let i = 0; i < ends.length; i++) for (let j = i + 1; j < ends.length; j++) {
                const k = pairKey(ends[i], ends[j])
                if (!seen.has(k) && linesThrough(doc, ends[i].id, ends[j].id).length) {
                    seen.add(k)
                    pairs.push([ends[i], ends[j]])
                }
            }
        }
        for (const pair of pairs) {
            const circuits = pair.map(n => doc.circuits.find(c => c.id === n.id))
            if (!circuits[0] || !circuits[1]) continue
            let reason: string | undefined
            if (conn.nodes.length !== ends.length) reason = 'the node also holds something other than circuit ends'
            else {
                const {ops, connectionId} = isolatePair(doc, conn, pair)
                const probe = ops.length ? applyOps(doc, ops) : doc
                reason = joinableReason(probe, probe.connections.find(c => c.id === connectionId)!)
                if (!reason && (!farEnd(doc, pair[0]) || !farEnd(doc, pair[1]))) reason = 'both paths need their far ends set'
            }
            out.push({
                key: pairKey(pair[0], pair[1]), connection: conn, ends: pair, circuits: [circuits[0], circuits[1]],
                lines: linesThrough(doc, pair[0].id, pair[1].id), farEnds: [farEnd(doc, pair[0]), farEnd(doc, pair[1])], reason,
            })
        }
    }
    return out
}

export interface BypassOptions {
    /** Run a joined circuit on a path that already ran between its far ends before the bypass, when there is one. */
    reuseExistingPaths?: boolean
}

export interface BypassPlan {
    ops: NetworkOp[]
    /** One per bypassed pass-through: the joined circuit and the path it runs on. */
    joined: { circuit: TransmissionCircuitRecord; removed: TransmissionCircuitRecord; path: { id: string; name: string; created: boolean; extended: boolean; reused: boolean } }[]
    /** Pass-throughs whose far ends already had a path between them before the bypass. */
    withExistingPath: number
    removedPaths: TransmissionPathRecord[]
    junctionRemoved: boolean
    /** Optional follow-up: re-derive the names / ids of the joined circuits and their paths from the model rules. */
    regenerate: { ops: NetworkOp[]; changes: RegenerateChange[] }
    errors: string[]
    warnings: string[]
}

/**
 * Ops that bypass the junction for the chosen pass-throughs (keys from
 * `passThroughs`), one join after the other. Parallel circuits joined in the
 * same run share one new path: a path created by an earlier join between the
 * same ends is reused.
 */
export function buildBypassPlan(doc: NetworkDocument, junctionId: string, keys: string[], opts: BypassOptions = {}): BypassPlan {
    const plan: BypassPlan = {ops: [], joined: [], withExistingPath: 0, removedPaths: [], junctionRemoved: false, regenerate: {ops: [], changes: []}, errors: [], warnings: []}
    const chosen = passThroughs(doc, junctionId).filter(p => keys.includes(p.key))
    const before = new Set(doc.paths.map(p => p.id))
    /** Paths this run created, extended or reused between joined ends: the next parallel circuit runs on them too. */
    const touched = new Set<string>()
    let probe = doc
    for (const p of chosen) {
        const label = p.lines.length ? `line ${p.lines.map(l => l.name).join(', ')}` : `${p.circuits[0].name} + ${p.circuits[1].name}`
        if (p.reason) {
            plan.errors.push(`${label}: ${p.reason}`)
            continue
        }
        // the pair's node in the document as it is now (an earlier join may have changed the node)
        const conn = circuitEndConnection(probe, p.ends[0].id, p.ends[0].terminal as CircuitEnd)
        if (!conn || conn.junction.kind !== ConnectionJunctionKind.TRANSMISSION_JUNCTION || conn.junction.id !== junctionId || !conn.nodes.some(n => endKey(n) === endKey(p.ends[1]))) {
            plan.errors.push(`${label}: no longer spliced here (an earlier join in this run changed it)`)
            continue
        }
        const isolated = isolatePair(probe, conn, p.ends)
        const local = isolated.ops.length ? applyOps(probe, isolated.ops) : probe
        let join = buildJoinCircuitsPlan(local, isolated.connectionId)
        if (join.errors.length) {
            plan.errors.push(...join.errors.map(e => `${label}: ${e}`))
            continue
        }
        const fromThisRun = join.existingPaths.find(x => touched.has(x.id))
        const existing = fromThisRun ? undefined : join.existingPaths.find(x => before.has(x.id))
        if (existing) plan.withExistingPath++
        const reuse = fromThisRun ?? (opts.reuseExistingPaths ? existing : undefined)
        if (reuse) join = buildJoinCircuitsPlan(local, isolated.connectionId, {reusePathId: reuse.id})
        if (join.errors.length || !join.merged || !join.removed || !join.path) {
            plan.errors.push(...join.errors.map(e => `${label}: ${e}`))
            continue
        }
        touched.add(join.path.id)
        plan.ops.push(...isolated.ops, ...join.ops)
        probe = applyOps(local, join.ops)
        plan.joined.push({circuit: join.merged, removed: join.removed, path: join.path})
        plan.removedPaths.push(...join.removedPaths)
        plan.junctionRemoved ||= join.junctionRemoved
        plan.warnings.push(...join.warnings.map(w => `${label}: ${w}`))
    }
    const targets = plan.joined.flatMap(j => [{collection: 'circuits' as const, id: j.circuit.id}, {collection: 'paths' as const, id: j.path.id}])
        .filter((t, i, all) => all.findIndex(x => x.collection === t.collection && x.id === t.id) === i && (probe[t.collection] as { id: string }[]).some(r => r.id === t.id))
    const regenerate = regenerateNamingOps(probe, targets, {id: true, name: true})
    plan.regenerate = {ops: regenerate.ops, changes: regenerate.changes}
    return plan
}
