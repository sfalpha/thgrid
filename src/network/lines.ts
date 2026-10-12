/**
 * Transmission lines as groups of circuit sections.
 *
 * Circuits form a graph whose nodes are the TRANSMISSION connections (a
 * take-off node at a yard, a spliced node at a junction) and whose edges
 * are the circuits. A line is a walk through that graph from one yard to
 * another; junction nodes are passed, yard nodes are terminals. Two lines
 * may share a section (a tie): both run from the same yard up to the tee
 * where they part.
 *
 * Shared by the editors (hint "group into a line", line status) and tests.
 */
import {
    CIRCUIT_END_FROM,
    CIRCUIT_END_TO,
    ConnectionJunctionKind,
    ConnectionJunctionRef,
    ConnectionRecord,
    ConnectionScope,
    NetworkDocument,
    NetworkNodeKind,
    TransmissionLineRecord,
} from "./records";
import {TransmissionVoltage} from "../models/transmission.voltage";

export interface CircuitGraph {
    /** TRANSMISSION connections by id. */
    nodes: Map<string, ConnectionRecord>
    /** Connection id → circuits with an end there. */
    circuitsAt: Map<string, string[]>
    /** Circuit id → connection ids of its FROM and TO ends (undefined when loose). */
    ends: Map<string, [string | undefined, string | undefined]>
}

export function buildCircuitGraph(doc: NetworkDocument): CircuitGraph {
    const nodes = new Map<string, ConnectionRecord>()
    const circuitsAt = new Map<string, string[]>()
    const ends = new Map<string, [string | undefined, string | undefined]>()
    for (const c of doc.circuits) ends.set(c.id, [undefined, undefined])
    for (const conn of doc.connections) {
        if (conn.scope !== ConnectionScope.TRANSMISSION) continue
        nodes.set(conn.id, conn)
        for (const n of conn.nodes) {
            if (n.kind !== NetworkNodeKind.TRANSMISSION_CIRCUIT) continue
            const e = ends.get(n.id)
            if (!e) continue
            if (n.terminal === CIRCUIT_END_FROM) e[0] = conn.id
            else if (n.terminal === CIRCUIT_END_TO) e[1] = conn.id
            const list = circuitsAt.get(conn.id) ?? []
            if (!list.includes(n.id)) list.push(n.id)
            circuitsAt.set(conn.id, list)
        }
    }
    return {nodes, circuitsAt, ends}
}

export const isYardNode = (conn: ConnectionRecord | undefined): boolean => conn?.junction.kind === ConnectionJunctionKind.SUBSTATION

/** The connection at the other end of a circuit, seen from `connectionId`. */
function otherEnd(graph: CircuitGraph, circuitId: string, connectionId: string): string | undefined {
    const e = graph.ends.get(circuitId)
    if (!e) return undefined
    return e[0] === connectionId ? e[1] : e[0]
}

export interface CircuitGroup {
    /** Every circuit reachable from the start through junction nodes. */
    circuitIds: string[]
    /** Yard nodes the group touches: where a line through it can start or end. */
    terminals: { connectionId: string; ref: ConnectionJunctionRef }[]
    /** Junction nodes passed. */
    junctionNodeIds: string[]
    /** Circuit ends that are not connected anywhere. */
    looseEnds: number
}

/** Circuits electrically joined with `circuitId` through junction nodes (a yard ends the walk). */
export function connectedCircuitGroup(doc: NetworkDocument, circuitId: string, graph = buildCircuitGraph(doc)): CircuitGroup {
    const visited = new Set<string>()
    const terminals = new Map<string, ConnectionJunctionRef>()
    const junctionNodeIds = new Set<string>()
    let looseEnds = 0
    const queue = [circuitId]
    while (queue.length) {
        const id = queue.shift()!
        if (visited.has(id) || !graph.ends.has(id)) continue
        visited.add(id)
        for (const connId of graph.ends.get(id)!) {
            if (!connId) {
                looseEnds++
                continue
            }
            const conn = graph.nodes.get(connId)
            if (!conn) continue
            if (isYardNode(conn)) {
                terminals.set(connId, conn.junction)
                continue
            }
            junctionNodeIds.add(connId)
            for (const other of graph.circuitsAt.get(connId) ?? []) if (!visited.has(other)) queue.push(other)
        }
    }
    return {
        circuitIds: [...visited],
        terminals: [...terminals].map(([connectionId, ref]) => ({connectionId, ref})),
        junctionNodeIds: [...junctionNodeIds],
        looseEnds,
    }
}

/**
 * Shortest chain of circuits from one node to another, passing junction
 * nodes only (a yard in the middle would be another line). Undefined when
 * the nodes are not joined.
 */
export function routeBetween(doc: NetworkDocument, fromConnectionId: string, toConnectionId: string, graph = buildCircuitGraph(doc)): string[] | undefined {
    if (fromConnectionId === toConnectionId) return []
    const prev = new Map<string, { node: string; circuit: string }>()
    const seen = new Set([fromConnectionId])
    const queue = [fromConnectionId]
    while (queue.length) {
        const node = queue.shift()!
        for (const circuit of graph.circuitsAt.get(node) ?? []) {
            const next = otherEnd(graph, circuit, node)
            if (!next || seen.has(next)) continue
            seen.add(next)
            prev.set(next, {node, circuit})
            if (next === toConnectionId) {
                const route: string[] = []
                for (let at = next; at !== fromConnectionId;) {
                    const p = prev.get(at)!
                    route.unshift(p.circuit)
                    at = p.node
                }
                return route
            }
            if (!isYardNode(graph.nodes.get(next))) queue.push(next)
        }
    }
    return undefined
}

export interface LineProposal {
    circuitIds: string[]
    from: ConnectionJunctionRef
    to: ConnectionJunctionRef
    voltage?: TransmissionVoltage
    /** A line with exactly these sections and ends already exists. */
    existingLineId?: string
}

const sameRef = (a?: ConnectionJunctionRef, b?: ConnectionJunctionRef) => !!a && !!b && a.kind === b.kind && a.id === b.id

/** The line that the chain of circuits from one yard node to another would form, if the two are joined. */
export function proposeLine(doc: NetworkDocument, fromConnectionId: string, toConnectionId: string, graph = buildCircuitGraph(doc)): LineProposal | undefined {
    const from = graph.nodes.get(fromConnectionId), to = graph.nodes.get(toConnectionId)
    if (!from || !to || !isYardNode(from) || !isYardNode(to)) return undefined
    const circuitIds = routeBetween(doc, fromConnectionId, toConnectionId, graph)
    if (!circuitIds || circuitIds.length === 0) return undefined
    const first = doc.circuits.find(c => c.id === circuitIds[0])
    const set = new Set(circuitIds)
    const existing = doc.lines.find(l => l.circuitIds.length === set.size && l.circuitIds.every(id => set.has(id))
        && ((sameRef(l.from, from.junction) && sameRef(l.to, to.junction)) || (sameRef(l.from, to.junction) && sameRef(l.to, from.junction))))
    return {circuitIds, from: from.junction, to: to.junction, voltage: first?.energizedVoltage ?? first?.voltage, existingLineId: existing?.id}
}

/**
 * Every yard-to-yard line the circuit could be a section of: one proposal
 * per pair of yards its group touches whose route runs through the circuit.
 * Empty when the circuit is not joined substation to substation.
 */
export function proposalsForCircuit(doc: NetworkDocument, circuitId: string, graph = buildCircuitGraph(doc)): LineProposal[] {
    const group = connectedCircuitGroup(doc, circuitId, graph)
    const out: LineProposal[] = []
    for (let i = 0; i < group.terminals.length; i++) {
        for (let k = i + 1; k < group.terminals.length; k++) {
            const p = proposeLine(doc, group.terminals[i].connectionId, group.terminals[k].connectionId, graph)
            if (p && p.circuitIds.includes(circuitId)) out.push(p)
        }
    }
    // Not yet grouped first, then shorter lines first.
    return out.sort((a, b) => Number(!!a.existingLineId) - Number(!!b.existingLineId) || a.circuitIds.length - b.circuitIds.length)
}

export function linesOfCircuit(doc: NetworkDocument, circuitId: string): TransmissionLineRecord[] {
    return doc.lines.filter(l => l.circuitIds.includes(circuitId))
}

/** Sections of a line ordered by walking from its FROM end; sections that cannot be reached are appended in their stored order. */
export function orderLineCircuits(doc: NetworkDocument, line: TransmissionLineRecord, graph = buildCircuitGraph(doc)): string[] {
    const remaining = new Set(line.circuitIds)
    const ordered: string[] = []
    // start node: the yard node of line.from among the sections' ends, else the first section's FROM end
    let at: string | undefined
    for (const id of line.circuitIds) {
        for (const connId of graph.ends.get(id) ?? []) {
            const conn = connId && graph.nodes.get(connId)
            if (conn && line.from && sameRef(conn.junction, line.from)) at = connId
        }
        if (at) break
    }
    if (!at) at = graph.ends.get(line.circuitIds[0] ?? '')?.[0]
    while (at) {
        const next = (graph.circuitsAt.get(at) ?? []).find(id => remaining.has(id))
        if (!next) break
        remaining.delete(next)
        ordered.push(next)
        at = otherEnd(graph, next, at)
    }
    return [...ordered, ...line.circuitIds.filter(id => remaining.has(id))]
}

export interface LineStatus {
    /** Section ids that are not circuits of the document. */
    missing: string[]
    /** Consecutive sections do not share a node. */
    notContiguous: boolean
    /** `from` is set but the first section does not end at that yard (same for `to` and the last section). */
    fromMismatch: boolean
    toMismatch: boolean
    empty: boolean
}

export function lineStatus(doc: NetworkDocument, line: TransmissionLineRecord, graph = buildCircuitGraph(doc)): LineStatus {
    const missing = line.circuitIds.filter(id => !graph.ends.has(id))
    const ids = line.circuitIds.filter(id => graph.ends.has(id))
    const endsOf = (id: string): string[] => {
        const e = graph.ends.get(id)
        return e ? e.filter((x): x is string => !!x) : []
    }
    let notContiguous = false
    for (let i = 1; i < ids.length; i++) {
        const a = endsOf(ids[i - 1]), b = endsOf(ids[i])
        if (!a.some(x => b.includes(x))) notContiguous = true
    }
    const touches = (id: string | undefined, ref?: ConnectionJunctionRef) => !id || !ref || endsOf(id).some(connId => sameRef(graph.nodes.get(connId)?.junction, ref))
    return {
        missing,
        notContiguous,
        fromMismatch: !touches(ids[0], line.from),
        toMismatch: !touches(ids[ids.length - 1], line.to),
        empty: line.circuitIds.length === 0,
    }
}

/** Short attention markers for lists. */
export function lineWarnings(doc: NetworkDocument, line: TransmissionLineRecord, graph = buildCircuitGraph(doc)): string[] {
    const st = lineStatus(doc, line, graph)
    return [
        st.empty ? 'no sections' : '',
        st.missing.length ? `${st.missing.length} unknown section${st.missing.length === 1 ? '' : 's'}` : '',
        st.notContiguous ? 'sections not joined' : '',
        !line.from ? 'no FROM yard' : st.fromMismatch ? 'first section does not reach FROM' : '',
        !line.to ? 'no TO yard' : st.toMismatch ? 'last section does not reach TO' : '',
    ].filter(Boolean)
}

/** Circuits that share a node with the first or last section of the line and are not sections yet. */
export function lineExtensionCandidates(doc: NetworkDocument, line: TransmissionLineRecord, graph = buildCircuitGraph(doc)): string[] {
    if (!line.circuitIds.length) return doc.circuits.map(c => c.id)
    const edges = [line.circuitIds[0], line.circuitIds[line.circuitIds.length - 1]].filter((x): x is string => !!x)
    const out = new Set<string>()
    for (const id of edges) for (const connId of graph.ends.get(id) ?? []) {
        if (!connId) continue
        for (const other of graph.circuitsAt.get(connId) ?? []) if (!line.circuitIds.includes(other)) out.add(other)
    }
    return [...out]
}
