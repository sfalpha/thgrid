import {TAKEOFF_ARM, TAKEOFF_RUN} from './geometry'
import {useCallback, useEffect, useMemo, useState} from 'react'
import {SubstationEquipmentType} from '@shared/models/substation.equipment'
import {SubstationBusType} from '@shared/models/substation.bus'
import {
    ConnectionJunctionKind,
    ConnectionRecord,
    ConnectionScope,
    defaultTerminals,
    defaultTransformerWindings,
    isTransformerType,
    NetworkNodeKind,
    terminalsFromWindings,
    NetworkNodeRef,
    nodeKey,
    sameNode,
    SubstationBayRecord,
    SubstationBusRecord,
    SubstationEquipmentRecord,
    SubstationRecord,
    SubstationTakeOffRecord,
    SubstationYardConnectionRecord,
} from '@shared/network/records'
import {cascadeDeleteOps, NetworkOp, pickId, uniqueId} from '@shared/network/ops'
import {describeTakeOffUsage, takeOffCircuit, takeOffUsage} from './linkOps'
import {bayNaming, busNaming, equipmentNaming, takeOffLineName, takeOffNaming, yardWiringNaming} from '@shared/network/naming'
import {NewIdField} from './IdEditor'
import {hrefTo} from '../hooks/useHashRoute'
import {Notice} from '../components/IssueList'
import {useNetworkEditor} from './NetworkContext'
import {useSideWidth} from '../hooks/useSideWidth'
import {busLabel, connectionPaths, kvOf, layoutSubstation, nodePoint, portPaths, portPoint, rowY, terminalOffset, usedNodeKeys, YardPort} from './geometry'
import {EquipmentSymbol, equipmentTypeLabels} from './symbols'
import {SubstationPanels} from './SubstationPanels'
import {PLANNED_COLOR, voltageColor} from './mapUtil'
import type {MetaResponse} from '../api/client'

type Mode = 'select' | 'connect'

interface SubstationEditorProps {
    meta: MetaResponse
    substationId: string
    navigate: (path: string) => void
}

/** `#/network/:id/substation/:yardId` – single-line diagram editor of one yard. */
export function SubstationEditor({meta, substationId, navigate}: SubstationEditorProps) {
    const ed = useNetworkEditor()
    const [sideWidth, onResizeStart] = useSideWidth()
    const yard = ed.doc.substations.find(s => s.id === substationId)
    const group = yard ? ed.doc.substationGroups.find(g => g.id === yard.groupId) : undefined
    const layout = useMemo(() => layoutSubstation(ed.doc, substationId), [ed.doc, substationId])
    const [mode, setMode] = useState<Mode>('select')
    const [pick, setPick] = useState<NetworkNodeRef | null>(null)
    /** Connect mode: a port (yard link) picked first; the next node clicked joins the link. */
    const [pickPort, setPickPort] = useState<string | null>(null)
    /** Other yard the next "+ Yard link" joins. */
    const [linkTarget, setLinkTarget] = useState('')
    const [addType, setAddType] = useState<SubstationEquipmentType>(SubstationEquipmentType.CIRCUIT_BREAKER)
    const [nextId, setNextId] = useState('')
    /** Site the next take-off's line goes to ('' = a generic `LINE_<n>`); names it `<voltage>_<site code>_L<n>`. */
    const [takeOffTarget, setTakeOffTarget] = useState('')
    const otherSites = useMemo(() => ed.doc.substationGroups.filter(g => g.id !== group?.id).sort((a, b) => a.groupName.localeCompare(b.groupName)), [ed.doc.substationGroups, group?.id])
    /** Yards a yard link can go to: the other yards of this site, highest voltage first. */
    const otherYards = useMemo(() => {
        const label = (y: SubstationRecord) => `${y.yardName} (${y.voltage})`
        return ed.doc.substations.filter(y => y.id !== substationId && y.groupId === group?.id).map(y => ({y, label: label(y)}))
            .sort((a, b) => kvOf(b.y.voltage) - kvOf(a.y.voltage) || a.label.localeCompare(b.label))
    }, [ed.doc.substations, substationId, group?.id])
    /** Id for the item about to be created: the typed one when valid, else generated; the box is cleared after use. */
    const takeId = (prefix: string) => {
        const id = pickId(ed.doc, nextId, prefix)
        setNextId('')
        return id
    }
    const used = useMemo(() => usedNodeKeys(layout), [layout])
    /** Voltage set on the in-yard connection a node sits on: the terminal dot takes that colour over the terminal / bay / yard voltage. */
    const wiredVoltage = useMemo(() => {
        const m = new Map<string, string>()
        for (const c of layout.connections) if (c.scope === ConnectionScope.SUBSTATION && c.voltage) for (const n of c.nodes) m.set(nodeKey(n), c.voltage)
        return m
    }, [layout.connections])
    const transmissionTakeOffs = useMemo(() => {
        const set = new Set<string>()
        for (const c of ed.doc.connections) if (c.scope === ConnectionScope.TRANSMISSION) for (const n of c.nodes) if (n.kind === NetworkNodeKind.SUBSTATION_TAKE_OFF) set.add(n.id)
        return set
    }, [ed.doc.connections])
    /** Per linked take-off: what it carries, in full for the tooltip and short (the line, else the circuit, "+n" for more) for the label under the arrow. */
    const takeOffUse = useMemo(() => {
        const m = new Map<string, { full: string; short: string }>()
        for (const t of layout.takeOffs) {
            const full = describeTakeOffUsage(ed.doc, t.id)
            if (!full) continue
            const u = takeOffUsage(ed.doc, t.id)
            const names = u.lines.length ? u.lines.map(l => l.name) : u.circuits.map(c => c.name)
            const head = names[0].length > 18 ? names[0].slice(0, 17) + '…' : names[0]
            m.set(t.id, {full, short: `${u.lines.length ? '' : 'circuit '}${head}${names.length > 1 ? ` +${names.length - 1}` : ''}`})
        }
        return m
    }, [ed.doc, layout.takeOffs])
    const sel = ed.selection

    useEffect(() => {
        setPick(null)
        setPickPort(null)
    }, [mode, substationId])

    /* ---------- helpers ---------- */

    const selectedBay = (): SubstationBayRecord | undefined => {
        if (!sel) return layout.bays[0]
        if (sel.collection === 'bays') return layout.bays.find(b => b.id === sel.id)
        if (sel.collection === 'equipments') {
            const e = layout.equipments.find(e => e.id === sel.id)
            return layout.bays.find(b => b.id === e?.bayId) ?? layout.bays[0]
        }
        if (sel.collection === 'takeOffs') {
            const t = layout.takeOffs.find(t => t.id === sel.id)
            return layout.bays.find(b => b.id === t?.bayId) ?? layout.bays[0]
        }
        return layout.bays[0]
    }

    const nextRow = (bayId: string): number => {
        const taken = [
            ...layout.equipments.filter(e => e.bayId === bayId).map(e => e.row),
            ...layout.takeOffs.filter(t => t.bayId === bayId && t.row !== undefined).map(t => t.row!),
            ...layout.buses.map(b => b.row),
        ]
        let s = 1
        while (taken.includes(s)) s++
        return s
    }

    const apply = (ops: NetworkOp[], select?: { collection: 'buses' | 'bays' | 'equipments' | 'takeOffs' | 'connections' | 'yardConnections'; id: string }) => {
        if (ed.apply(ops) && select) ed.select(select)
    }

    /* ---------- add actions ---------- */

    const addBus = () => {
        if (!yard) return
        const n = layout.buses.length + 1
        const takenRows = new Set([...layout.buses.map(b => b.row), ...layout.equipments.map(e => e.row)])
        let row = n === 1 ? 0 : layout.maxRow + 1
        while (takenRows.has(row)) row++
        const naming = busNaming(ed.doc, yard.id, SubstationBusType.MAIN, String(n))
        const record: SubstationBusRecord = {
            id: takeId(naming.id),
            name: naming.name,
            substationId: yard.id,
            busType: SubstationBusType.MAIN,
            busNumber: String(n),
            row,
            voltage: yard.voltage,
        }
        apply([{type: 'upsert', collection: 'buses', record}], {collection: 'buses', id: record.id})
    }

    const addBay = () => {
        if (!yard) return
        const column = layout.bays.length ? layout.maxColumn + 1 : 0
        const bayNumber = String(layout.bays.length + 1).padStart(2, '0')
        const naming = bayNaming(ed.doc, yard.id, bayNumber)
        const record: SubstationBayRecord = {id: takeId(naming.id), name: naming.name, substationId: yard.id, bayNumber, column, voltage: yard.voltage}
        apply([{type: 'upsert', collection: 'bays', record}], {collection: 'bays', id: record.id})
    }

    const ensureBay = (): { bay: SubstationBayRecord; ops: NetworkOp[] } => {
        const bay = selectedBay()
        if (bay) return {bay, ops: []}
        const naming = bayNaming(ed.doc, yard!.id, '01')
        const record: SubstationBayRecord = {id: uniqueId(ed.doc, naming.id), name: naming.name, substationId: yard!.id, bayNumber: '01', column: 0, voltage: yard!.voltage}
        return {bay: record, ops: [{type: 'upsert', collection: 'bays', record}]}
    }

    const addEquipment = () => {
        if (!yard) return
        const {bay, ops} = ensureBay()
        const n = layout.equipments.filter(e => e.bayId === bay.id).length + 1
        const code = `${bay.bayNumber}-${n}`
        const naming = equipmentNaming(ed.doc, yard.id, code, addType)
        // With a take-off (or equipment in its column) selected, the new equipment goes into that take-off column, at the next free row there.
        const branchId = sel?.collection === 'takeOffs' ? sel.id : sel?.collection === 'equipments' ? layout.equipments.find(e => e.id === sel.id)?.takeOffId : undefined
        const onBranch = branchId ? layout.equipments.filter(e => e.takeOffId === branchId) : []
        const branchTakeOff = branchId ? layout.takeOffs.find(t => t.id === branchId) : undefined
        const branchRows = [...onBranch.map(e => e.row), branchTakeOff?.row ?? -1]
        const record: SubstationEquipmentRecord = {
            id: takeId(naming.id),
            name: naming.name,
            substationId: yard.id,
            bayId: bay.id,
            code,
            equipmentType: addType,
            windings: isTransformerType(addType) ? defaultTransformerWindings(yard.voltage) : undefined,
            terminals: isTransformerType(addType) ? terminalsFromWindings(defaultTransformerWindings(yard.voltage)) : defaultTerminals(addType),
            row: branchId ? Math.max(-1, ...branchRows) + 1 : ops.length ? 1 : nextRow(bay.id),
            takeOffId: branchId,
            // a power transformer belongs in the line column, like a take-off
            lineSide: addType === SubstationEquipmentType.POWER_TRANSFORMER || undefined,
        }
        apply([...ops, {type: 'upsert', collection: 'equipments', record}], {collection: 'equipments', id: record.id})
    }

    const addTakeOff = () => {
        if (!yard) return
        const {bay, ops} = ensureBay()
        const lineName = (takeOffTarget && takeOffLineName(ed.doc, yard.id, takeOffTarget)) || `LINE_${layout.takeOffs.length + 1}`
        const naming = takeOffNaming(ed.doc, yard.id, lineName)
        const record: SubstationTakeOffRecord = {
            id: takeId(naming.id),
            name: naming.name,
            substationId: yard.id,
            bayId: bay.id,
            lineName,
            row: ops.length ? 2 : nextRow(bay.id),
            takeOffColumn: true,
        }
        apply([...ops, {type: 'upsert', collection: 'takeOffs', record}], {collection: 'takeOffs', id: record.id})
    }

    const addYardLink = () => {
        const other = ed.doc.substations.find(y => y.id === linkTarget)
        if (!yard || !group || !other) return
        const name = `${yard.yardName}_${other.yardName}`
        const record: SubstationYardConnectionRecord = {id: uniqueId(ed.doc, `SYL_${group.groupName}_${yard.yardName}_${other.yardName}`), name, yardAId: yard.id, yardBId: other.id, nodes: []}
        apply([{type: 'upsert', collection: 'yardConnections', record}], {collection: 'yardConnections', id: record.id})
        setLinkTarget('')
    }

    /* ---------- connecting ---------- */

    const connectionOf = (node: NetworkNodeRef): ConnectionRecord | undefined =>
        node.kind === NetworkNodeKind.SUBSTATION_BUS ? undefined : layout.connections.find(c => c.scope === ConnectionScope.SUBSTATION && c.nodes.some(n => sameNode(n, node)))

    const connect = (a: NetworkNodeRef, b: NetworkNodeRef) => {
        if (!yard || sameNode(a, b)) return
        const ca = connectionOf(a)
        const cb = connectionOf(b)
        const addNode = (c: ConnectionRecord, n: NetworkNodeRef): ConnectionRecord => c.nodes.some(x => sameNode(x, n)) ? c : {...c, nodes: [...c.nodes, n]}
        let ops: NetworkOp[]
        let id: string
        if (ca && cb) {
            if (ca.id === cb.id) return
            const merged = cb.nodes.reduce(addNode, ca)
            ops = [{type: 'upsert', collection: 'connections', record: merged}, {type: 'delete', collection: 'connections', id: cb.id}]
            id = ca.id
        } else if (ca) {
            ops = [{type: 'upsert', collection: 'connections', record: addNode(ca, b)}]
            id = ca.id
        } else if (cb) {
            ops = [{type: 'upsert', collection: 'connections', record: addNode(cb, a)}]
            id = cb.id
        } else {
            const record: ConnectionRecord = {
                id: uniqueId(ed.doc, yardWiringNaming(ed.doc, yard.id).id),
                scope: ConnectionScope.SUBSTATION,
                junction: {kind: ConnectionJunctionKind.SUBSTATION, id: yard.id},
                nodes: [a, b],
            }
            ops = [{type: 'upsert', collection: 'connections', record}]
            id = record.id
        }
        apply(ops, {collection: 'connections', id})
    }

    /** Joins a node of this yard to a yard link (the port's link). */
    const joinYardLink = (link: SubstationYardConnectionRecord, node: NetworkNodeRef) => {
        if (link.nodes.some(n => sameNode(n, node))) return
        apply([{type: 'upsert', collection: 'yardConnections', record: {...link, nodes: [...link.nodes, node]}}], {collection: 'yardConnections', id: link.id})
    }

    const onNode = (node: NetworkNodeRef, owner: { collection: 'buses' | 'equipments' | 'takeOffs'; id: string }) => {
        if (mode !== 'connect') {
            ed.select(owner)
            return
        }
        if (pickPort) {
            const link = layout.ports.find(p => p.link.id === pickPort)?.link
            if (link) joinYardLink(link, node)
            setPickPort(null)
            return
        }
        if (!pick) {
            setPick(node)
            return
        }
        connect(pick, node)
        setPick(null)
    }

    /** A port clicked: in connect mode it takes the picked node into the link (or waits for the next node); otherwise it selects the link. */
    const onPort = (port: YardPort) => {
        if (mode !== 'connect') {
            ed.select({collection: 'yardConnections', id: port.link.id})
            return
        }
        if (pick) {
            joinYardLink(port.link, pick)
            setPick(null)
            return
        }
        setPickPort(prev => prev === port.link.id ? null : port.link.id)
    }
    /** Colour of a yard link in this yard: a node's own voltage, else the lower of the two yards (the secondary side of a transformer). */
    const portVoltage = (port: YardPort): string => {
        for (const n of port.nodes) {
            if (n.kind === NetworkNodeKind.SUBSTATION_BUS) {
                const v = layout.buses.find(b => b.id === n.id)?.voltage
                if (v) return v
            }
            if (n.kind === NetworkNodeKind.EQUIPMENT_TERMINAL) {
                const v = layout.equipments.find(e => e.id === n.id)?.terminals.find(t => t.key === n.terminal)?.voltage
                if (v) return v
            }
        }
        const other = port.otherYard?.voltage
        return other && yard && kvOf(other) < kvOf(yard.voltage) ? other : yard?.voltage ?? ''
    }

    const deleteSelection = useCallback(() => {
        if (!sel || !yard) return
        if (sel.collection === 'substations') return
        if (!['buses', 'bays', 'equipments', 'takeOffs', 'connections', 'yardConnections'].includes(sel.collection)) return
        if (sel.collection === 'takeOffs') {
            const use = describeTakeOffUsage(ed.doc, sel.id)
            if (use) {
                window.alert(`This take-off is in use by ${use}.\nDetach the circuit end, or delete the line with its circuits, on the map first.`)
                return
            }
        }
        ed.apply(cascadeDeleteOps(ed.doc, sel.collection, sel.id))
        ed.select(null)
    }, [sel, yard, ed])

    const onKey = (e: React.KeyboardEvent) => {
        if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'SELECT' || (e.target as HTMLElement).tagName === 'TEXTAREA') return
        if (e.key === 'Escape') {
            setPick(null)
            setPickPort(null)
            setMode('select')
        } else if (e.key === 'Delete' || e.key === 'Backspace') {
            deleteSelection()
        } else if (e.key.toLowerCase() === 'c') {
            setMode(m => m === 'connect' ? 'select' : 'connect')
        }
    }

    if (!yard || !group) {
        return (
            <div className="main">
                <Notice kind="error">Yard "{substationId}" does not exist in this network.</Notice>
                <a href={hrefTo(`/network/${ed.networkId}/substations`)}>Back to substations</a>
            </div>
        )
    }

    const isSel = (collection: string, id: string) => sel?.collection === collection && sel.id === id
    // Everything in a planned yard is grey; otherwise coloured by voltage.
    const vc = (voltage?: string, planned?: boolean) => ({'--vc': planned || yard.planned ? PLANNED_COLOR : voltageColor(voltage ?? yard.voltage)} as React.CSSProperties)
    const bayVoltage = (bayId?: string) => layout.bays.find(b => b.id === bayId)?.voltage ?? yard.voltage
    /** A take-off's voltage: its circuit's (where its line leaves, else the wiring it is in), else its bay's. */
    const takeOffColour = (t: { id: string; bayId?: string }) => {
        const circuit = takeOffCircuit(ed.doc, t.id)
        return circuit.line?.voltage ?? circuit.yard.find(c => c.voltage)?.voltage ?? bayVoltage(t.bayId)
    }
    const connectionVoltage = (c: ConnectionRecord): string => {
        // the connection's own voltage first; else the buses, take-offs and terminals on it, the bay, the yard
        if (c.voltage) return c.voltage
        for (const n of c.nodes) {
            if (n.kind === NetworkNodeKind.SUBSTATION_BUS) {
                const v = layout.buses.find(b => b.id === n.id)?.voltage
                if (v) return v
            }
        }
        // a take-off whose line leaves at another voltage (secondary / auxiliary line) colours the node
        for (const n of c.nodes) {
            if (n.kind === NetworkNodeKind.SUBSTATION_TAKE_OFF) {
                const v = takeOffCircuit(ed.doc, n.id).line?.voltage
                if (v) return v
            }
        }
        for (const n of c.nodes) {
            if (n.kind === NetworkNodeKind.EQUIPMENT_TERMINAL) {
                const e = layout.equipments.find(e => e.id === n.id)
                const v = e?.terminals.find(t => t.key === n.terminal)?.voltage ?? bayVoltage(e?.bayId)
                if (v) return v
            }
        }
        return yard.voltage
    }
    const pickPoint = pick ? nodePoint(layout, pick) : undefined
    const width = Math.max(layout.width, 600)
    const height = Math.max(layout.height, 400)

    return (
        <div className="editor-layout" style={{'--side-w': `${sideWidth}px`} as React.CSSProperties}>
            <div className="editor-canvas sld-canvas" tabIndex={0} onKeyDown={onKey}>
                {/* toolbar and hint are sticky: they stay in view while the diagram scrolls in both directions */}
                <div className="editor-tools">
                    <button type="button" className={mode === 'select' ? 'active' : ''} onClick={() => setMode('select')}>Select</button>
                    <button type="button" className={mode === 'connect' ? 'active' : ''} onClick={() => setMode('connect')} title="Click two nodes to join them (C)">Connect</button>
                    <span style={{width: 8}}/>
                    <NewIdField compact value={nextId} onChange={setNextId} auto="auto"/>
                    <button type="button" onClick={addBus}>+ Bus</button>
                    <button type="button" onClick={addBay}>+ Bay</button>
                    <select value={addType} onChange={e => setAddType(e.target.value as SubstationEquipmentType)}>
                        {(Object.keys(equipmentTypeLabels) as SubstationEquipmentType[]).map(t => <option key={t} value={t}>{equipmentTypeLabels[t]}</option>)}
                    </select>
                    <button type="button" onClick={addEquipment}>+ Equipment</button>
                    <select value={takeOffTarget} onChange={e => setTakeOffTarget(e.target.value)} title="Site the next take-off's line goes to: names it <voltage>_<site code>_L<n>">
                        <option value="">line to…</option>
                        {otherSites.map(g => <option key={g.id} value={g.id}>{g.groupName}</option>)}
                    </select>
                    <button type="button" onClick={addTakeOff} title={takeOffTarget && yard ? `Add take-off ${takeOffLineName(ed.doc, yard.id, takeOffTarget)}` : 'Add a take-off (generic LINE_<n> name)'}>+ Take-off</button>
                    <select value={linkTarget} onChange={e => setLinkTarget(e.target.value)} disabled={!otherYards.length} title={otherYards.length ? 'Other yard of this site for a yard link (a transformer side or a tie between yards): a port for it appears at the top when its voltage is higher, else at the bottom' : 'This site has no other yard to link to'}>
                        <option value="">yard link to…</option>
                        {otherYards.map(o => <option key={o.y.id} value={o.y.id}>{o.label}</option>)}
                    </select>
                    <button type="button" onClick={addYardLink} disabled={!linkTarget} title="Create a yard link to that yard; then wire nodes to its port in Connect mode">+ Yard link</button>
                    <span style={{width: 8}}/>
                    <button type="button" className="danger" onClick={deleteSelection} disabled={!sel || sel.collection === 'substations'}>Delete</button>
                </div>
                <svg className={`sld ${yard.planned ? 'planned' : ''}`} width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{marginTop: 8}}
                     onClick={e => {
                         if (e.target === e.currentTarget) {
                             ed.select({collection: 'substations', id: yard.id})
                             setPick(null)
                         }
                     }}>
                    <text x={16} y={24} className="bay-label">{group.groupName} · {yard.yardName} ({yard.voltage})</text>
                    {/* row grid: one faint line per row from 0 to the highest row in use, numbered at the left margin */}
                    {Array.from({length: layout.maxRow + 1}, (_, r) => {
                        const y = rowY(r, layout.rowTop)
                        return (
                            <g key={`row-${r}`} className="row-grid">
                                <line x1={layout.buses[0]?.x1 ?? 16} y1={y} x2={width - 10} y2={y} className="row-line"/>
                                <text x={4} y={y + 3} className="row-label">{r}</text>
                            </g>
                        )
                    })}
                    {layout.bays.map(b => (
                        <g key={b.id} className="bay" onClick={() => ed.select({collection: 'bays', id: b.id})} style={{cursor: 'pointer'}}>
                            <line x1={b.x} y1={30} x2={b.x} y2={height - 10} className="bay-col"/>
                            <text x={b.x} y={44} textAnchor="middle" className="bay-label" fill={isSel('bays', b.id) ? 'var(--accent)' : undefined}>BAY {b.bayNumber}</text>
                        </g>
                    ))}
                    {layout.ports.map(p => (
                        <g key={`port-${p.link.id}`} style={vc(portVoltage(p))} onClick={() => ed.select({collection: 'yardConnections', id: p.link.id})}>
                            {portPaths(layout, p).map((w, i) => (
                                <g key={i}>
                                    <path d={w.d} className="wire-hit"/>
                                    <path d={w.d} className={`wire ${isSel('yardConnections', p.link.id) ? 'selected' : ''}`}/>
                                </g>
                            ))}
                            {portPaths(layout, p).filter(w => w.tee).map((w, i) => <circle key={i} cx={w.hub.x} cy={w.hub.y} r={3.5} fill="var(--vc)"/>)}
                        </g>
                    ))}
                    {layout.connections.filter(c => c.scope === ConnectionScope.SUBSTATION).map(c => (
                        <g key={c.id} style={vc(connectionVoltage(c))} onClick={() => ed.select({collection: 'connections', id: c.id})}>
                            {connectionPaths(layout, c).map((p, i) => (
                                <g key={i}>
                                    <path d={p.d} className="wire-hit"/>
                                    <path d={p.d} className={`wire ${isSel('connections', c.id) ? 'selected' : ''}`}/>
                                </g>
                            ))}
                            {connectionPaths(layout, c).filter(p => p.tee).map((p, i) => <circle key={i} cx={p.hub.x} cy={p.hub.y} r={3.5} fill="var(--vc)"/>)}
                        </g>
                    ))}
                    {layout.buses.map(b => {
                        const node: NetworkNodeRef = {kind: NetworkNodeKind.SUBSTATION_BUS, id: b.id}
                        const picked = pick && sameNode(pick, node)
                        return (
                            <g key={b.id} style={vc(b.voltage)} onClick={() => onNode(node, {collection: 'buses', id: b.id})}>
                                <line x1={b.x1} y1={b.y} x2={b.x2} y2={b.y} className={`bus ${isSel('buses', b.id) || picked ? 'selected' : ''}`}/>
                                <text x={b.x1} y={b.y - 8} className="bus-label">{busLabel(b)}</text>
                            </g>
                        )
                    })}
                    {layout.equipments.map(e => {
                        // a ground switch is an L off the column (symbols.tsx): its label sits beside the hanging part
                        const ground = e.equipmentType === SubstationEquipmentType.GROUND_SWITCH
                        return (
                        <g key={e.id} transform={`translate(${e.x},${e.y})`} className={`equipment ${isSel('equipments', e.id) ? 'selected' : ''}`}
                           style={vc(e.terminals.find(t => t.voltage)?.voltage ?? bayVoltage(e.bayId))}>
                            <g onClick={() => ed.select({collection: 'equipments', id: e.id})}>
                                {ground ? <rect x={-6} y={-8} width={TAKEOFF_ARM + 24} height={52} fill="transparent"/> : <circle r={22} fill="transparent"/>}
                                <EquipmentSymbol type={e.equipmentType}/>
                                <text x={ground ? TAKEOFF_ARM + 16 : 28} y={ground ? 22 : 4} className="eq-label">{e.equipmentType === SubstationEquipmentType.POWER_TRANSFORMER && !e.lineSide ? '⚠ ' : ''}{e.code}{e.lineSide ? ' ↑' : ''}{e.busTie ? ' ⇔' : ''}</text>
                                {(e.lineSide || e.busTie) && <title>{`${e.code}: ${[e.lineSide ? 'line side' : '', e.busTie ? 'bus tie' : ''].filter(Boolean).join(', ')}`}</title>}
                                {e.equipmentType === SubstationEquipmentType.POWER_TRANSFORMER && !e.lineSide && <title>{`${e.code}: ⚠ a power transformer belongs in the line column: tick "line side" in its panel`}</title>}
                            </g>
                            {e.terminals.map((t, i) => {
                                const off = terminalOffset(e.terminals, i, e.equipmentType)
                                const node: NetworkNodeRef = {kind: NetworkNodeKind.EQUIPMENT_TERMINAL, id: e.id, terminal: t.key}
                                const cls = pick && sameNode(pick, node) ? 'picked' : used.has(nodeKey(node)) ? 'used' : ''
                                return (
                                    <g key={t.key} onClick={ev => {
                                        ev.stopPropagation()
                                        onNode(node, {collection: 'equipments', id: e.id})
                                    }}>
                                        <circle cx={off.x} cy={off.y} r={5} className={`terminal ${cls}`} style={vc(wiredVoltage.get(nodeKey(node)) ?? t.voltage ?? bayVoltage(e.bayId))}>
                                            <title>{`${e.code} · terminal ${t.key}${t.label ? ` (${t.label})` : ''}`}</title>
                                        </circle>
                                        {e.terminals.length > 2 && <text x={off.x + 7} y={off.y + 3} className="eq-label">{t.key}</text>}
                                    </g>
                                )
                            })}
                        </g>
                        )
                    })}
                    {layout.takeOffs.map(t => {
                        const node: NetworkNodeRef = {kind: NetworkNodeKind.SUBSTATION_TAKE_OFF, id: t.id}
                        const cls = pick && sameNode(pick, node) ? 'picked' : used.has(nodeKey(node)) ? 'used' : ''
                        return (
                            <g key={t.id} transform={`translate(${t.x},${t.y})`} className={`takeoff ${isSel('takeOffs', t.id) ? 'selected' : ''} ${transmissionTakeOffs.has(t.id) ? 'linked' : ''} ${t.planned ? 'planned' : ''}`}
                               style={vc(takeOffColour(t), t.planned)}>
                                {(() => {
                                    // I shape: the terminal at one end, the arrow head at the other (up by default, down when wired from above)
                                    const sgn = t.up ? -1 : 1
                                    const tip = sgn * TAKEOFF_RUN, base = tip - sgn * 10, tail = -sgn * (TAKEOFF_RUN - 8)
                                    const warn = !t.takeOffColumn && !!t.bayId
                                    return (
                                        <g onClick={() => ed.select({collection: 'takeOffs', id: t.id})}>
                                            <path d={`M0,${tail} L0,${base} M-8,${base} L0,${tip} L8,${base} Z`} className="sym"/>
                                            <text x={14} y={4} className="takeoff-label">{warn ? '⚠ ' : ''}{t.lineName}</text>
                                            {!t.bayId && <text x={14} y={16} className="eq-label">(no bay)</text>}
                                            {takeOffUse.has(t.id) && <text x={14} y={t.bayId ? 16 : 28} className="eq-label">{takeOffUse.get(t.id)!.short}</text>}
                                        </g>
                                    )
                                })()}
                                <circle cx={0} cy={t.up ? TAKEOFF_RUN - 2 : -(TAKEOFF_RUN - 2)} r={5} className={`terminal ${cls}`} style={vc(wiredVoltage.get(nodeKey(node)) ?? takeOffColour(t), t.planned)} onClick={ev => {
                                    ev.stopPropagation()
                                    onNode(node, {collection: 'takeOffs', id: t.id})
                                }}>
                                    <title>{`Take-off ${t.lineName}${takeOffUse.has(t.id) ? ` · in use by ${takeOffUse.get(t.id)!.full}` : ' · free'}${!t.takeOffColumn && t.bayId ? ' · ⚠ drawn in the bay column (tick "take-off column")' : ''}`}</title>
                                </circle>
                            </g>
                        )
                    })}
                    {layout.ports.map(p => {
                        // the port: an arrow towards the other yard whose tip is a box in that yard's colour naming site, yard and link
                        const og = p.otherYard ? ed.doc.substationGroups.find(g => g.id === p.otherYard!.groupId) : undefined
                        const color = p.otherYard ? voltageColor(p.otherYard.voltage) : voltageColor()
                        const sgn = p.up ? -1 : 1
                        const tip = sgn * TAKEOFF_RUN, base = tip - sgn * 10, tail = -sgn * (TAKEOFF_RUN - 8)
                        const term = portPoint(p)
                        const boxY = p.up ? tip - 32 : tip + 2
                        const picked = pickPort === p.link.id
                        const title = `Yard link ${p.link.name} → ${og?.groupName ?? '?'} ${p.otherYard?.yardName ?? '?'}${p.otherYard ? ` (${p.otherYard.voltage})` : ''} · ${p.nodes.length} node${p.nodes.length === 1 ? '' : 's'} here, ${p.link.nodes.length - p.nodes.length} there`
                        return (
                            <g key={p.link.id} transform={`translate(${p.x},${p.y})`} className={`port ${isSel('yardConnections', p.link.id) ? 'selected' : ''}`} style={vc(portVoltage(p))}>
                                <g onClick={() => ed.select({collection: 'yardConnections', id: p.link.id})} style={{cursor: 'pointer'}}>
                                    <path d={`M0,${tail} L0,${base} M-8,${base} L0,${tip} L8,${base} Z`} className="sym"/>
                                    <rect x={-58} y={boxY} width={116} height={30} rx={4} fill={color} className="port-box"/>
                                    <text x={0} y={boxY + 12} textAnchor="middle" className="port-label">{og?.groupName ?? '?'} {p.otherYard?.yardName ?? '?'}</text>
                                    <text x={0} y={boxY + 24} textAnchor="middle" className="port-label">{p.link.name}</text>
                                    <title>{title}</title>
                                </g>
                                <circle cx={0} cy={term.y - p.y} r={5} className={`terminal ${picked ? 'picked' : p.nodes.length ? 'used' : ''}`} onClick={ev => {
                                    ev.stopPropagation()
                                    onPort(p)
                                }}>
                                    <title>{`${title}. Connect mode: click a node then this port (or the reverse) to wire the node into the link.`}</title>
                                </circle>
                            </g>
                        )
                    })}
                    {pickPoint && <circle cx={pickPoint.x} cy={pickPoint.y} r={10} className="ghost"/>}
                </svg>
                <div className="editor-hint">
                    {mode === 'connect'
                        ? pickPort ? 'Now click the node of this yard to wire into the yard link. Esc cancels.' : pick ? 'Now click the second node (terminal, bus or take-off), or a yard-link port. Esc cancels.' : 'Connect mode: click a terminal, bus or take-off, then another one (or a yard-link port). Clicking a node that is already wired joins the existing connection.'
                        : <>Select mode: click items to edit them in the panel; a bay's panel wires or unwires its whole stack. <span className="kbd">C</span> connect · <span className="kbd">Del</span> delete · <span className="kbd">Esc</span> cancel</>}
                </div>
            </div>
            <div className="side-resizer" onMouseDown={onResizeStart} title="Drag to resize the panel"/>
            <aside className="editor-side">
                <SubstationPanels meta={meta} yard={yard} group={group} layout={layout} navigate={navigate}/>
            </aside>
        </div>
    )
}
