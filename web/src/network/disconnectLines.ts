/**
 * Disconnecting lines from the take-offs of a site (site panel, *Lines through take-offs*), several at once.
 *
 * Each chosen line leaves its take-off at the site: the circuit end there goes to the site's junction instead (created
 * when missing), in a node of its own (an open end), and the line now ends at that junction. With `bothEnds` its other
 * end leaves its take-off the same way, into the junction of the site it is at. A line that is then fed from no yard is
 * de-energized: when none of the circuits reachable from its sections through junction nodes ends at a yard, those
 * circuits are energized at 0 V, the junction nodes they meet at and the lines made only of them are set to 0 V (a line
 * still fed through a tee, or from its other end, stays as it is). With `removeTakeOffs` the take-offs left without a
 * circuit are removed (`cascadeDeleteOps`: the in-yard wiring loses them). Pure: returns ops plus a summary.
 */
import {TransmissionVoltage} from '@shared/models/transmission.voltage'
import {
    CIRCUIT_END_FROM,
    CIRCUIT_END_TO,
    CircuitEnd,
    ConnectionJunctionKind,
    ConnectionRecord,
    ConnectionScope,
    NetworkDocument,
    NetworkNodeKind,
    SubstationGroupRecord,
    SubstationRecord,
    SubstationTakeOffRecord,
    TransmissionCircuitRecord,
    TransmissionJunctionRecord,
    TransmissionLineRecord,
} from '@shared/network/records'
import {applyOps, cascadeDeleteOps, NetworkOp} from '@shared/network/ops'
import {connectionOfEnd, recordById} from '@shared/network/lookup'
import {takeOffCircuit} from '@shared/network/refs'
import {newSiteJunctionRecord, siteJunctionOf} from '@shared/network/siteJunction'
import {attachCircuitEndToJunctionOps, detachCircuitEndOps} from './linkOps'

const ENDS: CircuitEnd[] = [CIRCUIT_END_FROM, CIRCUIT_END_TO]

/** A line's end at a take-off: the circuit end leaving through it, in which yard and site, and the line's end it is. */
export interface TakeOffEnd {
    circuit: TransmissionCircuitRecord
    end: CircuitEnd
    connection: ConnectionRecord
    takeOff: SubstationTakeOffRecord
    yard: SubstationRecord
    site: SubstationGroupRecord
    /** The line end (`from` / `to`) this is. */
    lineEnd: 'from' | 'to'
}

/** The ends of a line that leave a yard through a take-off (at most one per line end). */
export function takeOffEndsOf(doc: NetworkDocument, line: TransmissionLineRecord): TakeOffEnd[] {
    const out: TakeOffEnd[] = []
    line.circuitIds.forEach((id, i) => {
        const circuit = recordById(doc.circuits, id)
        if (!circuit) return
        for (const end of ENDS) {
            const connection = connectionOfEnd(doc, id, end)
            if (connection?.junction.kind !== ConnectionJunctionKind.SUBSTATION) continue
            const yard = recordById(doc.substations, connection.junction.id)
            const site = yard && recordById(doc.substationGroups, yard.groupId)
            const node = connection.nodes.find(n => n.kind === NetworkNodeKind.SUBSTATION_TAKE_OFF)
            const takeOff = node && recordById(doc.takeOffs, node.id)
            if (!yard || !site || !takeOff) continue
            // which end of the line: the one naming this yard, else by the section's place in the line
            const lineEnd = line.from?.id === yard.id && line.to?.id !== yard.id ? 'from' : line.to?.id === yard.id && line.from?.id !== yard.id ? 'to'
                : i === 0 && (line.circuitIds.length > 1 || !out.some(x => x.lineEnd === 'from')) ? 'from' : 'to'
            out.push({circuit, end, connection, takeOff, yard, site, lineEnd})
        }
    })
    return out
}

/** The lines leaving a site's yards through take-offs, with their end there. */
export function linesThroughTakeOffs(doc: NetworkDocument, groupId: string): { line: TransmissionLineRecord; here: TakeOffEnd[]; others: TakeOffEnd[] }[] {
    return doc.lines.map(line => {
        const ends = takeOffEndsOf(doc, line)
        return {line, here: ends.filter(e => e.site.id === groupId), others: ends.filter(e => e.site.id !== groupId)}
    }).filter(x => x.here.length > 0).sort((a, b) => a.line.name.localeCompare(b.line.name))
}

export interface DisconnectOptions {
    /** Also disconnect each line's other end from its take-off (into the junction of its site). */
    bothEnds?: boolean
    /** Remove the take-offs left without a circuit. */
    removeTakeOffs?: boolean
}

export interface DisconnectedLine {
    line: TransmissionLineRecord
    /** The ends taken off their take-offs, each now open at its site's junction. */
    ends: (TakeOffEnd & { junction: TransmissionJunctionRecord })[]
    /** Its other end still at a take-off (not disconnected). */
    stillAt?: TakeOffEnd
    /** Fed from no yard any more: de-energized. */
    deEnergized: boolean
}

export interface DisconnectPlan {
    ops: NetworkOp[]
    lines: DisconnectedLine[]
    createdJunctions: TransmissionJunctionRecord[]
    removedTakeOffs: SubstationTakeOffRecord[]
    /** What was set to 0 V. */
    deEnergized: { circuits: TransmissionCircuitRecord[]; connections: ConnectionRecord[]; lines: TransmissionLineRecord[] }
    errors: string[]
}

export function buildDisconnectPlan(doc: NetworkDocument, groupId: string, lineIds: string[], opts: DisconnectOptions = {}): DisconnectPlan {
    const plan: DisconnectPlan = {ops: [], lines: [], createdJunctions: [], removedTakeOffs: [], deEnergized: {circuits: [], connections: [], lines: []}, errors: []}
    const site = recordById(doc.substationGroups, groupId)
    if (!site) return {...plan, errors: ['the site no longer exists']}
    const chosen = linesThroughTakeOffs(doc, groupId).filter(x => lineIds.includes(x.line.id))
    if (!chosen.length) return {...plan, errors: ['check at least one line leaving through a take-off']}

    const ops: NetworkOp[] = []
    let probe = doc
    const push = (...next: NetworkOp[]) => {
        ops.push(...next)
        probe = applyOps(probe, next)
    }
    /** The junction of a site, created once when missing. */
    const junctionOf = (s: SubstationGroupRecord) => {
        let j = siteJunctionOf(probe, s.id)
        if (!j) {
            j = newSiteJunctionRecord(probe, s)
            push({type: 'upsert', collection: 'junctions', record: j})
            plan.createdJunctions.push(j)
        }
        return j
    }
    const freed = new Map<string, SubstationTakeOffRecord>()

    // 1. every chosen line: its end(s) leave the take-off for the site junction, the line ends there
    for (const {line, here, others} of chosen) {
        const ends = [...here, ...(opts.bothEnds ? others : [])]
        const done: DisconnectedLine['ends'] = []
        for (const e of ends) {
            const circuit = recordById(probe.circuits, e.circuit.id)!
            const junction = junctionOf(e.site)
            push(...detachCircuitEndOps(probe, circuit.id, e.end))
            push(...attachCircuitEndToJunctionOps(probe, circuit.id, e.end, junction.id, circuit.energizedVoltage ?? circuit.voltage, {forceNew: true}))
            const current = recordById(probe.lines, line.id)!
            push({type: 'upsert', collection: 'lines', record: {...current, [e.lineEnd]: {kind: ConnectionJunctionKind.TRANSMISSION_JUNCTION, id: junction.id}}})
            if (!takeOffCircuit(probe, e.takeOff.id).line) freed.set(e.takeOff.id, e.takeOff)
            done.push({...e, junction})
        }
        plan.lines.push({line, ends: done, stillAt: opts.bothEnds ? undefined : others[0], deEnergized: false})
    }

    // 2. de-energize what is fed from no yard: the circuits reachable from the line through junction nodes
    const deadCircuits = new Set<string>(), deadNodes = new Set<string>()
    for (const x of plan.lines) {
        const island = new Set<string>(), nodes = new Set<string>()
        const queue = [...x.line.circuitIds]
        let fed = false
        while (queue.length && !fed) {
            const id = queue.pop()!
            if (island.has(id)) continue
            island.add(id)
            for (const end of ENDS) {
                const conn = connectionOfEnd(probe, id, end)
                if (!conn) continue
                if (conn.junction.kind === ConnectionJunctionKind.SUBSTATION) {
                    fed = true
                    break
                }
                nodes.add(conn.id)
                for (const n of conn.nodes) if (n.kind === NetworkNodeKind.TRANSMISSION_CIRCUIT && !island.has(n.id)) queue.push(n.id)
            }
        }
        if (fed) continue
        x.deEnergized = true
        island.forEach(id => deadCircuits.add(id))
        nodes.forEach(id => deadNodes.add(id))
    }
    for (const id of deadCircuits) {
        const c = recordById(probe.circuits, id)!
        if (c.energizedVoltage === TransmissionVoltage.DE_ENERGIZED) continue
        push({type: 'upsert', collection: 'circuits', record: {...c, energizedVoltage: TransmissionVoltage.DE_ENERGIZED}})
        plan.deEnergized.circuits.push(c)
    }
    for (const id of deadNodes) {
        const conn = recordById(probe.connections, id)
        if (!conn || conn.scope !== ConnectionScope.TRANSMISSION || conn.voltage === TransmissionVoltage.DE_ENERGIZED) continue
        push({type: 'upsert', collection: 'connections', record: {...conn, voltage: TransmissionVoltage.DE_ENERGIZED}})
        plan.deEnergized.connections.push(conn)
    }
    for (const l of probe.lines) {
        if (!l.circuitIds.length || !l.circuitIds.every(id => deadCircuits.has(id)) || l.voltage === TransmissionVoltage.DE_ENERGIZED) continue
        push({type: 'upsert', collection: 'lines', record: {...l, voltage: TransmissionVoltage.DE_ENERGIZED}})
        plan.deEnergized.lines.push(l)
    }

    // 3. the take-offs left without a circuit, when asked
    if (opts.removeTakeOffs) for (const t of freed.values()) {
        if (takeOffCircuit(probe, t.id).line) continue
        push(...cascadeDeleteOps(probe, 'takeOffs', t.id))
        plan.removedTakeOffs.push(t)
    }

    plan.ops = ops
    // every circuit end taken off must be connected again (at its site junction)
    for (const x of plan.lines) for (const e of x.ends) {
        const at = connectionOfEnd(probe, e.circuit.id, e.end)
        if (at?.junction.id !== e.junction.id) plan.errors.push(`${e.circuit.name}: its end at ${e.site.groupName} would not be at the site junction`)
    }
    return plan
}
