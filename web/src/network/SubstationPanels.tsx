import {ReactNode, useEffect, useMemo, useRef, useState} from 'react'
import {bayNaming, busNaming, equipmentNaming, RegenerateTarget, takeOffLineName, takeOffNaming} from '@shared/network/naming'
import {yardNameForVoltage} from '@shared/models/naming'
import type {NetworkDocument} from '@shared/network/records'
import {draftNaming, RegenerateBox, RegenerateButton, targetKey} from './RegenerateBox'
import {SubstationEquipmentType} from '@shared/models/substation.equipment'
import {TransmissionVoltage} from '@shared/models/transmission.voltage'
import {TemplateKind} from '@shared/templates/template'
import type {PowerTransformerTemplate} from '@shared/templates/power.transformer'
import type {SubstationYardTemplate} from '@shared/templates/substation.yard'
import type {SubstationBayTemplate} from '@shared/templates/substation.bay'
import {useAsync} from '../hooks/useAsync'
import {BAY_TEMPLATE_TYPE_LABELS} from '../components/editors/BayTemplateForm'
import {WindingsEditor} from '../components/editors/PowerTransformerForm'
import {validateTransformerWindings} from '@shared/templates/validation'
import {defaultStartRow, DeployDirection, deployBayTemplateOps, deployYardTemplateOps} from './deployTemplates'
import {shiftYardColumnsOps, shiftYardRowsOps} from './yardShift'
import {
    ConnectionRecord,
    ConnectionScope,
    defaultTerminals,
    defaultTransformerWindings,
    isTransformerType,
    terminalsFromWindings,
    NetworkNodeKind,
    NetworkNodeRef,
    nodeKey,
    SubstationBayRecord,
    SubstationBusRecord,
    SubstationEquipmentRecord,
    SubstationGroupRecord,
    SubstationRecord,
    SubstationTakeOffRecord,
    SubstationYardConnectionRecord,
} from '@shared/network/records'
import {applyOps, cascadeDeleteOps, findRecord, NetworkOp} from '@shared/network/ops'
import {describeTakeOffUsage, takeOffUsage} from './linkOps'
import {bayConnectionCount, unwireBayOps, wireBayOps} from './autoWire'
import {Notice} from '../components/IssueList'
import {api, MetaResponse} from '../api/client'
import {useTemplates} from '../hooks/useTemplates'
import {hrefTo} from '../hooks/useHashRoute'
import {CheckboxField, enumLabel, NumberField, SelectField, TextField} from '../components/fields'
import {useNetworkEditor} from './NetworkContext'
import {IdEditor} from './IdEditor'
import type {NetworkCollectionName} from '@shared/network/records'
import {busLabel, type SubstationLayout} from './geometry'
import {equipmentTypeLabels} from './symbols'

interface PanelsProps {
    meta: MetaResponse
    yard: SubstationRecord
    group: SubstationGroupRecord
    layout: SubstationLayout
    navigate: (path: string) => void
}

/**
 * Local draft of a record; `commit` writes one upsert op. When the record changes underneath (a field applied at once from
 * another control, undo, a regeneration) the draft follows it but keeps the edits not applied yet, unless the same field changed.
 */
function useDraft<T extends { id: string }>(record: T) {
    const [draft, setDraft] = useState<T>(record)
    const previous = useRef(record)
    useEffect(() => {
        const before = previous.current
        previous.current = record
        setDraft(d => {
            if (before.id !== record.id) return record
            const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
            const next = {...record}
            for (const k of Object.keys(d) as (keyof T)[]) if (!same(d[k], before[k]) && same(record[k], before[k])) next[k] = d[k]
            return next
        })
    }, [record])
    const set = <K extends keyof T>(key: K, value: T[K]) => setDraft(d => ({...d, [key]: value}))
    const dirty = JSON.stringify(draft) !== JSON.stringify(record)
    return {draft, set, setDraft, dirty, reset: () => setDraft(record)}
}

export function SubstationPanels(props: PanelsProps) {
    const ed = useNetworkEditor()
    const sel = ed.selection
    const {yard, layout} = props
    if (sel) {
        switch (sel.collection) {
            case 'buses': {
                const r = layout.buses.find(b => b.id === sel.id)
                if (r) return <BusPanel {...props} record={r}/>
                break
            }
            case 'bays': {
                const r = layout.bays.find(b => b.id === sel.id)
                if (r) return <BayPanel {...props} record={r}/>
                break
            }
            case 'equipments': {
                const r = layout.equipments.find(e => e.id === sel.id)
                if (r) return <EquipmentPanel {...props} record={r}/>
                break
            }
            case 'takeOffs': {
                const r = layout.takeOffs.find(t => t.id === sel.id)
                if (r) return <TakeOffPanel {...props} record={r}/>
                break
            }
            case 'connections': {
                const r = layout.connections.find(c => c.id === sel.id)
                if (r) return <ConnectionPanel {...props} record={r}/>
                break
            }
            case 'yardConnections': {
                const r = ed.doc.yardConnections.find(c => c.id === sel.id)
                if (r) return <YardConnectionPanel {...props} record={r}/>
                break
            }
        }
    }
    return <YardPanel {...props} record={yard}/>
}

function Header({title, badge, onDelete, deleteLabel, rename}: { title: string; badge?: string; onDelete?: () => void; deleteLabel?: string; rename?: { collection: NetworkCollectionName; id: string; onRenamed?: (id: string) => void; auto?: string } }) {
    return (
        <div className="panel-header">
            <h3 style={{margin: 0}}>{title}</h3>
            {rename && <IdEditor collection={rename.collection} id={rename.id} onRenamed={rename.onRenamed} auto={rename.auto}/>}
            {badge && <span className="badge">{badge}</span>}
            <span className="spacer"/>
            {onDelete && <button type="button" className="small danger" onClick={onDelete}>{deleteLabel ?? 'Delete'}</button>}
        </div>
    )
}

function ApplyBar({dirty, onApply, onReset, extra}: { dirty: boolean; onApply: () => void; onReset: () => void; extra?: ReactNode }) {
    return (
        <div className="toolbar" style={{marginTop: 10}}>
            <button type="button" className="primary small" disabled={!dirty} onClick={onApply}>Apply</button>
            <button type="button" className="small" disabled={!dirty} onClick={onReset}>Reset</button>
            {extra && <span className="spacer" style={{flex: 1}}/>}
            {extra}
        </div>
    )
}

/* ---------- yard ---------- */

function YardPanel({meta, record, group, layout, navigate}: PanelsProps & { record: SubstationRecord }) {
    const ed = useNetworkEditor()
    const d = useDraft(record)
    const [shiftNote, setShiftNote] = useState<string | null>(null)
    useEffect(() => setShiftNote(null), [record.id])
    /** One journaled step moving the yard's rows or columns; a refusal is shown under the buttons. */
    const shift = (plan: ReturnType<typeof shiftYardRowsOps>) => {
        setShiftNote(plan.error ?? null)
        if (!plan.error) ed.apply(plan.ops)
    }
    return (
        <>
            <div className="panel">
                <Header title={`Yard ${record.yardName}`} rename={{collection: 'substations', id: record.id, auto: draftNaming(ed.doc, 'substations', d.draft)?.id, onRenamed: id => navigate(`/network/${ed.networkId}/substation/${id}`)}} onDelete={() => {
                    if (window.confirm(`Delete yard ${group.groupName} ${record.yardName} with everything in it?`)) {
                        ed.apply(cascadeDeleteOps(ed.doc, 'substations', record.id))
                        navigate(`/network/${ed.networkId}/substations`)
                    }
                }}/>
                <p className="small muted">Site <a href={hrefTo(`/network/${ed.networkId}/map`)} onClick={() => ed.select({collection: 'substationGroups', id: group.id})}>{group.groupName}</a> · {layout.bays.length} bays, {layout.buses.length} buses, {layout.equipments.length} equipment, {layout.takeOffs.length} take-offs</p>
                <div className="form-grid" style={{gridTemplateColumns: '1fr 1fr'}}>
                    <TextField label="Yard name" value={d.draft.yardName} onChange={v => d.set('yardName', v.toUpperCase())} placeholder={yardNameForVoltage(d.draft.voltage)} hint={`Left empty: ${yardNameForVoltage(d.draft.voltage)} (from the voltage)`}
                               action={{label: 'auto', title: `Use the rule name ${yardNameForVoltage(d.draft.voltage)}`, disabled: d.draft.yardName === yardNameForVoltage(d.draft.voltage), onClick: () => d.set('yardName', yardNameForVoltage(d.draft.voltage) ?? d.draft.yardName)}}/>
                    <TextField label="Display name" value={d.draft.name} onChange={v => d.set('name', v || undefined)}/>
                    <SelectField label="Voltage" value={d.draft.voltage} options={meta.enums.transmissionVoltage} onChange={v => d.set('voltage', v as TransmissionVoltage)}/>
                    <SelectField label="Arrangement" value={d.draft.arrangement} options={ARRANGEMENTS} allowEmpty onChange={v => d.set('arrangement', v as SubstationRecord['arrangement'])}/>
                    <CheckboxField label="Planned (not built yet): drawn in grey; built take-offs and connections here get a warning" checked={!!d.draft.planned} onChange={v => d.set('planned', v || undefined)} className="span-all"/>
                </div>
                <ApplyBar dirty={d.dirty} onReset={d.reset} onApply={() => ed.apply([{type: 'upsert', collection: 'substations', record: {...d.draft, yardName: d.draft.yardName.trim() || yardNameForVoltage(d.draft.voltage) || d.draft.yardName}}])}
                          extra={<RegenerateButton target={{collection: 'substations', id: record.id}} label="Auto id from site & yard"/>}/>
                <h4 style={{margin: '14px 0 2px'}}>Move the whole yard</h4>
                <p className="hint" style={{margin: '0 0 6px'}}>Applied at once: every bus, equipment and take-off row up or down by one, or every bay column left or right by one (nothing goes below 0).</p>
                <div className="toolbar">
                    <button type="button" className="small" onClick={() => shift(shiftYardRowsOps(ed.doc, record.id, 1))} title="All rows + 1">▲ rows up</button>
                    <button type="button" className="small" onClick={() => shift(shiftYardRowsOps(ed.doc, record.id, -1))} title="All rows − 1">▼ rows down</button>
                    <span style={{width: 8}}/>
                    <button type="button" className="small" onClick={() => shift(shiftYardColumnsOps(ed.doc, record.id, -1))} title="All bay columns − 1">◀ bays left</button>
                    <button type="button" className="small" onClick={() => shift(shiftYardColumnsOps(ed.doc, record.id, 1))} title="All bay columns + 1">▶ bays right</button>
                </div>
                {shiftNote && <Notice kind="error">{shiftNote}</Notice>}
            </div>
            <YardTemplatePanel yard={record} layout={layout}/>
            <YardItemsPanel layout={layout}/>
            <div className="panel">
                <h3>How to edit</h3>
                <ul className="small muted" style={{paddingLeft: 18, margin: 0}}>
                    <li>Add buses and bays with the toolbar; set their row / column in the panel to arrange the diagram.</li>
                    <li>Select a bay, pick an equipment type and add it; terminals are the small circles.</li>
                    <li>Add a take-off to the bay where a line leaves; lines on the map start from take-offs.</li>
                    <li>Press <span className="kbd">C</span> and click two nodes to wire them. Green nodes are wired.</li>
                </ul>
            </div>
        </>
    )
}

const ARRANGEMENTS = ['SINGLE_BUS', 'DOUBLE_BUS', 'TRIPLE_BUS', 'SINGLE_MAIN_AND_TRANSFER_BUS', 'DOUBLE_MAIN_AND_TRANSFER_BUS', 'TRIPLE_MAIN_AND_TRANSFER_BUS', 'BREAKER_AND_A_HALF', 'RING', 'MESH']

type DeployNote = { kind: 'ok' | 'warn' | 'error'; text: string } | null

/** Deploys a yard template: the arrangement, its buses and a number of empty bays. */
function YardTemplatePanel({yard, layout}: { yard: SubstationRecord; layout: SubstationLayout }) {
    const ed = useNetworkEditor()
    const {templates, loading} = useTemplates(TemplateKind.SUBSTATION_YARD)
    const [templateId, setTemplateId] = useState('')
    const [bayCount, setBayCount] = useState(1)
    const [note, setNote] = useState<DeployNote>(null)
    const picked = useAsync(async () => templateId ? (await api.templates.get(TemplateKind.SUBSTATION_YARD, templateId)).data as SubstationYardTemplate : undefined, [templateId])
    const data = picked.data
    const plan = useMemo(() => data ? deployYardTemplateOps(ed.doc, yard.id, data, Math.max(0, Math.floor(bayCount || 0))) : undefined, [ed.doc, yard.id, data, bayCount])
    const deploy = () => {
        if (!data || !plan) return
        if (plan.error) {
            setNote({kind: 'error', text: plan.error})
            return
        }
        if (plan.ops.length) ed.apply(plan.ops)
        const parts = [
            yard.arrangement === data.arrangement ? `arrangement ${data.arrangement} kept` : `arrangement set to ${data.arrangement}`,
            `${plan.buses.length} bus${plan.buses.length === 1 ? '' : 'es'} added${plan.keptBuses.length ? ` (${plan.keptBuses.join(', ')} already there)` : ''}`,
            `${plan.bays.length} bay${plan.bays.length === 1 ? '' : 's'} added${plan.bays.length ? ` (${plan.bays.map(b => b.bayNumber).join(', ')})` : ''}`,
        ]
        setNote({kind: plan.ops.length ? 'ok' : 'warn', text: plan.ops.length ? `Deployed ${data.name}: ${parts.join('; ')}.` : `Nothing to deploy: ${parts.join('; ')}.`})
    }
    return (
        <div className="panel">
            <h3>From yard template</h3>
            <p className="small muted" style={{marginTop: 0}}>Sets the arrangement, adds the template's buses (buses of the same type and number are kept) and empty bays in new columns. Fill the bays from bay templates in the bay panel.</p>
            <div className="form-grid" style={{gridTemplateColumns: '1fr 1fr'}}>
                <SelectField label="Yard template" value={templateId} allowEmpty emptyLabel={loading ? 'Loading…' : templates.length ? 'Select…' : 'No yard templates yet'} options={templates.map(t => ({value: t.id, label: t.name}))}
                             onChange={v => {
                                 setTemplateId(v ?? '')
                                 setNote(null)
                             }} className="span-all"/>
                <NumberField label="Bays to add" value={bayCount} min={0} step={1} onChange={v => setBayCount(v ?? 0)} hint="Empty bays in the next columns"/>
                <div className="field">
                    <label>&nbsp;</label>
                    <button type="button" className="primary small" onClick={deploy} disabled={!data || picked.loading}>Deploy</button>
                </div>
            </div>
            {picked.error && <Notice kind="error">{picked.error.message}</Notice>}
            {data && (
                <p className="small muted">
                    {data.arrangement}{data.voltage ? ` · ${data.voltage}` : ''} · buses: {data.buses.length ? data.buses.map(b => `${b.name} (row ${b.row})`).join(', ') : 'none'}
                    {plan?.keptBuses.length ? ` · already here: ${plan.keptBuses.join(', ')}` : ''}
                </p>
            )}
            {note && <Notice kind={note.kind}>{note.text}</Notice>}
        </div>
    )
}

/** Adds the equipment of a bay template to one bay, upwards or downwards from a start row, without connections. */
function BayTemplatePanel({bay, yard}: { bay: SubstationBayRecord; yard: SubstationRecord }) {
    const ed = useNetworkEditor()
    const {templates, loading} = useTemplates(TemplateKind.SUBSTATION_BAY)
    // the summaries do not carry the arrangements: load every bay template once to filter by the yard's arrangement
    const templateIds = templates.map(t => t.id).join(',')
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the ids: the summaries array is a new object on every render while loading
    const loaded = useAsync(async () => Promise.all(templateIds.split(',').filter(Boolean).map(async id => ({id, data: (await api.templates.get(TemplateKind.SUBSTATION_BAY, id)).data as SubstationBayTemplate}))), [templateIds])
    const suitable = useMemo(() => (loaded.data ?? []).filter(t => yard.arrangement && t.data.arrangements.includes(yard.arrangement)), [loaded.data, yard.arrangement])
    const [templateId, setTemplateId] = useState('')
    const [direction, setDirection] = useState<DeployDirection>('up')
    const [startRow, setStartRow] = useState<number | undefined>(undefined)
    const [note, setNote] = useState<DeployNote>(null)
    useEffect(() => setNote(null), [bay.id])
    const data = suitable.find(t => t.id === templateId)?.data
    const autoStart = defaultStartRow(ed.doc, yard.id, direction)
    const deploy = () => {
        if (!data) return
        const plan = deployBayTemplateOps(ed.doc, bay.id, data, direction, startRow)
        if (plan.error) {
            setNote({kind: 'error', text: plan.error})
            window.alert(`Bay template ${data.name} not deployed: ${plan.error}`)
            return
        }
        ed.apply(plan.ops)
        const rows = plan.equipments.map(e => e.row)
        setNote({
            kind: 'ok',
            text: `Added ${plan.equipments.length} equipment to bay ${bay.bayNumber}, ${direction} from row ${plan.start} (rows ${Math.min(...rows)}–${Math.max(...rows)})${plan.takeOff ? `, with take-off ${plan.takeOff.lineName} at row ${plan.takeOff.row} heading its column` : plan.takeOffId ? ', line side in the column of the existing take-off' : ''}, no connections: use Connect bay to wire them.`,
        })
    }
    return (
        <>
            <h4 style={{margin: '14px 0 6px'}}>Equipment from bay template</h4>
            {!yard.arrangement
                ? <p className="hint" style={{margin: '0 0 6px'}}>Set the arrangement of the yard first (yard panel or a yard template): bay templates are offered for the arrangements they suit only.</p>
                : <p className="hint" style={{margin: '0 0 6px'}}>Templates that suit the {yard.arrangement} arrangement. Equipment is placed at start row ± sequence; the start row defaults to the lowest bus going up and the highest bus going down.</p>}
            <div className="form-grid" style={{gridTemplateColumns: '1fr 1fr'}}>
                <SelectField label="Bay template" value={templateId} allowEmpty
                             emptyLabel={loading || loaded.loading ? 'Loading…' : !yard.arrangement ? 'Set the yard arrangement first' : suitable.length ? 'Select…' : `No bay template suits ${yard.arrangement}`}
                             options={suitable.map(t => ({value: t.id, label: `${t.data.name} · ${BAY_TEMPLATE_TYPE_LABELS[t.data.bayTemplateType] ?? t.data.bayTemplateType}`}))}
                             onChange={v => {
                                 setTemplateId(v ?? '')
                                 setNote(null)
                             }} className="span-all"/>
                <SelectField label="Direction" value={direction} options={[{value: 'up', label: 'Up (from the lowest bus)'}, {value: 'down', label: 'Down (from the highest bus)'}]} onChange={v => setDirection((v as DeployDirection) ?? 'up')}/>
                <NumberField label="Start row" value={startRow} min={0} step={1} onChange={v => setStartRow(v ?? undefined)} hint={`Left empty: ${autoStart}`}/>
            </div>
            {data && <p className="small muted">{[...data.equipments].sort((a, b) => a.sequence - b.sequence).map(e => `${e.sequence}: ${equipmentTypeLabels[e.equipmentType] ?? e.equipmentType}${e.lineSide ? ' ↑' : ''}${e.busTie ? ' ⇔' : ''}`).join(' · ')}</p>}
            <div className="toolbar">
                <button type="button" className="primary small" onClick={deploy} disabled={!data}>Add equipment</button>
            </div>
            {note && <Notice kind={note.kind}>{note.text}</Notice>}
        </>
    )
}

/* ---------- bus ---------- */

function BusPanel({meta, record}: PanelsProps & { record: SubstationBusRecord }) {
    const ed = useNetworkEditor()
    const d = useDraft(record)
    const wires = ed.doc.connections.filter(c => c.nodes.some(n => n.kind === NetworkNodeKind.SUBSTATION_BUS && n.id === record.id))
    const auto = useAutoName(ed.doc, 'buses', {...d.draft, name: undefined})
    return (
        <div className="panel">
            <Header title={`Bus ${record.busNumber ?? ''}`} rename={{collection: 'buses', id: record.id, auto: draftNaming(ed.doc, 'buses', d.draft)?.id}} onDelete={() => ed.apply(cascadeDeleteOps(ed.doc, 'buses', record.id)) && ed.select(null)}/>
            <div className="form-grid" style={{gridTemplateColumns: '1fr 1fr'}}>
                <SelectField label="Type" value={d.draft.busType} options={['MAIN', 'TRANSFER']} onChange={v => d.set('busType', v as SubstationBusRecord['busType'])}/>
                <TextField label="Bus number" value={d.draft.busNumber} onChange={v => d.set('busNumber', v || undefined)}/>
                <TextField label="Bay number" value={d.draft.bayNumber} onChange={v => d.set('bayNumber', v || undefined)} hint="e.g. 8001"/>
                <NumberField label="Row" value={d.draft.row} min={0} step={1} onChange={v => d.set('row', v ?? 0)} hint="Vertical position: 0 is the bottom of the diagram"/>
                <SelectField label="Voltage" value={d.draft.voltage} options={meta.enums.transmissionVoltage} allowEmpty onChange={v => d.set('voltage', v as TransmissionVoltage | undefined)}/>
                <TextField label="Name" value={d.draft.name} onChange={v => d.set('name', v || undefined)} placeholder={auto} hint={`Left empty: ${auto}`}
                           action={{label: 'auto', title: `Use the rule name ${auto}`, disabled: d.draft.name === auto, onClick: () => d.set('name', auto)}}/>
            </div>
            <ApplyBar dirty={d.dirty} onReset={d.reset} onApply={() => ed.apply([{type: 'upsert', collection: 'buses', record: {...d.draft, name: d.draft.name || auto}}])}
                      extra={<RegenerateButton target={{collection: 'buses', id: record.id}}/>}/>
            <p className="small muted" style={{marginTop: 10}}>Wired in {wires.length} connection{wires.length === 1 ? '' : 's'}.</p>
        </div>
    )
}

/* ---------- bay ---------- */

function BayPanel({meta, record, layout, yard}: PanelsProps & { record: SubstationBayRecord }) {
    const ed = useNetworkEditor()
    const d = useDraft(record)
    const items = layout.equipments.filter(e => e.bayId === record.id).length + layout.takeOffs.filter(t => t.bayId === record.id).length
    const auto = useAutoName(ed.doc, 'bays', d.draft)
    const wired = bayConnectionCount(ed.doc, record.id)
    /** Outcome of the last Connect / Disconnect bay. */
    const [wireNote, setWireNote] = useState<{ kind: 'ok' | 'warn' | 'error'; text: string } | null>(null)
    useEffect(() => setWireNote(null), [record.id])
    const wireBay = () => {
        const plan = wireBayOps(ed.doc, record.id)
        if (plan.ops.length) ed.apply(plan.ops)
        const tied = Object.entries(plan.attached).map(([id, at]) => `${layout.takeOffs.find(t => t.id === id)?.lineName ?? 'line-side equipment'} at ${at}`)
        const done = plan.ops.length ? `${plan.joined.length} join${plan.joined.length === 1 ? '' : 's'}${tied.length ? `; take-off column tied to the bay column: ${tied.join(', ')}` : ''}.` : 'Nothing to wire: the stack is already connected or has fewer than two items.'
        setWireNote({kind: plan.errors.length ? 'error' : plan.ops.length ? 'ok' : 'warn', text: [done, ...plan.errors].join(' ')})
    }
    const unwireBay = () => {
        const ops = unwireBayOps(ed.doc, record.id)
        if (!ops.length) return
        if (!window.confirm(`Remove the equipment and take-offs of bay ${record.bayNumber} from ${ops.length} connection(s)? Yard links are kept.`)) return
        ed.apply(ops)
        setWireNote({kind: 'ok', text: `Bay ${record.bayNumber} disconnected (${ops.length} connection${ops.length === 1 ? '' : 's'} changed or removed).`})
    }
    return (
        <div className="panel">
            <Header title={`Bay ${record.bayNumber}`} rename={{collection: 'bays', id: record.id, auto: draftNaming(ed.doc, 'bays', d.draft)?.id}} onDelete={() => {
                if (!items || window.confirm(`Delete bay ${record.bayNumber} and its ${items} item(s)? Take-offs are kept without a bay.`)) {
                    ed.apply(cascadeDeleteOps(ed.doc, 'bays', record.id))
                    ed.select(null)
                }
            }}/>
            <div className="form-grid" style={{gridTemplateColumns: '1fr 1fr'}}>
                <TextField label="Bay number" value={d.draft.bayNumber} onChange={v => d.set('bayNumber', v)}/>
                <NumberField label="Column" value={d.draft.column} min={0} step={1} onChange={v => d.set('column', v ?? 0)} hint="Horizontal position"/>
                <TextField label="Name" value={d.draft.name} onChange={v => d.set('name', v || undefined)} placeholder={auto} hint={`Left empty: ${auto}`}
                           action={{label: 'auto', title: `Use the rule name ${auto}`, disabled: d.draft.name === auto, onClick: () => d.set('name', auto)}}/>
                <SelectField label="Voltage" value={d.draft.voltage} options={meta.enums.transmissionVoltage} allowEmpty onChange={v => d.set('voltage', v as TransmissionVoltage | undefined)}/>
            </div>
            <ApplyBar dirty={d.dirty} onReset={d.reset} onApply={() => ed.apply([{type: 'upsert', collection: 'bays', record: {...d.draft, name: d.draft.name || auto}}])}
                      extra={<RegenerateButton target={{collection: 'bays', id: record.id}}/>}/>
            <h4 style={{margin: '14px 0 6px'}}>Wiring</h4>
            <p className="hint" style={{margin: '0 0 6px'}}>
                Connect joins the stack of this bay from bottom to top: buses, equipment and take-offs of the bay column in row order, then the
                equipment of each take-off in the take-off column, tied to the bay column where two disconnecting switches meet (the nearest such point).
                Nodes already wired join their connection; nodes in a yard link are left alone.
            </p>
            <div className="toolbar">
                <button type="button" className="small" onClick={wireBay} disabled={items === 0} title="Wire everything stacked in this bay">Connect bay</button>
                <button type="button" className="small danger" onClick={unwireBay} disabled={wired === 0} title="Remove this bay's equipment and take-offs from every connection">Disconnect bay{wired ? ` (${wired})` : ''}</button>
            </div>
            {wireNote && <Notice kind={wireNote.kind}>{wireNote.text}</Notice>}
            <BayTemplatePanel bay={record} yard={yard}/>
        </div>
    )
}

/* ---------- equipment ---------- */

function EquipmentPanel({meta, record, layout, yard}: PanelsProps & { record: SubstationEquipmentRecord }) {
    const ed = useNetworkEditor()
    const d = useDraft(record)
    const {templates} = useTemplates(TemplateKind.POWER_TRANSFORMER)
    const wired = ed.doc.connections.filter(c => c.nodes.some(n => n.kind === NetworkNodeKind.EQUIPMENT_TERMINAL && n.id === record.id))
    const transformer = isTransformerType(d.draft.equipmentType)
    const auto = useAutoName(ed.doc, 'equipments', d.draft)

    const changeType = (type: SubstationEquipmentType) => {
        d.setDraft(x => {
            if (isTransformerType(type)) {
                const windings = x.windings ?? defaultTransformerWindings(yard.voltage)
                return {...x, equipmentType: type, windings, terminals: terminalsFromWindings(windings, x.terminals)}
            }
            return {...x, equipmentType: type, windings: undefined, template: undefined, terminals: x.terminals.length === defaultTerminals(type).length && !isTransformerType(x.equipmentType) ? x.terminals : defaultTerminals(type)}
        })
    }
    /** Transformers edit windings; their terminals follow (one per winding). */
    const windings = transformer ? d.draft.windings ?? defaultTransformerWindings(yard.voltage) : undefined
    const windingIssues = useMemo(() => windings ? validateTransformerWindings(windings) : [], [windings])
    const setWindings = (w: NonNullable<SubstationEquipmentRecord['windings']>) => d.setDraft(x => ({...x, windings: w, terminals: terminalsFromWindings(w, x.terminals)}))

    const applyTemplate = async (id: string | undefined) => {
        if (!id) {
            d.setDraft(x => ({...x, template: undefined}))
            return
        }
        try {
            const t = await api.templates.get(TemplateKind.POWER_TRANSFORMER, id)
            const data = t.data as PowerTransformerTemplate
            d.setDraft(x => ({
                ...x,
                template: {kind: TemplateKind.POWER_TRANSFORMER, id},
                windings: JSON.parse(JSON.stringify(data.windings)),
                terminals: terminalsFromWindings(data.windings, x.terminals),
                attributes: {...(x.attributes ?? {}), modules: data.modules},
            }))
        } catch (e) {
            window.alert((e as Error).message)
        }
    }

    /** Row and purpose flags apply at once, on the record as saved (the draft keeps its other unapplied edits). */
    const setNow = (patch: Partial<Pick<SubstationEquipmentRecord, 'row' | 'lineSide' | 'busTie'>>) =>
        ed.apply([{type: 'upsert', collection: 'equipments', record: {...record, ...patch}}])

    const commit = () => {
        // Drop connection nodes that refer to terminals that no longer exist.
        const draft = transformer ? {...d.draft, windings, terminals: terminalsFromWindings(windings!, d.draft.terminals)} : {...d.draft, windings: undefined}
        const keys = new Set(draft.terminals.map(t => t.key))
        const ops = [{type: 'upsert' as const, collection: 'equipments' as const, record: {...draft, name: draft.name || auto}}]
        for (const c of wired) {
            const nodes = c.nodes.filter(n => !(n.kind === NetworkNodeKind.EQUIPMENT_TERMINAL && n.id === record.id && !keys.has(n.terminal!)))
            if (nodes.length !== c.nodes.length) {
                if (nodes.length < 2) ops.push({type: 'delete', collection: 'connections', id: c.id} as never)
                else ops.push({type: 'upsert', collection: 'connections', record: {...c, nodes}} as never)
            }
        }
        ed.apply(ops)
    }

    return (
        <div className="panel">
            <Header title={record.code} badge={equipmentTypeLabels[record.equipmentType]} rename={{collection: 'equipments', id: record.id, auto: draftNaming(ed.doc, 'equipments', d.draft)?.id}} onDelete={() => {
                ed.apply(cascadeDeleteOps(ed.doc, 'equipments', record.id))
                ed.select(null)
            }}/>
            <div className="form-grid" style={{gridTemplateColumns: '1fr 1fr'}}>
                <TextField label="Code" value={d.draft.code} onChange={v => d.set('code', v)}/>
                <SelectField label="Type" value={d.draft.equipmentType} options={(Object.keys(equipmentTypeLabels) as SubstationEquipmentType[]).map(t => ({value: t, label: equipmentTypeLabels[t]}))}
                             onChange={v => changeType(v as SubstationEquipmentType)}/>
                <SelectField label="Bay" value={d.draft.bayId} options={layout.bays.map(b => ({value: b.id, label: `BAY ${b.bayNumber}`}))} onChange={v => d.set('bayId', v ?? '')}/>
                <SelectField label="In take-off column of" value={d.draft.takeOffId} allowEmpty emptyLabel="no: in the bay column"
                             options={layout.takeOffs.filter(t => t.bayId === d.draft.bayId).map(t => ({value: t.id, label: t.lineName}))}
                             onChange={v => d.set('takeOffId', v || undefined)} className="span-all"
                             hint="Draws the equipment in the bay's take-off column (right of the bay column) at its row; wire it in connect mode"/>
                <TextField label="Brand" value={d.draft.brand} onChange={v => d.set('brand', v || undefined)}/>
                <TextField label="Model" value={d.draft.model} onChange={v => d.set('model', v || undefined)}/>
                {transformer && (
                    <SelectField label="Transformer template" value={d.draft.template?.id} options={templates.map(t => ({value: t.id, label: t.name}))} allowEmpty
                                 onChange={v => void applyTemplate(v)} hint="Fills one terminal per winding" className="span-all"/>
                )}
                <TextField label="Name" value={d.draft.name} onChange={v => d.set('name', v || undefined)} placeholder={auto} hint={`Left empty: ${auto} (the code)`} className="span-all"
                           action={{label: 'auto', title: `Use the rule name ${auto}`, disabled: d.draft.name === auto, onClick: () => d.set('name', auto)}}/>
            </div>
            {transformer && windings ? (
                <>
                    <h4 className="muted" style={{marginTop: 12}}>Windings</h4>
                    <p className="hint" style={{margin: '0 0 6px'}}>Side, wiring, tap changer, voltage and the ratings per cooling mode of each winding; the terminals are one per winding (key, side, voltage). Apply to save.</p>
                    <WindingsEditor windings={windings} onChange={setWindings} issues={windingIssues} meta={meta}/>
                </>
            ) : (
                <>
            <h4 className="muted" style={{marginTop: 12}}>Terminals</h4>
            <table>
                <thead>
                <tr>
                    <th>Key</th>
                    <th>Label</th>
                    <th>Voltage</th>
                    <th style={{width: 1}}/>
                </tr>
                </thead>
                <tbody>
                {d.draft.terminals.map((t, i) => (
                    <tr key={i}>
                        <td><input type="text" className="mono" value={t.key} onChange={e => d.set('terminals', d.draft.terminals.map((x, n) => n === i ? {...x, key: e.target.value.toUpperCase()} : x))}/></td>
                        <td><input type="text" value={t.label ?? ''} onChange={e => d.set('terminals', d.draft.terminals.map((x, n) => n === i ? {...x, label: e.target.value || undefined} : x))}/></td>
                        <td>
                            <select value={t.voltage ?? ''} onChange={e => d.set('terminals', d.draft.terminals.map((x, n) => n === i ? {...x, voltage: (e.target.value || undefined) as TransmissionVoltage | undefined} : x))}>
                                <option value="">–</option>
                                {meta.enums.transmissionVoltage.map(v => <option key={v} value={v}>{enumLabel(v)}</option>)}
                            </select>
                        </td>
                        <td><button type="button" className="small danger" disabled={d.draft.terminals.length <= 1} onClick={() => d.set('terminals', d.draft.terminals.filter((_, n) => n !== i))}>×</button></td>
                    </tr>
                ))}
                </tbody>
            </table>
            <div className="toolbar" style={{marginTop: 6}}>
                <button type="button" className="small" onClick={() => d.set('terminals', [...d.draft.terminals, {key: `T${d.draft.terminals.length + 1}`}])}>Add terminal</button>
                <button type="button" className="small" onClick={() => d.set('terminals', defaultTerminals(d.draft.equipmentType))}>Reset to default</button>
            </div>
                </>
            )}
            <ApplyBar dirty={d.dirty} onReset={d.reset} onApply={commit} extra={<RegenerateButton target={{collection: 'equipments', id: record.id}}/>}/>
            <h4 style={{margin: '14px 0 2px'}}>Position and purpose</h4>
            <p className="hint" style={{margin: '0 0 6px'}}>Applied at once (no Apply needed); the fields above are not touched.</p>
            <div className="form-grid" style={{gridTemplateColumns: '1fr 1fr'}}>
                <NumberField label="Row" value={record.row} min={0} step={1} onChange={v => setNow({row: v ?? 0})} hint="Vertical position: 0 is the bottom (same rows in the bay and take-off columns)"/>
                <div className="field">
                    <label>&nbsp;</label>
                    <div className="toolbar">
                        <button type="button" className="small" onClick={() => setNow({row: record.row + 1})} title="One row up">▲ up</button>
                        <button type="button" className="small" onClick={() => setNow({row: record.row - 1})} disabled={record.row <= 0} title="One row down">▼ down</button>
                    </div>
                </div>
                <CheckboxField label={`Line side (↑): drawn in the line (take-off) column of the bay${record.equipmentType === SubstationEquipmentType.POWER_TRANSFORMER ? ' — a power transformer belongs there, like a take-off' : '; what a transformer connects to'}`} checked={!!record.lineSide} onChange={v => setNow({lineSide: v || undefined})}/>
                <CheckboxField label="Bus tie (⇔): ties buses / the transfer bus" checked={!!record.busTie} onChange={v => setNow({busTie: v || undefined})}/>
            </div>
            <p className="small muted" style={{marginTop: 10}}>
                {record.terminals.map(t => {
                    const node: NetworkNodeRef = {kind: NetworkNodeKind.EQUIPMENT_TERMINAL, id: record.id, terminal: t.key}
                    const c = wired.find(w => w.nodes.some(n => nodeKey(n) === nodeKey(node)))
                    return <span key={t.key} style={{marginRight: 10}}>{t.key}: {c ? <a href="#" onClick={e => {
                        e.preventDefault()
                        ed.select({collection: 'connections', id: c.id})
                    }}>{c.id}</a> : <span className="muted">free</span>}</span>
                })}
            </p>
        </div>
    )
}

/* ---------- take-off ---------- */

function TakeOffPanel({meta, yard, record, layout, group, navigate}: PanelsProps & { record: SubstationTakeOffRecord }) {
    const ed = useNetworkEditor()
    const d = useDraft(record)
    const usage = takeOffUsage(ed.doc, record.id)
    const line = usage.connection
    const auto = useAutoName(ed.doc, 'takeOffs', d.draft)
    const toMap = (sel: { collection: 'circuits' | 'lines' | 'connections'; id: string }) => {
        ed.select(sel)
        navigate(`/network/${ed.networkId}/map`)
    }
    return (
        <div className="panel">
            <Header title={`Take-off ${record.lineName}`} rename={{collection: 'takeOffs', id: record.id, auto: draftNaming(ed.doc, 'takeOffs', d.draft)?.id}} onDelete={() => {
                // a take-off carrying a circuit end is never deleted from here: detach the circuit (or delete the line) on the map first
                if (usage.circuits.length) {
                    window.alert(`Take-off ${record.lineName} is in use by ${describeTakeOffUsage(ed.doc, record.id)}.\nDetach the circuit end, or delete the line with its circuits, on the map first.`)
                    return
                }
                ed.apply(cascadeDeleteOps(ed.doc, 'takeOffs', record.id))
                ed.select(null)
            }}/>
            <div className="form-grid" style={{gridTemplateColumns: '1fr 1fr'}}>
                {!d.draft.takeOffColumn && <p className="small warn-dot span-all" style={{margin: 0}}>⚠ Drawn in the bay column. Tick "take-off column" to move it right of the bay, where take-offs and their equipment belong.</p>}
                <TextField label="Line name" value={d.draft.lineName} onChange={v => d.set('lineName', v.toUpperCase())} hint="e.g. 230KV_CTI_L1; or pick the site the line goes to"/>
                <SelectField label="Line to site" value={undefined} emptyLabel="pick a site…" options={ed.doc.substationGroups.filter(g => g.id !== group.id).sort((a, b) => a.groupName.localeCompare(b.groupName)).map(g => ({value: g.id, label: g.groupName}))}
                             onChange={v => {
                                 const lineName = v && takeOffLineName(ed.doc, record.substationId, v, d.draft.voltage)
                                 if (lineName) d.set('lineName', lineName)
                             }} hint="Sets the line name to <voltage>_<site code>_L<n>"/>
                <SelectField label="Voltage" value={d.draft.voltage} options={meta.enums.transmissionVoltage} allowEmpty emptyLabel={`yard voltage (${yard.voltage})`}
                             onChange={v => d.set('voltage', v as TransmissionVoltage | undefined)} className="span-all"
                             hint="Set only when the line leaves at another voltage than the yard's (the secondary or auxiliary side of a transformer): colours the take-off, energizes attached circuits and prefixes the line name"/>
                <SelectField label="Bay" value={d.draft.bayId} options={layout.bays.map(b => ({value: b.id, label: `BAY ${b.bayNumber}`}))} allowEmpty emptyLabel="(no bay yet)" onChange={v => d.set('bayId', v)}/>
                <NumberField label="Row" value={d.draft.row} min={0} step={1} onChange={v => d.set('row', v)} hint="Vertical position, 0 = bottom (auto when empty: above the bay's equipment)"/>
                <TextField label="Name" value={d.draft.name} onChange={v => d.set('name', v || undefined)} placeholder={auto} hint={`Left empty: ${auto} (the line name)`}
                           action={{label: 'auto', title: `Use the rule name ${auto}`, disabled: d.draft.name === auto, onClick: () => d.set('name', auto)}}/>
                <CheckboxField label="Take-off column: drawn right of the bay column, with the equipment flagged for it (the arrow points up, or down when wired from above)" checked={!!d.draft.takeOffColumn} onChange={v => d.set('takeOffColumn', v || undefined)} className="span-all"/>
                <CheckboxField label="Planned (not built yet): drawn in grey; a built connection using it gets a warning" checked={!!d.draft.planned} onChange={v => d.set('planned', v || undefined)} className="span-all"/>
            </div>
            <ApplyBar dirty={d.dirty} onReset={d.reset} onApply={() => ed.apply([{type: 'upsert', collection: 'takeOffs', record: {...d.draft, name: d.draft.name || auto}}])}
                      extra={<RegenerateButton target={{collection: 'takeOffs', id: record.id}}/>}/>
            <h4 className="muted" style={{marginTop: 12}}>On the map</h4>
            {line ? (
                <div className="small">
                    <p style={{margin: '0 0 4px'}}>In use · node <a href="#" onClick={e => { e.preventDefault(); toMap({collection: 'connections', id: line.id}) }}>{line.name ?? line.id}</a> (delete is refused while a circuit ends here)</p>
                    <table>
                        <thead><tr><th>Circuit</th><th>Line</th></tr></thead>
                        <tbody>
                        {usage.circuits.map(c => {
                            const lines = ed.doc.lines.filter(l => l.circuitIds.includes(c.id))
                            return (
                                <tr key={c.id}>
                                    <td><a href="#" onClick={e => { e.preventDefault(); toMap({collection: 'circuits', id: c.id}) }}>{c.name}</a>{c.voltage ? <span className="muted"> {c.voltage}</span> : null}</td>
                                    <td>{lines.length ? lines.map((l, i) => <span key={l.id}>{i ? ', ' : ''}<a href="#" onClick={e => { e.preventDefault(); toMap({collection: 'lines', id: l.id}) }}>{l.name}</a></span>) : <span className="muted">not in a line</span>}</td>
                                </tr>
                            )
                        })}
                        </tbody>
                    </table>
                </div>
            ) : <p className="small muted">Free: not connected to a circuit yet. On the map, use "Add circuit" or the line wizard and pick this take-off as an end.</p>}
        </div>
    )
}

/* ---------- auto names & mass regeneration ---------- */

type AutoNamed =
    | { collection: 'buses'; draft: SubstationBusRecord }
    | { collection: 'bays'; draft: SubstationBayRecord }
    | { collection: 'equipments'; draft: SubstationEquipmentRecord }
    | { collection: 'takeOffs'; draft: SubstationTakeOffRecord }

/** The name the model rules give a record *as it is being edited* (from its code / number / line name), shown as placeholder and used when the name is left empty. */
function useAutoName<C extends AutoNamed['collection']>(doc: NetworkDocument, collection: C, draft: Extract<AutoNamed, { collection: C }>['draft']): string {
    return useMemo(() => {
        switch (collection) {
            case 'buses': {
                const b = draft as SubstationBusRecord
                return busNaming(doc, b.substationId, b.busType, b.busNumber).name
            }
            case 'bays': {
                const b = draft as SubstationBayRecord
                return bayNaming(doc, b.substationId, b.bayNumber).name
            }
            case 'equipments': {
                const e = draft as SubstationEquipmentRecord
                return equipmentNaming(doc, e.substationId, e.code, e.equipmentType).name
            }
            default: {
                const t = draft as SubstationTakeOffRecord
                return takeOffNaming(doc, t.substationId, t.lineName).name
            }
        }
    }, [doc, collection, draft])
}

/**
 * Every bay, bus, piece of equipment and take-off of the yard with a
 * checkbox, and "Regenerate from model rules" for the checked ones (id and
 * name from the bay number / bus number / equipment code / line name).
 */
function YardItemsPanel({layout}: { layout: SubstationLayout }) {
    const ed = useNetworkEditor()
    const [checked, setChecked] = useState<Set<string>>(new Set())
    // A tree: buses, then each bay with its bay-column equipment (highest row first, as drawn) and its take-offs, each take-off with the
    // equipment of its column; equipment and take-offs without a known bay follow at the end.
    const items = useMemo(() => {
        type Item = { target: RegenerateTarget; kind: string; label: string; detail: string; inUse?: boolean; depth: number }
        const out: Item[] = []
        const byRow = (a: { row: number }, b: { row: number }) => b.row - a.row
        const equipmentItem = (e: SubstationLayout['equipments'][number], depth: number): Item =>
            ({target: {collection: 'equipments', id: e.id}, kind: 'equipment', label: e.name ?? e.code, detail: `${equipmentTypeLabels[e.equipmentType]} · row ${e.row}${e.lineSide ? ' · line side' : ''}${e.busTie ? ' · bus tie' : ''}`, depth})
        const takeOffItem = (t: SubstationLayout['takeOffs'][number], depth: number): Item => {
            const use = describeTakeOffUsage(ed.doc, t.id)
            return {target: {collection: 'takeOffs', id: t.id}, kind: 'take-off', label: t.name ?? t.lineName, detail: `${t.row !== undefined ? `row ${t.row} · ` : ''}${use || 'free'}`, inUse: !!use, depth}
        }
        const placed = new Set<string>()
        for (const b of layout.buses) out.push({target: {collection: 'buses', id: b.id}, kind: 'bus', label: busLabel(b), detail: `${b.busType === 'TRANSFER' ? 'transfer bus' : 'main bus'} · row ${b.row}`, depth: 0})
        for (const b of layout.bays) {
            const takeOffs = layout.takeOffs.filter(t => t.bayId === b.id)
            const takeOffIds = new Set(takeOffs.map(t => t.id))
            // equipment in a take-off column is listed under that take-off (whichever bay it is in, as drawn); the rest under its own bay
            const knownTakeOff = (e: SubstationLayout['equipments'][number]) => !!e.takeOffId && layout.takeOffs.some(t => t.id === e.takeOffId)
            const inBay = layout.equipments.filter(e => knownTakeOff(e) ? takeOffIds.has(e.takeOffId!) : e.bayId === b.id)
            out.push({target: {collection: 'bays', id: b.id}, kind: 'bay', label: b.name ?? `BAY ${b.bayNumber}`, detail: `column ${b.column} · ${inBay.length} equipment, ${takeOffs.length} take-off${takeOffs.length === 1 ? '' : 's'}`, depth: 0})
            for (const e of inBay.filter(e => !knownTakeOff(e)).sort(byRow)) {
                out.push(equipmentItem(e, 1))
                placed.add(e.id)
            }
            for (const t of [...takeOffs].sort((a, b) => (b.row ?? 0) - (a.row ?? 0))) {
                out.push(takeOffItem(t, 1))
                placed.add(t.id)
                for (const e of inBay.filter(e => e.takeOffId === t.id).sort(byRow)) {
                    out.push(equipmentItem(e, 2))
                    placed.add(e.id)
                }
            }
        }
        const strayEquipment = layout.equipments.filter(e => !placed.has(e.id)).sort((a, b) => a.code.localeCompare(b.code))
        const strayTakeOffs = layout.takeOffs.filter(t => !placed.has(t.id))
        for (const e of strayEquipment) out.push({...equipmentItem(e, 0), detail: `${equipmentTypeLabels[e.equipmentType]} · no bay`})
        for (const t of strayTakeOffs) out.push({...takeOffItem(t, 0), detail: `no bay · ${describeTakeOffUsage(ed.doc, t.id) || 'free'}`})
        return out
    }, [layout, ed.doc])
    // Drop checks of records that disappeared (deleted, or renamed by a regeneration).
    useEffect(() => {
        const alive = new Set(items.map(i => targetKey(i.target)))
        setChecked(prev => {
            const next = new Set([...prev].filter(k => alive.has(k)))
            return next.size === prev.size ? prev : next
        })
    }, [items])
    const allChecked = items.length > 0 && items.every(i => checked.has(targetKey(i.target)))
    const toggle = (t: RegenerateTarget) => setChecked(prev => {
        const next = new Set(prev)
        const k = targetKey(t)
        if (next.has(k)) next.delete(k)
        else next.add(k)
        return next
    })
    const targets = items.filter(i => checked.has(targetKey(i.target))).map(i => i.target)
    // Mass delete of the checked items; refused as a whole while a checked take-off carries a circuit end.
    const blocked = items.filter(i => checked.has(targetKey(i.target)) && i.inUse)
    const deleteChecked = () => {
        if (!targets.length || blocked.length) return
        const counts = ['bays', 'buses', 'equipments', 'takeOffs'].map(c => {
            const n = targets.filter(t => t.collection === c).length
            return n ? `${n} ${c === 'takeOffs' ? 'take-off' : c === 'equipments' ? 'equipment' : c.slice(0, -1)}${n === 1 || c === 'equipments' ? '' : c === 'buses' ? 'es' : 's'}` : ''
        }).filter(Boolean).join(', ')
        if (!window.confirm(`Delete ${counts}? Equipment in a deleted bay goes with it; wiring to deleted nodes is removed.`)) return
        const ops: NetworkOp[] = []
        let probe = ed.doc
        for (const t of targets) {
            if (!findRecord(probe, t.collection, t.id)) continue   // already gone with its bay
            const next = cascadeDeleteOps(probe, t.collection, t.id)
            ops.push(...next)
            probe = applyOps(probe, next)
        }
        if (ed.apply(ops)) {
            setChecked(new Set())
            if (ed.selection && targets.some(t => t.collection === ed.selection?.collection && t.id === ed.selection?.id)) ed.select(null)
        }
    }
    return (
        <div className="panel">
            <div className="panel-header">
                <h3 style={{margin: 0}}>Items ({items.length})</h3>
                <span className="spacer"/>
                <label className="small" style={{display: 'flex', gap: 4, alignItems: 'center'}} title="Check every item">
                    <input type="checkbox" checked={allChecked} disabled={items.length === 0} onChange={() => setChecked(allChecked ? new Set() : new Set(items.map(i => targetKey(i.target))))}/> all
                </label>
                <span className="small muted">{checked.size} checked</span>
                <button type="button" className="small danger" disabled={!targets.length || blocked.length > 0} onClick={deleteChecked}
                        title={blocked.length ? `Cannot delete take-offs in use: ${blocked.map(b => b.label).join(', ')}. Detach their circuits on the map first.` : 'Delete the checked items in one step'}>Delete checked</button>
            </div>
            {blocked.length > 0 && <p className="small warn-dot" style={{margin: '0 0 6px'}}>⚠ Take-off{blocked.length === 1 ? '' : 's'} in use cannot be deleted: {blocked.map(b => b.label).join(', ')}. Detach the circuit end (or delete the line with its circuits) on the map first.</p>}
            {items.length === 0 && <p className="small muted">Nothing in this yard yet. Use the toolbar to add buses, bays, equipment and take-offs.</p>}
            <div className="find-results">
                {items.map(i => (
                    <div key={targetKey(i.target)} className={`find-item tree-depth-${i.depth}`} style={{paddingLeft: i.depth * 18}}>
                        {i.depth > 0 && <span className="tree-branch" aria-hidden="true">└</span>}
                        <input type="checkbox" checked={checked.has(targetKey(i.target))} onChange={() => toggle(i.target)} title="Check to regenerate its id / name, or to delete it"/>
                        <a href="#" className="find-row" onClick={e => {
                            e.preventDefault()
                            ed.select(i.target)
                        }}>
                            <span className="badge">{i.kind}</span>
                            <span className="find-label">{i.label}</span>
                            <span className="muted small find-detail">{i.detail} · <span className="mono">{i.target.id}</span></span>
                        </a>
                    </div>
                ))}
            </div>
            <RegenerateBox targets={targets} onApplied={() => setChecked(new Set())}/>
        </div>
    )
}

/* ---------- yard link ---------- */

function YardConnectionPanel({meta, yard, record, navigate}: PanelsProps & { record: SubstationYardConnectionRecord }) {
    const ed = useNetworkEditor()
    const d = useDraft(record)
    const yardLabel = (id: string) => {
        const y = ed.doc.substations.find(s => s.id === id)
        const g = y && ed.doc.substationGroups.find(x => x.id === y.groupId)
        return y ? `${g?.groupName ?? '?'} ${y.yardName} (${y.voltage})` : id
    }
    const yards = [...ed.doc.substations].map(y => ({value: y.id, label: yardLabel(y.id)})).sort((a, b) => a.label.localeCompare(b.label))
    const owner = (n: NetworkNodeRef): string | undefined => n.kind === NetworkNodeKind.SUBSTATION_BUS ? ed.doc.buses.find(b => b.id === n.id)?.substationId
        : n.kind === NetworkNodeKind.EQUIPMENT_TERMINAL ? ed.doc.equipments.find(e => e.id === n.id)?.substationId
            : n.kind === NetworkNodeKind.SUBSTATION_TAKE_OFF ? ed.doc.takeOffs.find(t => t.id === n.id)?.substationId : undefined
    const otherId = record.yardAId === yard.id ? record.yardBId : record.yardAId
    const here = record.nodes.filter(n => owner(n) === yard.id), there = record.nodes.filter(n => owner(n) !== yard.id)
    const removeNode = (n: NetworkNodeRef) => ed.apply([{type: 'upsert', collection: 'yardConnections', record: {...record, nodes: record.nodes.filter(x => nodeKey(x) !== nodeKey(n))}}])
    return (
        <div className="panel">
            <Header title={`Yard link ${record.name}`} rename={{collection: 'yardConnections', id: record.id}} onDelete={() => {
                if (!window.confirm(`Delete the yard link ${record.name} between ${yardLabel(record.yardAId)} and ${yardLabel(record.yardBId)}?`)) return
                ed.apply([{type: 'delete', collection: 'yardConnections', id: record.id}])
                ed.select(null)
            }}/>
            <p className="small muted">Joins nodes of two yards (a transformer side, a tie). Each yard's diagram shows its own nodes wired to a port for the other yard: at the top when that yard's voltage is higher, else at the bottom.</p>
            <div className="form-grid" style={{gridTemplateColumns: '1fr 1fr'}}>
                <TextField label="Name" value={d.draft.name} onChange={v => d.set('name', v)} className="span-all"/>
                <SelectField label="Yard A" value={d.draft.yardAId} options={yards} onChange={v => d.set('yardAId', v ?? '')}/>
                <SelectField label="Yard B" value={d.draft.yardBId} options={yards} onChange={v => d.set('yardBId', v ?? '')}/>
                <SelectField label="Voltage" value={d.draft.voltage} options={meta.enums.transmissionVoltage} allowEmpty onChange={v => d.set('voltage', v as TransmissionVoltage | undefined)} className="span-all" hint="Informational; the diagram colours the link by its nodes, else by the lower of the two yards"/>
            </div>
            <ApplyBar dirty={d.dirty} onReset={d.reset} onApply={() => ed.apply([{type: 'upsert', collection: 'yardConnections', record: {...d.draft, name: d.draft.name.trim() || record.name}}])}/>
            <h4 className="muted" style={{marginTop: 12}}>Nodes in this yard ({here.length})</h4>
            {here.length === 0 && <p className="small muted">None yet: in Connect mode click a node, then the port of this link (or the reverse).</p>}
            {here.length > 0 && (
                <table>
                    <tbody>
                    {here.map(n => (
                        <tr key={nodeKey(n)}>
                            <td>{describeNode(ed.doc, n)}</td>
                            <td style={{width: 1}}><button type="button" className="small danger" onClick={() => removeNode(n)}>×</button></td>
                        </tr>
                    ))}
                    </tbody>
                </table>
            )}
            <h4 className="muted" style={{marginTop: 12}}>Nodes in {yardLabel(otherId)} ({there.length})</h4>
            {there.length === 0 ? <p className="small muted">None yet.</p> : <p className="small">{there.map(n => <span key={nodeKey(n)} className="tag" style={{marginRight: 4}}>{describeNode(ed.doc, n)}</span>)}</p>}
            <p className="small"><a href="#" onClick={e => {
                e.preventDefault()
                navigate(`/network/${ed.networkId}/substation/${otherId}`)
            }}>Open {yardLabel(otherId)}</a> to wire the other side.</p>
        </div>
    )
}

/* ---------- connection ---------- */

export function describeNode(doc: ReturnType<typeof useNetworkEditor>['doc'], n: NetworkNodeRef): string {
    switch (n.kind) {
        case NetworkNodeKind.SUBSTATION_BUS: {
            const b = doc.buses.find(x => x.id === n.id)
            return b ? `Bus ${b.busType === 'TRANSFER' ? 'TRANSFER' : b.busNumber ?? ''}` : `Bus ${n.id}`
        }
        case NetworkNodeKind.EQUIPMENT_TERMINAL: {
            const e = doc.equipments.find(x => x.id === n.id)
            return e ? `${e.code} · ${n.terminal}` : `${n.id} · ${n.terminal}`
        }
        case NetworkNodeKind.SUBSTATION_TAKE_OFF: {
            const t = doc.takeOffs.find(x => x.id === n.id)
            return t ? `Take-off ${t.lineName}` : `Take-off ${n.id}`
        }
        case NetworkNodeKind.TRANSMISSION_CIRCUIT: {
            const c = doc.circuits.find(x => x.id === n.id)
            return `${c?.name ?? n.id} (${n.terminal})`
        }
    }
}

function ConnectionPanel({meta, yard, record}: PanelsProps & { record: ConnectionRecord }) {
    const ed = useNetworkEditor()
    const setNow = (patch: Partial<Pick<ConnectionRecord, 'voltage' | 'current' | 'planned'>>) => ed.apply([{type: 'upsert', collection: 'connections', record: {...record, ...patch}}])
    const removeNode = (i: number) => {
        const nodes = record.nodes.filter((_, n) => n !== i)
        if (nodes.length < 2) {
            ed.apply([{type: 'delete', collection: 'connections', id: record.id}])
            ed.select(null)
        } else ed.apply([{type: 'upsert', collection: 'connections', record: {...record, nodes}}])
    }
    return (
        <div className="panel">
            <Header title="Connection" rename={{collection: 'connections', id: record.id}} onDelete={() => {
                ed.apply([{type: 'delete', collection: 'connections', id: record.id}])
                ed.select(null)
            }}/>
            <p className="small muted">{record.scope} scope · {record.nodes.length} nodes · applied at once</p>
            <div className="form-grid" style={{gridTemplateColumns: '1fr 1fr'}}>
                <SelectField label="Voltage" value={record.voltage} options={meta.enums.transmissionVoltage} allowEmpty emptyLabel={`yard voltage (${yard.voltage})`}
                             onChange={v => setNow({voltage: v as TransmissionVoltage | undefined})}
                             hint="Colours the wire; set it when the node is not at the yard voltage (a secondary / auxiliary side). Nodes at another voltage get a warning."/>
                <NumberField label="Current limit (A)" value={record.current} min={0} onChange={v => setNow({current: v ?? undefined})} hint="Optional"/>
                <CheckboxField label="Planned (not built yet)" checked={!!record.planned} onChange={v => setNow({planned: v || undefined})} className="span-all"/>
            </div>
            <table>
                <tbody>
                {record.nodes.map((n, i) => (
                    <tr key={nodeKey(n)}>
                        <td>{describeNode(ed.doc, n)}</td>
                        <td style={{width: 1}}><button type="button" className="small danger" onClick={() => removeNode(i)}>×</button></td>
                    </tr>
                ))}
                </tbody>
            </table>
            <p className="small muted" style={{marginTop: 8}}>To add a node, use Connect mode and click a node of this connection followed by the new node.</p>
        </div>
    )
}
