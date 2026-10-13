/**
 * Transmission lines as groups of circuit sections.
 *
 * Circuits form a graph whose nodes are the TRANSMISSION connections (a
 * take-off node at a yard, a spliced node at a junction) and whose edges
 * are the circuits. A line is a walk through that graph between two ends,
 * each a yard or a junction (a site's own junction or a line junction, where
 * the line stays open or ties in); junction nodes in between are passed,
 * yard nodes are always terminals. Two lines may share a section (a tie):
 * both run from the same end up to the tee where they part.
 *
 * Shared by the editors ("Form a line", line status) and tests.
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
import {endpointToken} from "./naming";

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

/** A place a line through a circuit can end at, on one side of it. */
export interface LineEndCandidate {
    /** The yard or junction of the node it ends at; undefined for a circuit end that is not connected (the line's end stays unset). */
    ref?: ConnectionJunctionRef
    connectionId?: string
    /** The sections from the circuit outward to this end (the circuit itself left out), the fewest there are. */
    chain: string[]
}

/**
 * Every place a line through the circuit can end at, on each side: walking from the circuit's FROM (TO) end through
 * junction nodes, every node reached is one, a yard node or a junction node (a site's own junction or a line junction);
 * a yard ends the walk, a junction is passed on to the circuits beyond. Fewest sections first; a circuit end that is
 * not connected gives a single candidate without a place.
 */
export function lineEndCandidates(doc: NetworkDocument, circuitId: string, graph = buildCircuitGraph(doc)): { from: LineEndCandidate[]; to: LineEndCandidate[] } {
    const ends = graph.ends.get(circuitId)
    const side = (start: string | undefined): LineEndCandidate[] => {
        if (!start) return [{chain: []}]
        const out: LineEndCandidate[] = []
        const seen = new Set([start])
        const queue: { node: string; chain: string[] }[] = [{node: start, chain: []}]
        while (queue.length) {
            const {node, chain} = queue.shift()!
            const conn = graph.nodes.get(node)
            if (!conn) continue
            out.push({ref: conn.junction, connectionId: node, chain})
            if (isYardNode(conn)) continue
            for (const next of graph.circuitsAt.get(node) ?? []) {
                if (next === circuitId || chain.includes(next)) continue
                const far = otherEnd(graph, next, node)
                if (!far || seen.has(far)) continue
                seen.add(far)
                queue.push({node: far, chain: [...chain, next]})
            }
        }
        return out
    }
    return ends ? {from: side(ends[0]), to: side(ends[1])} : {from: [], to: []}
}

export interface FormedLine {
    /** Sections FROM → TO: the FROM side's chain reversed, the circuit, the TO side's chain. */
    circuitIds: string[]
    from?: ConnectionJunctionRef
    to?: ConnectionJunctionRef
    voltage?: TransmissionVoltage
    /** Why these two ends cannot form a line; undefined when they can. */
    problem?: string
    /** Lines through the circuit it would duplicate, lie within or contain (a tie that only shares part is fine). */
    overlaps: TransmissionLineRecord[]
}

/**
 * The line two candidates (one per side, see `lineEndCandidates`) form through the circuit, and whether it may be
 * formed: not when the two ends are the same place or the two sides share a section, nor when it would duplicate, lie
 * within or contain a line that already uses this circuit (lines that only share part, a tie at a tee, are fine).
 */
export function formLine(doc: NetworkDocument, circuitId: string, from: LineEndCandidate, to: LineEndCandidate): FormedLine {
    const circuitIds = [...[...from.chain].reverse(), circuitId, ...to.chain]
    const circuit = doc.circuits.find(c => c.id === circuitId)
    const out: FormedLine = {circuitIds, from: from.ref, to: to.ref, voltage: circuit?.energizedVoltage ?? circuit?.voltage, overlaps: []}
    if (from.ref && to.ref && sameRef(from.ref, to.ref)) out.problem = 'both ends are the same place'
    else if (new Set(circuitIds).size !== circuitIds.length) out.problem = 'the two sides share a section'
    const set = new Set(circuitIds)
    const within = (a: Set<string>, b: string[]) => b.length > 0 && b.every(id => a.has(id))
    out.overlaps = linesOfCircuit(doc, circuitId).filter(l => within(set, l.circuitIds) || within(new Set(l.circuitIds), circuitIds))
    if (!out.problem && out.overlaps.length) {
        const l = out.overlaps[0]
        out.problem = l.circuitIds.length === circuitIds.length ? `already line ${l.name}` : l.circuitIds.length > circuitIds.length ? `within line ${l.name}` : `would contain line ${l.name}: extend that line instead`
    }
    return out
}

/**
 * Where a line most likely starts and ends, from its own sections, for the ends it does not state: FROM is where the
 * first section leaves the line (its end not shared with the second section), TO likewise from the last one; a single
 * section runs FROM → TO along the line unless an end the line states, or else its name (`<kV>_<from>_<to>_L<n>` naming
 * both places the other way round), says otherwise. A yard or a junction; an end
 * stays unset when that section end is not connected, or when the sections do not tell (not joined, or a loop).
 * Ends the line states are kept.
 */
export function guessLineEnds(doc: NetworkDocument, line: TransmissionLineRecord, graph = buildCircuitGraph(doc)): { from?: ConnectionJunctionRef; to?: ConnectionJunctionRef } {
    const ids = line.circuitIds.filter(id => graph.ends.has(id))
    if (!ids.length) return {from: line.from, to: line.to}
    const placeOf = (connId?: string) => connId ? graph.nodes.get(connId)?.junction : undefined
    /** The end of a section that its neighbour in the line does not share. */
    const outer = (id: string, neighbour: string): string | undefined => {
        const [a, b] = graph.ends.get(id)!
        const n = graph.ends.get(neighbour) ?? [undefined, undefined]
        const atA = !!a && n.includes(a), atB = !!b && n.includes(b)
        return atA && !atB ? b : atB && !atA ? a : undefined
    }
    let fromConn: string | undefined, toConn: string | undefined
    if (ids.length === 1) {
        const [a, b] = graph.ends.get(ids[0])!
        // a stated end tells which way the line reads; without one, the order its name gives the two places
        const named = (connId?: string) => {
            const token = endpointToken(doc, placeOf(connId), 'site')
            return token ? `_${line.name}_`.indexOf(`_${token}_`) : -1
        }
        const reversed = line.from || line.to
            ? (!!line.from && sameRef(placeOf(b), line.from)) || (!!line.to && sameRef(placeOf(a), line.to))
            : named(a) >= 0 && named(b) >= 0 && named(b) < named(a)
        ;[fromConn, toConn] = reversed ? [b, a] : [a, b]
    } else {
        fromConn = outer(ids[0], ids[1])
        toConn = outer(ids[ids.length - 1], ids[ids.length - 2])
    }
    const from = line.from ?? placeOf(fromConn), to = line.to ?? placeOf(toConn)
    // never guess both ends into one place
    if (from && to && sameRef(from, to)) return {from: line.from, to: line.to}
    return {from, to}
}

/** Lines missing an end, each with the ends guessed from its sections (`guessLineEnds`); `filled` lists the ends it gets. */
export function fillLineEnds(doc: NetworkDocument, graph = buildCircuitGraph(doc)): { line: TransmissionLineRecord; updated: TransmissionLineRecord; filled: ('from' | 'to')[] }[] {
    return doc.lines.filter(l => !l.from || !l.to).map(line => {
        const guess = guessLineEnds(doc, line, graph)
        const filled = (['from', 'to'] as const).filter(end => !line[end] && guess[end])
        return {line, updated: {...line, ...(guess.from ? {from: guess.from} : {}), ...(guess.to ? {to: guess.to} : {})}, filled}
    })
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
        !line.from ? 'no FROM end' : st.fromMismatch ? 'first section does not reach FROM' : '',
        !line.to ? 'no TO end' : st.toMismatch ? 'last section does not reach TO' : '',
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
