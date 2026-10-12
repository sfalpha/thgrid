/**
 * Per-bay auto wiring of a yard's single-line diagram.
 *
 * `wireBayOps` joins everything stacked in one bay: in the bay column the
 * buses, equipment and (unflagged) take-offs are chained in row order, each
 * item's top terminal to the bottom terminal of the item above it. The
 * equipment of the bay's take-off column is chained per take-off the same
 * way, and that chain is tied to the bay column at the point where two
 * disconnecting switches meet (the nearest such point when there are
 * several). Without such a point the chain stays unattached; with several
 * take-offs in the column and no point for one of them nothing in the column
 * is wired and an error is reported.
 *
 * `unwireBayOps` removes the bay's nodes from every yard connection, deleting
 * connections left with fewer than two nodes.
 */
import {SubstationEquipmentType} from '@shared/models/substation.equipment'
import {
    ConnectionJunctionKind,
    ConnectionRecord,
    ConnectionScope,
    NetworkDocument,
    NetworkNodeKind,
    NetworkNodeRef,
    nodeKey,
    sameNode,
    SubstationEquipmentRecord,
    SubstationTakeOffRecord,
} from '@shared/network/records'
import {NetworkOp} from '@shared/network/ops'
import {yardWiringNaming} from '@shared/network/naming'

export interface WirePlan {
    ops: NetworkOp[]
    /** Problems that stopped part of the wiring. */
    errors: string[]
    /** Node groups that were joined, in order (for messages and tests). */
    joined: NetworkNodeRef[][]
    /** Where each line-column chain was tied into the bay column, by take-off id (`bay:<id>` for line-side equipment without a take-off). */
    attached: Record<string, string>
}

/** An item of a column: one node per side, so chaining joins `top` of the lower item with `bottom` of the upper one. */
interface StackItem {
    key: string
    label: string
    row: number
    kind: 'bus' | 'equipment' | 'takeOff'
    type?: SubstationEquipmentType
    top: NetworkNodeRef
    bottom: NetworkNodeRef
    /** A single node (bus, take-off, one-terminal device): both neighbours join it, so the chain runs through it. */
    single: boolean
}

const eqNode = (e: SubstationEquipmentRecord, i: number): NetworkNodeRef => ({kind: NetworkNodeKind.EQUIPMENT_TERMINAL, id: e.id, terminal: e.terminals[i].key})

function equipmentItem(e: SubstationEquipmentRecord): StackItem | undefined {
    if (e.terminals.length === 0) return undefined
    const single = e.terminals.length === 1
    return {key: e.id, label: e.code, row: e.row, kind: 'equipment', type: e.equipmentType, top: eqNode(e, 0), bottom: single ? eqNode(e, 0) : eqNode(e, 1), single}
}

function takeOffItem(t: SubstationTakeOffRecord, row: number): StackItem {
    const node: NetworkNodeRef = {kind: NetworkNodeKind.SUBSTATION_TAKE_OFF, id: t.id}
    return {key: t.id, label: t.lineName, row, kind: 'takeOff', top: node, bottom: node, single: true}
}

/** Working set of a yard's SUBSTATION connections; `join` merges like the editor's Connect mode and `ops` diffs against the document. */
class Wiring {
    private conns: ConnectionRecord[]
    private readonly original: Map<string, ConnectionRecord>
    private seq = 0

    constructor(private readonly doc: NetworkDocument, private readonly yardId: string, private readonly linked: Set<string>) {
        this.conns = doc.connections.filter(c => c.scope === ConnectionScope.SUBSTATION && c.junction.id === yardId)
        this.original = new Map(this.conns.map(c => [c.id, c]))
    }

    /** Joins the nodes into one connection: the connections already holding any of the (non-bus) nodes are merged, else a new one is made. Nodes in a yard link are left out. */
    join(nodes: NetworkNodeRef[]): NetworkNodeRef[] | undefined {
        const wanted: NetworkNodeRef[] = []
        for (const n of nodes) if (!this.linked.has(nodeKey(n)) && !wanted.some(w => sameNode(w, n))) wanted.push(n)
        if (wanted.length < 2) return undefined
        const hits = this.conns.filter(c => c.nodes.some(n => n.kind !== NetworkNodeKind.SUBSTATION_BUS && wanted.some(w => sameNode(w, n))))
        if (hits.length === 0) {
            const id = this.newId()
            this.conns.push({id, scope: ConnectionScope.SUBSTATION, junction: {kind: ConnectionJunctionKind.SUBSTATION, id: this.yardId}, nodes: wanted})
            return wanted
        }
        const [head, ...rest] = hits
        const merged = [...head.nodes]
        for (const n of [...rest.flatMap(c => c.nodes), ...wanted]) if (!merged.some(m => sameNode(m, n))) merged.push(n)
        if (rest.length === 0 && merged.length === head.nodes.length) return undefined
        this.conns = this.conns.filter(c => !rest.includes(c)).map(c => c === head ? {...c, nodes: merged} : c)
        return wanted
    }

    /** Connection currently holding a node (buses excluded). */
    holding(node: NetworkNodeRef): ConnectionRecord | undefined {
        return node.kind === NetworkNodeKind.SUBSTATION_BUS ? undefined : this.conns.find(c => c.nodes.some(n => sameNode(n, node)))
    }

    private newId(): string {
        const used = new Set<string>()
        for (const c of ['connections', 'buses', 'bays', 'equipments', 'takeOffs', 'substations', 'yardConnections'] as const) for (const r of this.doc[c] ?? []) used.add(r.id)
        for (const c of this.conns) used.add(c.id)
        const base = yardWiringNaming(this.doc, this.yardId).id.replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^[_.-]+/, '') || 'X'
        for (let n = ++this.seq; ; n++) {
            const candidate = n === 1 ? base : `${base}_${n}`
            if (!used.has(candidate)) {
                this.seq = n
                return candidate
            }
        }
    }

    ops(): NetworkOp[] {
        const out: NetworkOp[] = []
        const now = new Set(this.conns.map(c => c.id))
        for (const c of this.conns) if (this.original.get(c.id) !== c) out.push({type: 'upsert', collection: 'connections', record: c})
        for (const id of this.original.keys()) if (!now.has(id)) out.push({type: 'delete', collection: 'connections', id})
        return out
    }
}

/** Nodes of yard links (never rewired by auto wiring). */
function linkedNodeKeys(doc: NetworkDocument): Set<string> {
    const s = new Set<string>()
    for (const l of doc.yardConnections ?? []) for (const n of l.nodes) if (n.kind !== NetworkNodeKind.SUBSTATION_BUS) s.add(nodeKey(n))
    return s
}

/** Chains the items (sorted by row) pairwise; single-node items join both of their neighbours' links. Returns the node groups to join, lowest first, with the row level of each. */
function chain(items: StackItem[]): { nodes: NetworkNodeRef[]; level: number; lower: StackItem; upper: StackItem }[] {
    const sorted = [...items].sort((a, b) => a.row - b.row)
    const out: { nodes: NetworkNodeRef[]; level: number; lower: StackItem; upper: StackItem }[] = []
    for (let i = 0; i + 1 < sorted.length; i++) {
        const lower = sorted[i], upper = sorted[i + 1]
        if (lower.kind === 'bus' && upper.kind === 'bus') continue
        out.push({nodes: [lower.top, upper.bottom], level: (lower.row + upper.row) / 2, lower, upper})
    }
    return out
}

export function wireBayOps(doc: NetworkDocument, bayId: string): WirePlan {
    const plan: WirePlan = {ops: [], errors: [], joined: [], attached: {}}
    const bay = doc.bays.find(b => b.id === bayId)
    if (!bay) return plan
    const yardId = bay.substationId
    const wiring = new Wiring(doc, yardId, linkedNodeKeys(doc))
    const join = (nodes: NetworkNodeRef[]) => {
        const j = wiring.join(nodes)
        if (j) plan.joined.push(j)
    }

    const bayTakeOffs = doc.takeOffs.filter(t => t.substationId === yardId && t.bayId === bayId)
    const takeOffRow = (t: SubstationTakeOffRecord) => t.row ?? Math.max(0, ...doc.equipments.filter(e => e.bayId === bayId).map(e => e.row)) + 1
    /** Bay of the take-off an equipment is attached to (undefined when it has none or the take-off is unknown). */
    const takeOffBay = (e: SubstationEquipmentRecord) => e.takeOffId ? doc.takeOffs.find(t => t.id === e.takeOffId)?.bayId : undefined
    const bayEquipment = doc.equipments.filter(e => e.substationId === yardId && (takeOffBay(e) ?? e.bayId) === bayId)
    /** Drawn in the line column: attached to a take-off, or flagged line side (a power transformer, line-side gear without a take-off). */
    const inLineColumn = (e: SubstationEquipmentRecord) => takeOffBay(e) !== undefined || !!e.lineSide

    // the bay column: buses, equipment not flagged for the take-off column, take-offs drawn in the bay column
    const column: StackItem[] = []
    for (const b of doc.buses.filter(b => b.substationId === yardId)) {
        const node: NetworkNodeRef = {kind: NetworkNodeKind.SUBSTATION_BUS, id: b.id}
        column.push({key: b.id, label: b.name ?? `bus ${b.busNumber ?? b.id}`, row: b.row, kind: 'bus', top: node, bottom: node, single: true})
    }
    for (const e of bayEquipment) if (!inLineColumn(e)) {
        const item = equipmentItem(e)
        if (item) column.push(item)
    }
    for (const t of bayTakeOffs) if (!t.takeOffColumn) column.push(takeOffItem(t, takeOffRow(t)))
    const columnLinks = chain(column)
    for (const l of columnLinks) join(l.nodes)

    // attachment points: where two disconnecting switches meet in the bay column
    const isDs = (i: StackItem) => i.type === SubstationEquipmentType.DISCONNECTING_SWITCH
    const points = columnLinks.filter(l => isDs(l.lower) && isDs(l.upper))

    // the line column: one chain per flagged take-off (its equipment by `takeOffId`); line-side equipment without a take-off
    // (a transformer bay) joins the first take-off's chain, or forms a chain of its own when the bay has no take-off
    const loose = bayEquipment.filter(e => inLineColumn(e) && takeOffBay(e) === undefined).map(equipmentItem).filter((i): i is StackItem => !!i)
    const groupOf = (items: StackItem[], key: string, label: string) => {
        const rows = items.map(i => i.row)
        return {key, label, items, min: Math.min(...rows), max: Math.max(...rows)}
    }
    const flaggedTakeOffs = bayTakeOffs.filter(t => t.takeOffColumn)
    const groups = flaggedTakeOffs.map((t, i) => groupOf(
        [takeOffItem(t, takeOffRow(t)), ...bayEquipment.filter(e => e.takeOffId === t.id).map(equipmentItem).filter((x): x is StackItem => !!x), ...(i === 0 ? loose : [])],
        t.id, `take-off ${t.lineName}`))
    if (!flaggedTakeOffs.length && loose.length) groups.push(groupOf(loose, `bay:${bayId}`, 'the line-side equipment'))
    groups.sort((a, b) => a.min - b.min)
    if (groups.length === 0) {
        plan.ops = wiring.ops()
        return plan
    }

    // nearest free attachment point of each chain; a chain without one is left unattached (alone) or stops the column (several chains)
    const taken = new Set<number>()
    const choice = groups.map(g => {
        const mid = (g.min + g.max) / 2
        let best = -1
        for (let i = 0; i < points.length; i++) if (!taken.has(i) && (best < 0 || Math.abs(points[i].level - mid) < Math.abs(points[best].level - mid))) best = i
        if (best >= 0) taken.add(best)
        return best
    })
    const bayLabel = `bay ${bay.bayNumber}`
    if (groups.length > 1 && choice.some(c => c < 0)) {
        const missing = groups.filter((_, i) => choice[i] < 0).map(g => g.label)
        plan.errors.push(`${bayLabel}: no free point where two disconnecting switches meet for ${missing.join(', ')} (${points.length} such point${points.length === 1 ? '' : 's'}, ${groups.length} chains in the line column); nothing in the line column was wired`)
        plan.ops = wiring.ops()
        return plan
    }
    groups.forEach((g, gi) => {
        const links = chain(g.items)
        for (const l of links) join(l.nodes)
        const point = choice[gi] >= 0 ? points[choice[gi]] : undefined
        if (!point) {
            plan.errors.push(`${bayLabel}: ${g.label} is not tied to the bay column: no point where two disconnecting switches meet`)
            return
        }
        // the chain's end or gap nearest the point: bottom of the lowest item, top of the highest, or the link between two items
        const sorted = [...g.items].sort((a, b) => a.row - b.row)
        const candidates: { level: number; nodes: NetworkNodeRef[] }[] = [
            {level: sorted[0].row - 0.5, nodes: [sorted[0].bottom]},
            {level: sorted[sorted.length - 1].row + 0.5, nodes: [sorted[sorted.length - 1].top]},
            ...links.map(l => ({level: l.level, nodes: l.nodes})),
        ]
        const near = candidates.reduce((p, q) => Math.abs(q.level - point.level) < Math.abs(p.level - point.level) ? q : p)
        join([...point.nodes, ...near.nodes])
        plan.attached[g.key] = `${point.lower.label} / ${point.upper.label}`
    })
    plan.ops = wiring.ops()
    return plan
}

/** Removes the bay's nodes (its equipment, take-off column and take-offs) from the yard's connections; connections left with fewer than two nodes are deleted. */
export function unwireBayOps(doc: NetworkDocument, bayId: string): NetworkOp[] {
    const bay = doc.bays.find(b => b.id === bayId)
    if (!bay) return []
    const yardId = bay.substationId
    const takeOffIds = new Set(doc.takeOffs.filter(t => t.substationId === yardId && t.bayId === bayId).map(t => t.id))
    const equipmentIds = new Set(doc.equipments.filter(e => e.substationId === yardId && (e.bayId === bayId || (e.takeOffId && takeOffIds.has(e.takeOffId)))).map(e => e.id))
    const mine = (n: NetworkNodeRef) => (n.kind === NetworkNodeKind.EQUIPMENT_TERMINAL && equipmentIds.has(n.id)) || (n.kind === NetworkNodeKind.SUBSTATION_TAKE_OFF && takeOffIds.has(n.id))
    const ops: NetworkOp[] = []
    for (const c of doc.connections) {
        if (c.scope !== ConnectionScope.SUBSTATION || c.junction.id !== yardId || !c.nodes.some(mine)) continue
        const rest = c.nodes.filter(n => !mine(n))
        // buses alone are not a connection
        if (rest.filter(n => n.kind !== NetworkNodeKind.SUBSTATION_BUS).length === 0 || rest.length < 2) ops.push({type: 'delete', collection: 'connections', id: c.id})
        else ops.push({type: 'upsert', collection: 'connections', record: {...c, nodes: rest}})
    }
    return ops
}

/** Number of yard connections touching the bay (what "disconnect" would change). */
export function bayConnectionCount(doc: NetworkDocument, bayId: string): number {
    return unwireBayOps(doc, bayId).length
}
