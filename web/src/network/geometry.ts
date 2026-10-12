/**
 * Layout of the substation single-line diagram.
 *
 * Horizontal axis: bay `column`. Vertical axis: a shared integer index used by
 * bus `row`, equipment `row` and take-off `row`, counted from the bottom
 * (row / row 0 is the lowest line of the diagram). Each bay has a second,
 * narrower *take-off column* to the right of its main column, where its
 * take-offs (flag `takeOffColumn`) and the equipment flagged with a
 * `takeOffId` are drawn at their row. Everything is computed from the
 * records, nothing is stored besides those integers and flags.
 */
import {
    ConnectionRecord,
    EquipmentTerminalRecord,
    NetworkDocument,
    NetworkNodeKind,
    NetworkNodeRef,
    nodeKey,
    SubstationBayRecord,
    SubstationBusRecord,
    SubstationEquipmentRecord,
    SubstationRecord,
    SubstationTakeOffRecord,
    SubstationYardConnectionRecord,
} from '@shared/network/records'
import {SubstationEquipmentType} from '@shared/models/substation.equipment'

export const COL_W = 150
export const ROW_H = 72
export const MARGIN_X = 90
export const MARGIN_Y = 70
export const SYMBOL_R = 20
export const TERMINAL_OFFSET = 26

export interface Point {
    x: number
    y: number
}

export function colX(column: number): number {
    return MARGIN_X + column * COL_W
}

/** Pixel y of a row / row: index 0 is at the bottom, `maxRow` at the top. */
export function rowY(row: number, maxRow: number): number {
    return MARGIN_Y + (maxRow - row) * ROW_H
}

/** Offset of a bay's take-off column from its main column, and the length of a ground switch's arm. */
export const TAKEOFF_ARM = 36
/** Half length of the take-off arrow (an I shape: terminal at one end, arrow head at the other). */
export const TAKEOFF_RUN = 20

/**
 * Terminal positions relative to the symbol centre, by index in the terminal
 * list. A ground switch is an L hanging off the bay column: its single
 * terminal is the corner, at the centre itself.
 */
export function terminalOffset(terminals: EquipmentTerminalRecord[], index: number, type?: SubstationEquipmentType): Point {
    if (type === SubstationEquipmentType.GROUND_SWITCH) return {x: 0, y: 0}
    if (terminals.length === 1) return {x: 0, y: -TERMINAL_OFFSET}
    if (terminals.length === 2) return index === 0 ? {x: 0, y: -TERMINAL_OFFSET} : {x: 0, y: TERMINAL_OFFSET}
    // 3+: top, bottom, right, left, then spread on the right
    switch (index) {
        case 0:
            return {x: 0, y: -TERMINAL_OFFSET}
        case 1:
            return {x: 0, y: TERMINAL_OFFSET}
        case 2:
            return {x: TERMINAL_OFFSET, y: 0}
        case 3:
            return {x: -TERMINAL_OFFSET, y: 0}
        default:
            return {x: TERMINAL_OFFSET, y: (index - 3) * 12}
    }
}

/** A yard link as seen from one yard: the port standing for the other yard, with this yard's nodes of the link. */
export interface YardPort {
    link: SubstationYardConnectionRecord
    /** The other yard (undefined when it no longer exists). */
    otherYard?: SubstationRecord
    x: number
    y: number
    /** The port is at the top of the diagram (the other yard's voltage is higher) and its arrow points up; else bottom, pointing down. */
    up: boolean
    /** Nodes of the link that belong to this yard. */
    nodes: NetworkNodeRef[]
}

/** The row / row that is drawn highest, accounting for the extra space of top ports. */
export const kvOf = (v?: string) => Number(String(v ?? '').replace(/\D/g, '')) || 0

/**
 * Label of a bus in the diagram and lists: its name with the bus number in parentheses, `MAIN_BUS (1)`. A name that ends in
 * the number (the rule name `MAIN_BUS_1`) is shown without that tail; a transfer bus, numberless in the naming rules, shows its name.
 */
export function busLabel(b: { name?: string; busType: string; busNumber?: string }): string {
    const name = b.name?.trim() || `${b.busType}_BUS`
    const n = b.busNumber?.trim()
    if (!n || b.busType === 'TRANSFER') return name
    const tail = new RegExp(`[_ -]?${n.replace(/[^A-Za-z0-9]/g, ch => '\\' + ch)}$`)
    return `${name.replace(tail, '') || name} (${n})`
}

export interface SubstationLayout {
    substationId: string
    bays: (SubstationBayRecord & { x: number })[]
    buses: (SubstationBusRecord & { y: number; x1: number; x2: number })[]
    equipments: (SubstationEquipmentRecord & { x: number; y: number })[]
    /** `up`: the arrow points up (default) or down (when what it is wired to sits above it). */
    takeOffs: (SubstationTakeOffRecord & { x: number; y: number; up: boolean })[]
    /** Ports of the yard links this yard takes part in. */
    ports: YardPort[]
    connections: ConnectionRecord[]
    width: number
    height: number
    maxColumn: number
    maxRow: number
    /** Row drawn highest (`maxRow` plus the space of top ports): `rowY(row, rowTop)` is the y of any row. */
    rowTop: number
}

export function layoutSubstation(doc: NetworkDocument, substationId: string): SubstationLayout {
    const bays = doc.bays.filter(b => b.substationId === substationId).sort((a, b) => a.column - b.column)
    const buses = doc.buses.filter(b => b.substationId === substationId).sort((a, b) => a.row - b.row)
    const equipments = doc.equipments.filter(e => e.substationId === substationId)
    const takeOffs = doc.takeOffs.filter(t => t.substationId === substationId)
    const connections = doc.connections.filter(c => c.junction.id === substationId)
    const bayById = new Map(bays.map(b => [b.id, b]))
    const takeOffById = new Map(takeOffs.map(t => [t.id, t]))

    const maxColumn = Math.max(0, ...bays.map(b => b.column))
    const rowsByBay = new Map<string, number>()
    const takeOffRow = (t: SubstationTakeOffRecord) => {
        if (t.row !== undefined) return t.row
        const bayEquipment = equipments.filter(e => e.bayId === t.bayId)
        return Math.max(0, ...bayEquipment.map(e => e.row)) + 1
    }
    for (const t of takeOffs) rowsByBay.set(t.id, takeOffRow(t))
    const maxRow = Math.max(0, ...buses.map(b => b.row), ...equipments.map(e => e.row), ...[...rowsByBay.values()])

    // Yard links: a port per link, at the top when the other yard's voltage is higher, else at the bottom.
    const yardRecord = doc.substations.find(s => s.id === substationId)
    const links = (doc.yardConnections ?? []).filter(yc => yc.yardAId === substationId || yc.yardBId === substationId)
    const ownerYard = (n: NetworkNodeRef): string | undefined => n.kind === NetworkNodeKind.SUBSTATION_BUS ? doc.buses.find(b => b.id === n.id)?.substationId
        : n.kind === NetworkNodeKind.EQUIPMENT_TERMINAL ? doc.equipments.find(e => e.id === n.id)?.substationId
            : n.kind === NetworkNodeKind.SUBSTATION_TAKE_OFF ? doc.takeOffs.find(t => t.id === n.id)?.substationId : undefined
    const portBase = links.map(link => {
        const otherYard = doc.substations.find(s => s.id === (link.yardAId === substationId ? link.yardBId : link.yardAId))
        const up = otherYard ? kvOf(otherYard.voltage) > kvOf(yardRecord?.voltage) : true
        return {link, otherYard, up, nodes: link.nodes.filter(n => ownerYard(n) === substationId)}
    })
    // extra space above (1.5 rows: the port box sits above the arrow) / below (1 row) the rows for the ports
    const topExtra = portBase.some(p => p.up) ? 1.5 : 0
    const bottomExtra = portBase.some(p => !p.up) ? 1 : 0
    const rowTop = maxRow + topExtra

    // Take-offs without a bay, and ports whose link has no node in this yard yet, are placed in extra columns to the right.
    let orphanColumn = maxColumn + 1
    const orphanX = new Map<string, number>()
    for (const t of takeOffs) if (!t.bayId || !bayById.has(t.bayId)) orphanX.set(t.id, colX(orphanColumn++))
    const portOrphanX = new Map<string, number>()
    for (const p of portBase) if (!p.nodes.some(n => n.kind !== NetworkNodeKind.SUBSTATION_BUS)) portOrphanX.set(p.link.id, colX(orphanColumn++))

    const x1 = MARGIN_X - COL_W / 2
    const x2 = colX(Math.max(maxColumn, orphanColumn - 1)) + COL_W / 2

    /** x of a bay's main column, or of the extra column used for equipment without a known bay. */
    const bayX = (bayId: string | undefined) => bayId && bayById.has(bayId) ? colX(bayById.get(bayId)!.column) : colX(maxColumn + 1)
    const placedEquipments = equipments.map(e => {
        // in the line (take-off) column: of its take-off's bay when it has one, else of its own bay when flagged line side
        // (a power transformer belongs there, like a take-off; unflagged it stays in the bay column with a warning)
        const t = e.takeOffId ? takeOffById.get(e.takeOffId) : undefined
        const x = t ? bayX(t.bayId) + TAKEOFF_ARM : e.lineSide ? bayX(e.bayId) + TAKEOFF_ARM : bayX(e.bayId)
        return {...e, x, y: rowY(e.row, rowTop)}
    })
    const takeOffBase = takeOffs.map(t => ({
        ...t,
        x: orphanX.get(t.id) ?? bayX(t.bayId) + (t.takeOffColumn ? TAKEOFF_ARM : 0),
        y: rowY(rowsByBay.get(t.id)!, rowTop),
    }))
    const busById = new Map(buses.map(b => [b.id, b]))
    const equipmentById = new Map(placedEquipments.map(e => [e.id, e]))
    const takeOffBaseById = new Map(takeOffBase.map(t => [t.id, t]))
    /** y of a node the take-off is wired to, to decide the arrow direction. */
    const partnerY = (n: NetworkNodeRef): number | undefined => {
        switch (n.kind) {
            case NetworkNodeKind.SUBSTATION_BUS:
                return busById.has(n.id) ? rowY(busById.get(n.id)!.row, rowTop) : undefined
            case NetworkNodeKind.EQUIPMENT_TERMINAL: {
                const e = equipmentById.get(n.id)
                if (!e) return undefined
                const i = e.terminals.findIndex(t => t.key === n.terminal)
                return e.y + (i >= 0 ? terminalOffset(e.terminals, i, e.equipmentType).y : 0)
            }
            case NetworkNodeKind.SUBSTATION_TAKE_OFF:
                return takeOffBaseById.get(n.id)?.y
            default:
                return undefined
        }
    }
    // The arrow points up unless the yard wiring reaches the take-off from above (a bus or equipment at a higher row / row).
    const placedTakeOffs = takeOffBase.map(t => {
        const isMe = (n: NetworkNodeRef) => n.kind === NetworkNodeKind.SUBSTATION_TAKE_OFF && n.id === t.id
        const fromAbove = connections.some(c => c.scope === 'SUBSTATION' && c.nodes.some(isMe) && c.nodes.some(n => !isMe(n) && (partnerY(n) ?? Infinity) < t.y))
        return {...t, up: !fromAbove}
    })

    // a port stands in the column of the link's first non-bus node of this yard (an extra column when there is none)
    const ports: YardPort[] = portBase.map(p => {
        const first = p.nodes.find(n => n.kind !== NetworkNodeKind.SUBSTATION_BUS)
        const x = portOrphanX.get(p.link.id) ?? (first?.kind === NetworkNodeKind.EQUIPMENT_TERMINAL ? equipmentById.get(first.id)?.x : first ? takeOffBaseById.get(first.id)?.x : undefined) ?? colX(0)
        return {...p, x, y: rowY(p.up ? maxRow + 1 : -1, rowTop)}
    })

    return {
        substationId,
        bays: bays.map(b => ({...b, x: colX(b.column)})),
        buses: buses.map(b => ({...b, y: rowY(b.row, rowTop), x1, x2})),
        equipments: placedEquipments,
        takeOffs: placedTakeOffs,
        ports,
        connections,
        width: x2 + COL_W / 2,
        height: rowY(-1 - bottomExtra, rowTop) + MARGIN_Y,
        maxColumn,
        maxRow,
        rowTop,
    }
}

/** Screen position of a node. Bus nodes get the x of `nearX` (the partner node) so the drop line is vertical. */
export function nodePoint(layout: SubstationLayout, node: NetworkNodeRef, nearX?: number): Point | undefined {
    switch (node.kind) {
        case NetworkNodeKind.SUBSTATION_BUS: {
            const bus = layout.buses.find(b => b.id === node.id)
            return bus ? {x: nearX ?? bus.x1 + 20, y: bus.y} : undefined
        }
        case NetworkNodeKind.EQUIPMENT_TERMINAL: {
            const eq = layout.equipments.find(e => e.id === node.id)
            if (!eq) return undefined
            const i = eq.terminals.findIndex(t => t.key === node.terminal)
            if (i < 0) return undefined
            const off = terminalOffset(eq.terminals, i, eq.equipmentType)
            return {x: eq.x + off.x, y: eq.y + off.y}
        }
        case NetworkNodeKind.SUBSTATION_TAKE_OFF: {
            // the terminal is the end of the I opposite the arrow head
            const t = layout.takeOffs.find(t => t.id === node.id)
            return t ? {x: t.x, y: t.y + (t.up ? TAKEOFF_RUN - 2 : -(TAKEOFF_RUN - 2))} : undefined
        }
        default:
            return undefined
    }
}

/** Terminal of a port: the end of its arrow opposite the head (towards the rows). */
export function portPoint(port: YardPort): Point {
    return {x: port.x, y: port.y + (port.up ? TAKEOFF_RUN - 2 : -(TAKEOFF_RUN - 2))}
}

/** Wires of a yard link inside this yard: its nodes here routed to the port, like a connection. */
export function portPaths(layout: SubstationLayout, port: YardPort): { d: string; hub: Point; tee?: boolean }[] {
    const nonBus = port.nodes.filter(n => n.kind !== NetworkNodeKind.SUBSTATION_BUS)
    const anchorX = nonBus.map(n => nodePoint(layout, n)?.x).find((x): x is number => x !== undefined) ?? port.x
    const points = port.nodes.map(n => nodePoint(layout, n, anchorX)).filter((p): p is Point => !!p)
    if (points.length === 0) return []
    return routePoints([...points, portPoint(port)], port.nodes.findIndex(n => n.kind === NetworkNodeKind.SUBSTATION_TAKE_OFF))
}

/**
 * Polyline(s) that draw a connection. Two nodes: a straight run, an L or a Z
 * (see below). More nodes: the nodes of each column are joined by one
 * vertical segment, and neighbouring columns (left to right) are linked by a
 * horizontal leg that leaves the left column at the middle of its segment
 * (a T; at the node itself when the column has one) and lands on the right
 * column at that height when it lies within its segment, else turns up or
 * down to the nearest node there; `tee` marks the junction dots to draw.
 */
export function connectionPaths(layout: SubstationLayout, conn: ConnectionRecord): { d: string; hub: Point; tee?: boolean }[] {
    const nonBus = conn.nodes.filter(n => n.kind !== NetworkNodeKind.SUBSTATION_BUS)
    const anchorX = nonBus.map(n => nodePoint(layout, n)?.x).find((x): x is number => x !== undefined)
    const points = conn.nodes.map(n => nodePoint(layout, n, anchorX)).filter((p): p is Point => !!p)
    if (points.length === 0) return []
    return routePoints(points, conn.nodes.findIndex(n => n.kind === NetworkNodeKind.SUBSTATION_TAKE_OFF))
}

/** Orthogonal routing of the points of one connection; `ti` is the index of a take-off point (-1 when none). */
function routePoints(points: Point[], ti: number): { d: string; hub: Point; tee?: boolean }[] {
    let hub: Point
    if (points.length === 2) {
        // Straight vertical run when x matches. Between a bay column and its take-off column (or from a take-off) the wire is an
        // L: horizontal from the bay-column side first, then up or down to the other node. Between bays it is a Z through the mid height.
        const [a, b] = points
        if (Math.abs(a.x - b.x) < 0.5) return [{d: `M${a.x},${a.y} L${b.x},${b.y}`, hub: {x: a.x, y: (a.y + b.y) / 2}}]
        const sameBay = Math.abs(a.x - b.x) <= TAKEOFF_ARM + 0.5
        if (ti === 0 || ti === 1 || sameBay) {
            // start at the take-off, else at the left (bay column) node
            const si = ti === 0 || ti === 1 ? ti : a.x <= b.x ? 0 : 1
            const s = points[si], o = points[1 - si]
            return [{d: `M${s.x},${s.y} L${o.x},${s.y} L${o.x},${o.y}`, hub: {x: o.x, y: (s.y + o.y) / 2}}]
        }
        const midY = (a.y + b.y) / 2
        return [{d: `M${a.x},${a.y} L${a.x},${midY} L${b.x},${midY} L${b.x},${b.y}`, hub: {x: (a.x + b.x) / 2, y: midY}}]
    }
    const cols = new Map<number, Point[]>()
    for (const p of points) {
        const key = Math.round(p.x * 2) / 2
        cols.set(key, [...(cols.get(key) ?? []), p])
    }
    const columns = [...cols.entries()].sort((a, b) => a[0] - b[0]).map(([x, pts]) => {
        const minY = Math.min(...pts.map(p => p.y)), maxY = Math.max(...pts.map(p => p.y))
        // where a link leaves / enters this column: the middle of its segment, or its only node
        return {x, pts, minY, maxY, attachY: pts.length > 1 ? (minY + maxY) / 2 : pts[0].y}
    })
    const out: { d: string; hub: Point; tee?: boolean }[] = []
    for (const c of columns) if (c.pts.length > 1) out.push({d: `M${c.x},${c.minY} L${c.x},${c.maxY}`, hub: {x: c.x, y: c.attachY}})
    for (let i = 0; i + 1 < columns.length; i++) {
        const a = columns[i], b = columns[i + 1]
        const y = a.attachY
        const within = y >= b.minY && y <= b.maxY
        const near = b.pts.reduce((p, q) => Math.abs(q.y - y) < Math.abs(p.y - y) ? q : p)
        const ty = within ? y : near.y
        // T on the left column (its segment middle), and on the right one when the leg lands inside its segment
        if (a.pts.length > 1) out.push({d: `M${a.x},${y} L${a.x},${y}`, hub: {x: a.x, y}, tee: true})
        hub = {x: b.x, y: ty}
        out.push({d: `M${a.x},${y} L${b.x},${y}${ty !== y ? ` L${b.x},${ty}` : ''}`, hub, tee: within && b.pts.length > 1 && y !== b.minY && y !== b.maxY})
    }
    return out
}

/** Nodes of a yard that are already used by a SUBSTATION-scope connection (buses may be used many times). */
export function usedNodeKeys(layout: SubstationLayout): Set<string> {
    const used = new Set<string>()
    for (const c of layout.connections) {
        if (c.scope !== 'SUBSTATION') continue
        for (const n of c.nodes) if (n.kind !== NetworkNodeKind.SUBSTATION_BUS) used.add(nodeKey(n))
    }
    for (const p of layout.ports) for (const n of p.nodes) if (n.kind !== NetworkNodeKind.SUBSTATION_BUS) used.add(nodeKey(n))
    return used
}
