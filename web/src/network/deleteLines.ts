/**
 * Deleting transmission lines together with what only they use.
 *
 * A line is a chain of circuit sections; the sections end at take-offs
 * (yards) and are joined at junctions in connections (electrical nodes).
 * `buildDeleteLinesPlan` removes the lines and, when `deep`, every circuit
 * used by no other line, every connection that would be left without a
 * circuit end and every take-off of such a connection. A connection still
 * carrying a circuit of another line (or one outside any line) is kept with
 * the deleted ends removed, and so is its take-off. Paths left without
 * circuits are kept (the Paths tab has "Delete unused"). Pure: returns ops.
 */
import {
    ConnectionRecord,
    NetworkDocument,
    NetworkNodeKind,
    SubstationTakeOffRecord,
    TransmissionCircuitRecord,
    TransmissionLineRecord,
    TransmissionPathRecord,
} from '@shared/network/records'
import {applyOps, cascadeDeleteOps, emptyLinesOps, NetworkOp} from '@shared/network/ops'

export interface DeleteLinesPlan {
    ops: NetworkOp[]
    lines: TransmissionLineRecord[]
    /** Circuits deleted: sections used by the deleted lines only. */
    circuits: TransmissionCircuitRecord[]
    /** Sections kept because another line still uses them. */
    sharedCircuits: { circuit: TransmissionCircuitRecord; lines: TransmissionLineRecord[] }[]
    /** Take-offs deleted: their connection carried no other circuit. */
    takeOffs: SubstationTakeOffRecord[]
    /** Take-offs kept: their connection still carries another circuit. */
    keptTakeOffs: SubstationTakeOffRecord[]
    /** Connections deleted: no circuit end left in them. */
    connections: ConnectionRecord[]
    /** Connections kept with the deleted ends removed. */
    trimmedConnections: ConnectionRecord[]
    /** Paths left without circuits (kept). */
    emptyPaths: TransmissionPathRecord[]
}

export function buildDeleteLinesPlan(doc: NetworkDocument, lineIds: string[], opts: { deep: boolean }): DeleteLinesPlan {
    const ids = new Set(lineIds)
    const lines = doc.lines.filter(l => ids.has(l.id))
    const plan: DeleteLinesPlan = {ops: [], lines, circuits: [], sharedCircuits: [], takeOffs: [], keptTakeOffs: [], connections: [], trimmedConnections: [], emptyPaths: []}
    if (!opts.deep) {
        for (const l of lines) plan.ops.push(...cascadeDeleteOps(doc, 'lines', l.id))
        return plan
    }

    // 1. circuits: a section used by a line that stays is kept
    const candidateIds = [...new Set(lines.flatMap(l => l.circuitIds))]
    const doomed = new Set<string>()
    for (const id of candidateIds) {
        const circuit = doc.circuits.find(c => c.id === id)
        if (!circuit) continue
        const others = doc.lines.filter(l => !ids.has(l.id) && l.circuitIds.includes(id))
        if (others.length) plan.sharedCircuits.push({circuit, lines: others})
        else {
            doomed.add(id)
            plan.circuits.push(circuit)
        }
    }

    // 2. connections holding an end of a doomed circuit: deleted when no circuit end remains, else trimmed
    const isDoomedEnd = (n: ConnectionRecord['nodes'][number]) => n.kind === NetworkNodeKind.TRANSMISSION_CIRCUIT && doomed.has(n.id)
    const takeOffIds = new Set<string>()
    const keptTakeOffIds = new Set<string>()
    for (const conn of doc.connections) {
        if (!conn.nodes.some(isDoomedEnd)) continue
        const remaining = conn.nodes.filter(n => !isDoomedEnd(n))
        const stillUsed = remaining.some(n => n.kind === NetworkNodeKind.TRANSMISSION_CIRCUIT)
        const takeOffsHere = remaining.filter(n => n.kind === NetworkNodeKind.SUBSTATION_TAKE_OFF).map(n => n.id)
        if (stillUsed) {
            plan.trimmedConnections.push({...conn, nodes: remaining})
            plan.ops.push({type: 'upsert', collection: 'connections', record: {...conn, nodes: remaining}})
            takeOffsHere.forEach(id => keptTakeOffIds.add(id))
        } else {
            plan.connections.push(conn)
            plan.ops.push({type: 'delete', collection: 'connections', id: conn.id})
            takeOffsHere.forEach(id => takeOffIds.add(id))
        }
    }
    for (const id of takeOffIds) {
        const t = doc.takeOffs.find(x => x.id === id)
        if (t) plan.takeOffs.push(t)
    }
    for (const id of keptTakeOffIds) {
        const t = doc.takeOffs.find(x => x.id === id)
        if (t) plan.keptTakeOffs.push(t)
    }

    // 3. the rest: circuits, take-offs, lines (connections are already settled above, so plain deletes are consistent)
    for (const c of plan.circuits) plan.ops.push({type: 'delete', collection: 'circuits', id: c.id})
    for (const t of plan.takeOffs) plan.ops.push({type: 'delete', collection: 'takeOffs', id: t.id})
    for (const l of lines) plan.ops.push({type: 'delete', collection: 'lines', id: l.id})

    const pathIds = new Set(plan.circuits.map(c => c.pathId))
    for (const p of doc.paths) {
        if (!pathIds.has(p.id)) continue
        if (!doc.circuits.some(c => c.pathId === p.id && !doomed.has(c.id))) plan.emptyPaths.push(p)
    }
    return plan
}

/**
 * Lines that would be gone after the ops: deleted by them, or left without
 * circuits (which `NetworkEditor.apply` removes in the same step).
 */
export function linesRemovedBy(doc: NetworkDocument, ops: NetworkOp[]): TransmissionLineRecord[] {
    try {
        const after = applyOps(doc, ops)
        const left = new Set(applyOps(after, emptyLinesOps(after)).lines.map(l => l.id))
        // follow renames (`renameRecordOps`: the same record upserted under a new id, then the old id deleted)
        const current = new Map(doc.lines.map(l => [l.id, l.id]))
        const lines = new Map(doc.lines.map(l => [l.id, l]))
        const content = (l: TransmissionLineRecord) => JSON.stringify({...l, id: ''})
        for (const op of ops) {
            if (op.type === 'delete' && op.collection === 'lines') lines.delete(op.id)
            if (op.type !== 'upsert' || op.collection !== 'lines') continue
            const record = op.record as TransmissionLineRecord
            if (!lines.has(record.id)) {
                const same = content(record)
                const from = [...lines.values()].find(l => content(l) === same)
                if (from) for (const [origin, id] of current) if (id === from.id) current.set(origin, record.id)
            }
            lines.set(record.id, record)
        }
        return doc.lines.filter(l => !left.has(current.get(l.id) ?? l.id))
    } catch {
        return []
    }
}

/** The sentence a confirmation adds about lines an operation removes ('' when none). */
export function linesRemovedNote(lines: TransmissionLineRecord[]): string {
    if (!lines.length) return ''
    return `\n\nThis also removes ${lines.length === 1 ? `line ${lines[0].name}` : `${lines.length} lines (${lines.map(l => l.name).join(', ')})`}: no circuits would be left in ${lines.length === 1 ? 'it' : 'them'}.`
}

/** Text of what a deep delete removes and keeps, for the confirmation dialog. */
export function describeDeleteLinesPlan(plan: DeleteLinesPlan): string {
    const list = (xs: string[]) => xs.length > 6 ? `${xs.slice(0, 6).join(', ')} … (+${xs.length - 6})` : xs.join(', ')
    const out: string[] = []
    out.push(`• ${plan.circuits.length} circuit(s): ${list(plan.circuits.map(c => c.name)) || '–'}`)
    out.push(`• ${plan.takeOffs.length} take-off(s): ${list(plan.takeOffs.map(t => t.lineName)) || '–'}`)
    out.push(`• ${plan.connections.length} connection(s)${plan.connections.length ? `: ${list(plan.connections.map(c => c.name ?? c.id))}` : ''}`)
    const kept: string[] = []
    if (plan.sharedCircuits.length) kept.push(`circuit(s) ${list(plan.sharedCircuits.map(s => `${s.circuit.name} (line ${s.lines.map(l => l.name).join(', ')})`))}`)
    if (plan.trimmedConnections.length) kept.push(`connection(s) ${list(plan.trimmedConnections.map(c => c.name ?? c.id))} still used by other circuits`)
    if (plan.keptTakeOffs.length) kept.push(`take-off(s) ${list(plan.keptTakeOffs.map(t => t.lineName))}`)
    if (kept.length) out.push(`Kept (still in use): ${kept.join('; ')}`)
    if (plan.emptyPaths.length) out.push(`${plan.emptyPaths.length} path(s) left without circuits are kept (Paths tab › Delete unused).`)
    return out.join('\n')
}

/**
 * Asks how to delete the lines: everything only they use (OK), only the
 * lines themselves (Cancel, then OK), or nothing. Returns the ops to apply,
 * or undefined when the user backed out.
 */
export function confirmDeleteLines(doc: NetworkDocument, lineIds: string[]): NetworkOp[] | undefined {
    const deep = buildDeleteLinesPlan(doc, lineIds, {deep: true})
    if (!deep.lines.length) return undefined
    const names = deep.lines.map(l => l.name).join(', ')
    const what = deep.lines.length === 1 ? `line ${names}` : `${deep.lines.length} lines (${names})`
    if (window.confirm(`Delete ${what} together with the circuits, take-offs and connections only it uses?\n\n${describeDeleteLinesPlan(deep)}\n\nOK: delete all of the above · Cancel: choose to remove only the line`)) return deep.ops
    if (window.confirm(`Remove only ${what}? Its circuits, take-offs and connections are kept.`)) return buildDeleteLinesPlan(doc, lineIds, {deep: false}).ops
    return undefined
}
