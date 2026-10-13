import {Dispatch, ReactNode, SetStateAction, useEffect, useMemo, useRef, useState} from 'react'
import {TransmissionVoltage} from '@shared/models/transmission.voltage'
import {TemplateKind} from '@shared/templates/template'
import type {TransmissionCircuitTemplateData} from '@shared/templates/transmission.circuit'
import type {TransmissionConductorTemplate} from '@shared/templates/transmission.conductor'
import {genericConductor, type TransmissionConductor, type TransmissionWireType, type TransmissionWireUnit} from '@shared/models/transmission.conductor'
import {
    CIRCUIT_END_FROM,
    CIRCUIT_END_TO,
    CircuitEnd,
    ConnectionJunctionKind,
    ConnectionJunctionRef,
    ConnectionRecord,
    NetworkCollectionName,
    ConnectionScope,
    NetworkDocument,
    NetworkNodeKind,
    NetworkNodeRef,
    SubstationGroupRecord,
    SubstationRecord,
    SubstationTakeOffRecord,
    TransmissionCircuitRecord,
    TransmissionJunctionRecord,
    TransmissionLineRecord,
    TransmissionPathRecord,
} from '@shared/network/records'
import {applyOps, cascadeDeleteOps, NetworkOp, pickId, uniqueId} from '@shared/network/ops'
import {junctionNaming, lineNaming, pathNaming, regenerateNamingOps, siteNaming, takeOffLineName, takeOffNaming, yardNaming} from '@shared/network/naming'
import {buildCircuitGraph, fillLineEnds, formLine, guessLineEnds, LineEndCandidate, lineEndCandidates, lineExtensionCandidates, linesOfCircuit, lineWarnings, orderLineCircuits} from '@shared/network/lines'
import {yardNameForVoltage} from '@shared/models/naming'
import {GENERATION_BADGES, GENERATION_LABELS, GenerationType} from '@shared/models/generation'
import {draftNaming} from './RegenerateBox'
import {buildNewLinePlan, NewLineLegSpec, NewLineSpec, NewLineVia} from './lineWizard'
import {buildJoinCircuitsPlan, joinableReason} from './joinCircuits'
import {buildBypassPlan, passThroughs} from './bypassJunction'
import {buildMergeAllDuplicatesPlan, buildMergePathsPlan, duplicatePathGroups, duplicatesOf, runsReversed} from './mergePaths'
import {buildRouteViaPlan, pathsBetween, RouteVia, routeViaPathChoices, runVoltage, samePlace, yardChoices} from './routeVia'
import {buildNewCircuitPlan, circuitPlaceOptions, NewCircuitConnect, NewCircuitEndPlan, NewCircuitSpec, suggestedCircuitVoltage, yardsOf} from './circuitWizard'
import {buildRouteEndPlan, freedTakeOffs, routeEndRoutes, RouteEndRoute, routeKey, RouteTarget} from './routeEnd'
import {TowerSlot, towerSlots} from './towerLayout'
import {confirmDeleteLines} from './deleteLines'
import {atPathEnd, pathEndOf} from '@shared/network/refs'
import {moveSiteOps, newSiteJunctionRecord, siteJunctionOf} from '@shared/network/siteJunction'
import {extensionLinkProblem, extensionsOf, parentSiteOf, setExtensionOfOps, suggestedParentSite} from '@shared/network/extensions'
import {api, MetaResponse} from '../api/client'
import {useTemplates} from '../hooks/useTemplates'
import {hrefTo} from '../hooks/useHashRoute'
import {CheckboxField, enumLabel, NumberField, SelectField, TextAreaField, TextField} from '../components/fields'
import {Notice} from '../components/IssueList'
import {Selection, useNetworkEditor} from './NetworkContext'
import {FindPanel} from './FindPanel'
import {IdEditor, NewIdField, newIdOk} from './IdEditor'
import {
    attachCircuitEndToJunctionOps,
    attachCircuitEndToTakeOffOps,
    connectionsAtJunction,
    moveCircuitEndOps,
    attachPathEndOps,
    circuitEndConnection,
    circuitEndRef,
    circuitWarnings,
    detachCircuitEndOps,
    energizedMismatches,
    detachPathEndOps,
    END_LABEL,
    freeTakeOffs,
    pathStatus,
    refLabel,
    CircuitEndRef,
    formJunctionNodeOps,
    looseEndsAtJunction,
    sameRef,
} from './linkOps'
import {describeNode} from './SubstationPanels'
import {nextJunctionConnectionName} from '@shared/network/migrate'
import {CircuitDraft, CreateDraft, endLocation, haversineKm, LINE_MAX_VIAS, LineDraft, lineEndPlace, lineEndYardOf, locationOfRef, Mode, PathDraft, plannedVoltageColor, voltageColor, voltageKv, voltageLegend, WaypointEdit} from './mapUtil'
import {JunctionSymbol, VoltageSymbol} from './symbols'
import type {CoordinatesProps} from '@shared/models/coordinates'

interface MapPanelsProps {
    meta: MetaResponse
    mode: Mode
    draft: CircuitDraft
    setDraft: (d: CircuitDraft) => void
    setMode: (m: Mode) => void
    navigate: (path: string) => void
    waypoints?: WaypointTools
    /** Pans the map to a record (from lists and search). */
    locate?: (sel: Selection) => void
    /** Values for the next site / junction created by a map click. */
    createDraft?: CreateDraft
    setCreateDraft?: (d: CreateDraft) => void
    /** Split mode: performs the split at the existing junction chosen in the draft (no map click needed). */
    splitNow?: () => void
    /** "+ Line" mode: the wizard's stops, shared with map clicks. */
    lineDraft: LineDraft
    setLineDraft: Dispatch<SetStateAction<LineDraft>>
    /** "+ Path" mode: the new path's ends, name and id, shared with map clicks. */
    pathDraft: PathDraft
    setPathDraft: Dispatch<SetStateAction<PathDraft>>
}

export interface WaypointTools {
    state: WaypointEdit
    update: (patch: Partial<WaypointEdit>) => void
    remove: () => void
    setPath: (path: CoordinatesProps[]) => boolean
    done: () => void
}

function useDraft<T extends { id: string }>(record: T) {
    const [draft, setDraft] = useState<T>(record)
    useEffect(() => setDraft(record), [record])
    const set = <K extends keyof T>(key: K, value: T[K]) => setDraft(d => ({...d, [key]: value}))
    return {draft, set, setDraft, dirty: JSON.stringify(draft) !== JSON.stringify(record), reset: () => setDraft(record)}
}

function Header({title, badge, onDelete, rename}: { title: string; badge?: string; onDelete?: () => void; rename?: { collection: NetworkCollectionName; id: string; auto?: string } }) {
    return (
        <div className="panel-header">
            <h3 style={{margin: 0}}>{title}</h3>
            {rename ? <IdEditor collection={rename.collection} id={rename.id} auto={rename.auto}/> : badge && <span className="badge">{badge}</span>}
            <span className="spacer"/>
            {onDelete && <button type="button" className="small danger" onClick={onDelete}>Delete</button>}
        </div>
    )
}

function ApplyBar({dirty, onApply, onReset}: { dirty: boolean; onApply: () => void; onReset: () => void }) {
    return (
        <div className="toolbar" style={{marginTop: 10}}>
            <button type="button" className="primary small" disabled={!dirty} onClick={onApply}>Apply</button>
            <button type="button" className="small" disabled={!dirty} onClick={onReset}>Reset</button>
        </div>
    )
}

const coordsText = (c: { latitude: number; longitude: number }) => `${c.latitude.toFixed(6)}, ${c.longitude.toFixed(6)}`

function parseCoords(text: string): { latitude: number; longitude: number } | undefined {
    const m = /^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(text)
    if (!m) return undefined
    const latitude = Number(m[1]), longitude = Number(m[2])
    return Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 ? {latitude, longitude} : undefined
}

/** Colour square of a circuit: the energized voltage, with a hollow square in the rated colour when the two differ. */
function VoltageSwatch({circuit}: { circuit: TransmissionCircuitRecord }) {
    const reVolted = !!circuit.energizedVoltage && circuit.energizedVoltage !== circuit.voltage
    const title = reVolted ? `energized ${circuit.energizedVoltage}, rated ${circuit.voltage ?? '–'}` : circuit.voltage ?? ''
    return (
        <span title={title} style={{whiteSpace: 'nowrap'}}>
            <span style={{color: voltageColor(circuit.energizedVoltage ?? circuit.voltage)}}>■</span>
            {reVolted && <span style={{color: voltageColor(circuit.voltage)}}>□</span>}
        </span>
    )
}

export function MapPanels(props: MapPanelsProps) {
    const ed = useNetworkEditor()
    const {mode, draft} = props
    if (mode === 'addCircuit') return <NewCircuitWizard {...props}/>
    if (mode === 'addLine') return (
        <div className="panel">
            <Header title="New line"/>
            <NewLineWizard meta={props.meta} locate={props.locate} draft={props.lineDraft} setDraft={props.setLineDraft} onDone={() => props.setMode('select')}/>
        </div>
    )
    if (mode === 'addPath') return <NewPathPanel draft={props.pathDraft} setDraft={props.setPathDraft} setMode={props.setMode} locate={props.locate}/>
    if ((mode === 'addSite' || mode === 'addJunction' || mode === 'splitPath') && props.createDraft && props.setCreateDraft) return <CreatePanel kind={mode} draft={props.createDraft} setDraft={props.setCreateDraft} cancel={() => props.setMode('select')} splitNow={props.splitNow}/>
    if (mode === 'editWaypoints' && props.waypoints) return <WaypointPanel tools={props.waypoints}/>
    const sel = ed.selection
    if (sel) {
        switch (sel.collection) {
            case 'substationGroups': {
                const r = ed.doc.substationGroups.find(g => g.id === sel.id)
                if (r) return <SitePanel {...props} record={r}/>
                break
            }
            case 'junctions': {
                const r = ed.doc.junctions.find(j => j.id === sel.id)
                if (r) return <JunctionPanel {...props} record={r}/>
                break
            }
            case 'paths': {
                const r = ed.doc.paths.find(p => p.id === sel.id)
                if (r) return <PathPanel {...props} record={r}/>
                break
            }
            case 'circuits': {
                const r = ed.doc.circuits.find(c => c.id === sel.id)
                if (r) return <CircuitPanel {...props} record={r}/>
                break
            }
            case 'connections': {
                const r = ed.doc.connections.find(c => c.id === sel.id)
                if (r) return <TransmissionConnectionPanel record={r}/>
                break
            }
            case 'lines': {
                const r = ed.doc.lines.find(l => l.id === sel.id)
                if (r) return <LinePanel {...props} record={r}/>
                break
            }
            default:
                break
        }
    }
    void draft
    return <OverviewPanel {...props}/>
}

/* ---------- next site / junction ---------- */

function CreatePanel({kind, draft, setDraft, cancel, splitNow}: { kind: 'addSite' | 'addJunction' | 'splitPath'; draft: CreateDraft; setDraft: (d: CreateDraft) => void; cancel: () => void; splitNow?: () => void }) {
    const ed = useNetworkEditor()
    const site = kind === 'addSite'
    const split = kind === 'splitPath'
    const auto = site ? siteNaming(draft.code.trim().toUpperCase() || `SITE${ed.doc.substationGroups.length + 1}`).id : junctionNaming(ed.doc, draft.name).id
    const sel = ed.selection
    const splitPath = split && sel ? (sel.collection === 'paths' ? ed.doc.paths.find(p => p.id === sel.id) : sel.collection === 'circuits' ? ed.doc.paths.find(p => p.id === ed.doc.circuits.find(c => c.id === sel.id)?.pathId) : undefined) : undefined
    const splitCircuits = splitPath ? ed.doc.circuits.filter(c => c.pathId === splitPath.id) : []
    // Existing junctions the path can be split at: every junction (a site junction labelled by its site) except the path's own ends.
    const existingJunctions = split ? ed.doc.junctions
        .filter(j => !splitPath || !(atPathEnd(ed.doc, {kind: ConnectionJunctionKind.TRANSMISSION_JUNCTION, id: j.id}, splitPath.from) || atPathEnd(ed.doc, {kind: ConnectionJunctionKind.TRANSMISSION_JUNCTION, id: j.id}, splitPath.to)))
        .map(j => {
            const g = j.groupId ? ed.doc.substationGroups.find(x => x.id === j.groupId) : undefined
            return {value: j.id, label: g ? `Site ${g.groupName} · junction ${j.name ?? j.id}` : `Junction ${j.name ?? j.id}`}
        })
        .sort((a, b) => a.label.localeCompare(b.label)) : []
    const chosen = split && draft.existingJunctionId ? ed.doc.junctions.find(j => j.id === draft.existingJunctionId) : undefined
    return (
        <div className="panel">
            <div className="panel-header">
                <h3 style={{margin: 0}}>{site ? 'New site' : split ? 'Split path at a junction' : 'New junction'}</h3>
                <span className="spacer"/>
                <button type="button" className="small" onClick={cancel}>Cancel</button>
            </div>
            {split ? (
                <>
                    <p className="small">Path <strong>{splitPath?.name ?? '?'}</strong> ({refLabel(ed.doc, splitPath?.from)} → {refLabel(ed.doc, splitPath?.to)}) with {splitCircuits.length} circuit{splitCircuits.length === 1 ? '' : 's'}.</p>
                    <p className="small muted">{chosen
                        ? 'The path is cut at the segment nearest to the chosen junction; each circuit is split in two and joined again in a node of its own there, its length shared by distance; lines keep their sections. You are then asked whether to rename the split circuits and paths by the model rules.'
                        : 'Pick an existing junction, or fill in the new junction and click on the path (or anywhere on the map) where it goes. The path is cut at the nearest segment, each circuit is split in two and joined again in a node at the junction, its length shared by distance; lines keep their sections. You are then asked whether to rename the split circuits and paths by the model rules.'}</p>
                </>
            ) : <p className="small muted">Fill in what you know, then click on the map where it is. Empty fields are generated.</p>}
            <div className="form-grid" style={{gridTemplateColumns: '1fr'}}>
                {split && (
                    <SelectField label="Junction" value={draft.existingJunctionId} allowEmpty emptyLabel="New junction (placed by the next map click)" options={existingJunctions}
                                 onChange={v => setDraft({...draft, existingJunctionId: v || undefined})} hint={existingJunctions.length ? 'An existing junction, or a new one' : 'No other junction yet: a new one is created where you click'}/>
                )}
                {site && <TextField label="Code" value={draft.code} onChange={v => setDraft({...draft, code: v.toUpperCase()})} placeholder={`SITE${ed.doc.substationGroups.length + 1}`} hint="Short code, e.g. CNO"/>}
                {!chosen && <TextField label={split ? 'New junction name' : 'Name'} value={draft.name} onChange={v => setDraft({...draft, name: v})} placeholder={site ? (draft.code.trim().toUpperCase() || 'the code') : `JT${ed.doc.junctions.length + 1}`}
                                       hint={site ? 'Display name; the code when left empty' : undefined}/>}
                {!chosen && <NewIdField value={draft.id} onChange={v => setDraft({...draft, id: v})} auto={auto}/>}
            </div>
            {chosen && (
                <div className="toolbar" style={{marginTop: 8}}>
                    <button type="button" className="primary small" disabled={!splitNow || !splitPath} onClick={splitNow}>Split at {chosen.name ?? chosen.id}</button>
                </div>
            )}
        </div>
    )
}

/**
 * "+ Path": a new route between two sites or junctions, without circuits. The ends are picked here or by clicking
 * sites and junctions on the map (the FROM end first, then the TO end; a right-click takes one out again, see
 * `PathDraft`); name and id default to the rule ones. Paths already running between the two places are listed: a new
 * one is a duplicate unless it gets its own waypoints. The new path is selected, ready for "Edit waypoints".
 */
function NewPathPanel({draft, setDraft, setMode, locate}: { draft: PathDraft; setDraft: Dispatch<SetStateAction<PathDraft>>; setMode: (m: Mode) => void; locate?: (sel: Selection) => void }) {
    const ed = useNetworkEditor()
    const doc = ed.doc
    const options = useEndOptions()
    /** A draft end as a path end: a site junction stands for its site. */
    const endRef = (v: string) => {
        const r = decodeRef(v)
        return r && (pathEndOf(doc, r) ?? r)
    }
    const from = endRef(draft.from), to = endRef(draft.to)
    const same = !!from && !!to && samePlace(doc, from, to)
    const auto = from && to && !same ? pathNaming(doc, from, to) : undefined
    const existing = auto ? pathsBetween(doc, from, to) : []
    const a = locationOfRef(doc, from), b = locationOfRef(doc, to)
    const km = a && b && !same ? haversineKm(a.coords, b.coords) : undefined
    const idOk = newIdOk(doc, draft.id)
    const set = (patch: Partial<PathDraft>) => setDraft(d => ({...d, ...patch}))
    const pick = (sel: Selection) => {
        setMode('select')
        ed.select(sel)
        locate?.(sel)
    }
    const create = () => {
        if (!from || !to || same || !idOk) return
        const naming = pathNaming(doc, from, to, draft.name)
        const record: TransmissionPathRecord = {id: pickId(doc, draft.id, naming.id), name: naming.name, from, to, waypoints: []}
        if (ed.apply([{type: 'upsert', collection: 'paths', record}])) pick({collection: 'paths', id: record.id})
    }
    return (
        <div className="panel">
            <div className="panel-header">
                <h3 style={{margin: 0}}>New path</h3>
                <span className="spacer"/>
                <button type="button" className="small" onClick={() => setMode('select')}>Cancel</button>
            </div>
            <p className="small muted">A route between two sites or junctions, without circuits. Pick the ends here, or click on the map the site or junction where it starts, then the one where it ends (right-click one to take it out again). Add its waypoints with "Edit waypoints" afterwards.</p>
            <div className="form-grid" style={{gridTemplateColumns: '1fr'}}>
                <SelectField label="From" value={draft.from || undefined} options={options.filter(o => o.value !== draft.to)} allowEmpty emptyLabel="Click on the map, or choose a site or junction…" onChange={v => set({from: v ?? ''})}/>
                <SelectField label="To" value={draft.to || undefined} options={options.filter(o => o.value !== draft.from)} allowEmpty emptyLabel="Click on the map, or choose a site or junction…" onChange={v => set({to: v ?? ''})}/>
                <div className="toolbar small">
                    <button type="button" className="small" disabled={!draft.from && !draft.to} onClick={() => set({from: draft.to, to: draft.from})} title="Exchange the FROM and TO ends">Swap from / to</button>
                    {km !== undefined && <span className="muted">{km.toFixed(1)} km in a straight line</span>}
                </div>
                <TextField label="Name" value={draft.name} onChange={v => set({name: v})} placeholder={auto?.name ?? 'from the ends'} hint="The rule name (<from>-<to>, numbered) when empty"/>
                <NewIdField value={draft.id} onChange={v => set({id: v})} auto={auto?.id}/>
            </div>
            {same && <p className="small"><span className="warn-dot">⚠ Both ends are the same place.</span></p>}
            {existing.length > 0 && (
                <div className="small" style={{marginTop: 8}}>
                    <span className="warn-dot">⚠ Already between these ends:</span>
                    {existing.map(p => (
                        <div key={p.id} style={{marginTop: 2}}>
                            <a href="#" onClick={e => {
                                e.preventDefault()
                                pick({collection: 'paths', id: p.id})
                            }}><strong>{p.name}</strong></a>
                            <span className="muted"> · {refLabel(doc, p.from)} → {refLabel(doc, p.to)} · {doc.circuits.filter(c => c.pathId === p.id).length} circuits · {p.waypoints.length} pts</span>
                        </div>
                    ))}
                    <div className="muted" style={{marginTop: 2}}>A new path here is a duplicate unless it gets its own waypoints (a parallel line on another route).</div>
                </div>
            )}
            <div className="toolbar" style={{marginTop: 8}}>
                <button type="button" className="primary small" disabled={!from || !to || same || !idOk} onClick={create}>Create path</button>
            </div>
        </div>
    )
}

/* ---------- overview ---------- */

type OverviewTab = 'find' | 'sites' | 'yards' | 'junctions' | 'paths' | 'lines' | 'circuits'
const OVERVIEW_TABS: { key: OverviewTab; label: string }[] = [
    {key: 'find', label: 'Find'}, {key: 'sites', label: 'Sites'}, {key: 'yards', label: 'Yards'}, {key: 'junctions', label: 'Junctions'}, {key: 'paths', label: 'Paths'}, {key: 'lines', label: 'Lines'}, {key: 'circuits', label: 'Circuits'},
]
const OVERVIEW_TAB_KEY = 'thgrid.mapTab'

function OverviewPanel({navigate, locate, setMode}: MapPanelsProps) {
    const ed = useNetworkEditor()
    const d = ed.doc
    const [name, setName] = useState(d.name)
    const [description, setDescription] = useState(d.description ?? '')
    useEffect(() => {
        setName(d.name)
        setDescription(d.description ?? '')
    }, [d.name, d.description])
    const metaDirty = name.trim() !== d.name || description.trim() !== (d.description ?? '')
    const dangling = d.circuits.filter(c => !endLocation(d, c.id, CIRCUIT_END_FROM) || !endLocation(d, c.id, CIRCUIT_END_TO))
    const pathCount = d.paths.length
    // The upper panel is tabbed: Find (every type, with type chips), then one list per type. The tab survives selecting a record and coming back.
    const [tab, setTab] = useState<OverviewTab>(() => {
        try {
            const v = window.sessionStorage.getItem(OVERVIEW_TAB_KEY) as OverviewTab | null
            return v && OVERVIEW_TABS.some(t => t.key === v) ? v : 'find'
        } catch {
            return 'find'
        }
    })
    const pickTab = (t: OverviewTab) => {
        setTab(t)
        try {
            window.sessionStorage.setItem(OVERVIEW_TAB_KEY, t)
        } catch {
            // storage unavailable: the tab is just not remembered
        }
    }
    return (
        <>
            <div className="panel">
                <div className="panel-tabs" role="tablist">
                    {OVERVIEW_TABS.map(t => <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={tab === t.key ? 'active' : ''} onClick={() => pickTab(t.key)}>{t.label}</button>)}
                </div>
                {tab === 'find' && <FindPanel embedded locate={locate}/>}
                {tab === 'paths' && (() => {
                    const unused = d.paths.filter(p => !d.circuits.some(c => c.pathId === p.id))
                    const duplicates = duplicatePathGroups(d)
                    return (
                        <div className="toolbar" style={{marginBottom: 6}}>
                            <span className="muted small">{d.paths.length} path{d.paths.length === 1 ? '' : 's'}{unused.length ? `, ${unused.length} unused` : ''}{duplicates.length ? `, ${duplicates.length} duplicate group${duplicates.length === 1 ? '' : 's'}` : ''}</span>
                            <span className="spacer" style={{flex: 1}}/>
                            {duplicates.length > 0 && <button type="button" className="small" title="Merge each group of paths between the same two places (either direction) into one" onClick={() => {
                                const plan = buildMergeAllDuplicatesPlan(d)
                                if (plan.errors.length) return window.alert(plan.errors.join('\n'))
                                const list = duplicates.map(g => `• keep ${g[0].name} (${d.circuits.filter(c => c.pathId === g[0].id).length} circuits) ← ${g.slice(1).map(p => `${p.name} (${d.circuits.filter(c => c.pathId === p.id).length})`).join(', ')}`)
                                if (!window.confirm(`Merge ${duplicates.length} group(s) of duplicate paths? The circuits move onto the kept path and the others are deleted.\n\n${[...list, ...plan.warnings.map(w => `⚠ ${w}`)].join('\n')}`)) return
                                const rename = plan.regenerate.changes.length > 0 && window.confirm(`Also rename the kept paths and the moved circuits by the model rules (${plan.regenerate.changes.length} change(s))?`)
                                ed.apply(rename ? [...plan.ops, ...plan.regenerate.ops] : plan.ops)
                            }}>Merge duplicates</button>}
                            {unused.length > 0 && <button type="button" className="small danger" title={`Delete the ${unused.length} path(s) no circuit uses`} onClick={() => {
                                if (window.confirm(`Delete ${unused.length} unused path(s)? Paths with circuits are kept.`)) ed.apply(unused.flatMap(p => cascadeDeleteOps(d, 'paths', p.id)))
                            }}>Delete unused</button>}
                        </div>
                    )
                })()}
                {tab === 'lines' && (() => {
                    const missing = d.lines.filter(l => !l.from || !l.to)
                    const fills = fillLineEnds(d).filter(x => x.filled.length > 0)
                    return (
                        <div className="toolbar" style={{marginBottom: 6}}>
                            <span className="muted small">{d.lines.length} line{d.lines.length === 1 ? '' : 's'}{missing.length ? `, ${missing.length} missing an end` : ''}</span>
                            <span className="spacer" style={{flex: 1}}/>
                            {fills.length > 0 && <button type="button" className="small" title="Set the FROM / TO a line does not state from its own sections: where its first / last section leaves the line (a yard or a junction)" onClick={() => {
                                const list = fills.map(x => `• ${x.line.name}: ${refLabel(d, x.updated.from)} → ${refLabel(d, x.updated.to)} (${x.filled.map(e => e.toUpperCase()).join(' and ')} filled)`)
                                const left = missing.length - fills.filter(x => x.updated.from && x.updated.to).length
                                const leftNote = left ? `\n\n${left} line(s) still miss an end: a section end there is not connected.` : ''
                                if (!window.confirm(`Fill the missing ends of ${fills.length} line(s) from their sections?\n\n${list.join('\n')}${leftNote}`)) return
                                const ops: NetworkOp[] = fills.map(x => ({type: 'upsert', collection: 'lines', record: x.updated}))
                                const regen = regenerateNamingOps(applyOps(d, ops), fills.map(x => ({collection: 'lines' as const, id: x.line.id})), {id: true, name: true})
                                const rename = regen.changes.length > 0 && window.confirm(`Also rename these lines by the model rules (${regen.changes.length} change(s): ${regen.changes.map(c => `${c.oldName ?? c.id} → ${c.newName ?? c.newId}`).join(', ')})?`)
                                ed.apply(rename ? [...ops, ...regen.ops] : ops)
                            }}>Fill missing ends ({fills.length})</button>}
                        </div>
                    )
                })()}
                {tab !== 'find' && <FindPanel key={tab} embedded locate={locate} fixedKind={tab}/>}
            </div>
            <div className="panel">
                <Header title="Network" badge={d.id}/>
                <div className="form-grid" style={{gridTemplateColumns: '1fr'}}>
                    <TextField label="Name" value={name} onChange={setName}/>
                    <TextAreaField label="Description" value={description} onChange={v => setDescription(v ?? '')} rows={2}/>
                </div>
                <ApplyBar dirty={metaDirty && name.trim().length > 0} onReset={() => {
                    setName(d.name)
                    setDescription(d.description ?? '')
                }} onApply={() => ed.apply([{type: 'meta', name: name.trim(), description: description.trim()}])}/>
                <h4 className="muted" style={{marginTop: 12}}>Contents</h4>
                <dl className="kv small">
                    <dt>Sites</dt>
                    <dd>{d.substationGroups.length} ({d.substations.length} yards)</dd>
                    <dt>Junctions</dt>
                    <dd>{d.junctions.length}</dd>
                    <dt>Circuits</dt>
                    <dd>{d.circuits.length}{dangling.length ? ` (${dangling.length} with a loose end)` : ''}</dd>
                    <dt>Lines</dt>
                    <dd>{d.lines.length}</dd>
                    <dt>Paths</dt>
                    <dd>{pathCount}</dd>
                    <dt>Connections</dt>
                    <dd>{d.connections.length}</dd>
                </dl>
                <p className="small muted" style={{marginTop: 8}}>Use the toolbar: add sites and junctions by clicking on the map, then "+ Circuit" and click the two ends. Circuits leave a substation through a take-off.</p>
            </div>
            <div className="panel">
                <h3>Legend</h3>
                <p className="small"><JunctionSymbol/> Junction: a blue area behind the lines; inside it a curve joins two circuit ends, a dot joins three or more (lines crossing without a dot are not joined), an open circle is a circuit end with no connection. Clicking anything inside selects the junction.</p>
                <p className="small">Yards: {voltageLegend.map(v => <span key={v.voltage} style={{marginRight: 8}}><VoltageSymbol voltage={v.voltage}/> {v.label}</span>)}<VoltageSymbol/> other · dull colour = planned</p>
                <p className="small">Circuits: {voltageLegend.map(v => <span key={v.voltage} style={{marginRight: 8}}><span style={{color: voltageColor(v.voltage)}}>━</span> {v.label}</span>)}<span style={{color: voltageColor()}}>━</span> other · short dashes = loose end · long dashes = no path (straight between its ends; ⚠ when one end only) · grey dashes = a path without circuits · dotted, dull colour = planned · dotted overlay = energized at another voltage than rated (solid = energized, dots = rated)</p>
                <p className="small muted">Open the <a href={hrefTo(`/network/${ed.networkId}/substations`)} onClick={e => {
                    e.preventDefault()
                    navigate(`/network/${ed.networkId}/substations`)
                }}>substation editor</a> to wire buses, bays and equipment inside a yard.</p>
            </div>
        </>
    )
}

/* ---------- paths & circuits at a location ---------- */

/** Paths that start or end at one of `refs` and the circuits attached there (or on those paths), with attention markers. */
function LinesAtPanel({refs, locate}: { refs: ConnectionJunctionRef[]; locate?: (sel: Selection) => void }) {
    const ed = useNetworkEditor()
    const doc = ed.doc
    const here = (r?: ConnectionJunctionRef) => refs.some(x => sameRef(x, r))
    /** A path end (a site or a junction) that one of the places lies at. */
    const endsHere = (pathEnd?: ConnectionJunctionRef) => refs.some(x => atPathEnd(doc, x, pathEnd))
    // Paths ending here, plus the paths of circuits attached here (so a circuit still shows under its path).
    const pathIds = new Set<string>()
    for (const p of doc.paths) if (endsHere(p.from) || endsHere(p.to)) pathIds.add(p.id)
    const orphans: typeof doc.circuits = []
    for (const c of doc.circuits) {
        const attached = here(circuitEndRef(doc, c.id, CIRCUIT_END_FROM)) || here(circuitEndRef(doc, c.id, CIRCUIT_END_TO))
        if (!attached) continue
        if (c.pathId && doc.paths.some(p => p.id === c.pathId)) pathIds.add(c.pathId)
        else orphans.push(c)
    }
    const paths = doc.paths.filter(p => pathIds.has(p.id))
    const linesHere = doc.lines.filter(l => here(l.from) || here(l.to))
    /** Junctions among the places (a site's own junction) that a line's sections meet at without the line ending here. */
    const throughAt = (l: TransmissionLineRecord) => {
        const at = new Map<string, ConnectionJunctionRef>()
        for (const id of l.circuitIds) for (const end of [CIRCUIT_END_FROM, CIRCUIT_END_TO] as CircuitEnd[]) {
            const ref = circuitEndRef(doc, id, end)
            if (ref?.kind === ConnectionJunctionKind.TRANSMISSION_JUNCTION && here(ref)) at.set(ref.id, ref)
        }
        return [...at.values()]
    }
    const linesThrough = doc.lines.filter(l => !here(l.from) && !here(l.to)).map(l => ({line: l, at: throughAt(l)})).filter(x => x.at.length > 0)
    const pick = (sel: Selection) => {
        ed.select(sel)
        locate?.(sel)
    }
    const lineRow = (l: TransmissionLineRecord, through?: ConnectionJunctionRef[]) => (
        <div key={l.id} className="toolbar small" style={{marginBottom: 3}}>
            <span className="badge">line</span>
            <span style={{color: voltageColor(l.voltage)}}>■</span>
            <a href="#" onClick={e => {
                e.preventDefault()
                pick({collection: 'lines', id: l.id})
            }}><strong>{l.name}</strong></a>
            <span className="muted">{refLabel(doc, l.from)} → {refLabel(doc, l.to)} · {l.circuitIds.length} section{l.circuitIds.length === 1 ? '' : 's'}{through ? ` · through ${through.map(r => refLabel(doc, r)).join(', ')}` : ''}</span>
        </div>
    )
    const linesBlock = (linesHere.length > 0 || linesThrough.length > 0) && (
        <>
            {linesHere.length > 0 && <div style={{marginBottom: 8}}>
                <div className="small muted" style={{marginBottom: 3}}>Lines ending here ({linesHere.length})</div>
                {linesHere.map(l => lineRow(l))}
            </div>}
            {linesThrough.length > 0 && <div style={{marginBottom: 8}}>
                <div className="small muted" style={{marginBottom: 3}}>Lines passing through the junction ({linesThrough.length}): spliced there, they end elsewhere</div>
                {linesThrough.map(x => lineRow(x.line, x.at))}
            </div>}
        </>
    )
    const circuitRow = (c: TransmissionCircuitRecord, indent: boolean) => {
        const warn = circuitWarnings(doc, c.id).join(', ')
        return (
            <div key={c.id} className="toolbar small" style={{marginBottom: 3, paddingLeft: indent ? 22 : 0}}>
                {indent && <span className="muted">└</span>}
                <span className="badge">circuit</span>
                <VoltageSwatch circuit={c}/>
                <a href="#" onClick={e => {
                    e.preventDefault()
                    pick({collection: 'circuits', id: c.id})
                }}><strong>{c.name}</strong></a>
                <span className="muted">{refLabel(doc, circuitEndRef(doc, c.id, CIRCUIT_END_FROM))} → {refLabel(doc, circuitEndRef(doc, c.id, CIRCUIT_END_TO))}</span>
                {warn && <span className="warn-dot">⚠ {warn}</span>}
            </div>
        )
    }
    if (paths.length === 0 && orphans.length === 0 && linesHere.length === 0 && linesThrough.length === 0) return (
        <div className="panel">
            <h3>Paths and circuits here</h3>
            <p className="small muted">Nothing starts or ends here yet. Use "+ Circuit" on the map, or set a path end to this place in the path panel.</p>
        </div>
    )
    return (
        <div className="panel">
            <h3>Paths and circuits here</h3>
            {linesBlock}
            {paths.map(p => {
                const st = pathStatus(doc, p.id)
                const pathEndsHere = endsHere(p.from) || endsHere(p.to)
                const warn = [st.noFrom ? 'no FROM end' : '', st.noTo ? 'no TO end' : '', st.unused ? 'no circuits' : '', pathEndsHere ? '' : 'path does not end here'].filter(Boolean).join(', ')
                const circuits = doc.circuits.filter(c => c.pathId === p.id)
                return (
                    <div key={p.id} style={{marginBottom: 8}}>
                        <div className="toolbar small" style={{marginBottom: 3}}>
                            <span className="badge">path</span>
                            <a href="#" onClick={e => {
                                e.preventDefault()
                                pick({collection: 'paths', id: p.id})
                            }}><strong>{p.name}</strong></a>
                            <span className="muted">{refLabel(doc, p.from)} → {refLabel(doc, p.to)} · {circuits.length} circuit{circuits.length === 1 ? '' : 's'}</span>
                            {warn && <span className="warn-dot">⚠ {warn}</span>}
                        </div>
                        {circuits.map(c => circuitRow(c, true))}
                    </div>
                )
            })}
            {orphans.length > 0 && (
                <div style={{marginBottom: 8}}>
                    <div className="small muted" style={{marginBottom: 3}}>Circuits without a path (drawn dashed between their ends)</div>
                    {orphans.map(c => circuitRow(c, false))}
                </div>
            )}
        </div>
    )
}

/* ---------- site ---------- */

/**
 * Site extensions (`extensionOf`, one level): link this site to the site it extends or unlink it, and link / unlink the
 * sites that extend it. Each change is applied (journaled) right away. Sites are offered nearest first; the one the code
 * points at (`suggestedParentSite`: `BPK_T` → `BPK`) is offered as a one-click suggestion.
 */
function SiteExtensionsPanel({record, locate}: { record: SubstationGroupRecord; locate?: (sel: Selection) => void }) {
    const ed = useNetworkEditor()
    const doc = ed.doc
    const [parentPick, setParentPick] = useState('')
    const [childPick, setChildPick] = useState('')
    useEffect(() => {
        setParentPick('')
        setChildPick('')
    }, [record.id])
    const parent = parentSiteOf(doc, record)
    const extensions = extensionsOf(doc, record.id)
    const suggestion = !record.extensionOf ? suggestedParentSite(doc, record) : undefined
    const kmTo = (g: SubstationGroupRecord) => haversineKm(record.coords, g.coords)
    const byDistance = (list: SubstationGroupRecord[]) => [...list].sort((a, b) => kmTo(a) - kmTo(b))
    const label = (g: SubstationGroupRecord) => `${g.groupName}${g.name && g.name !== g.groupName ? ` – ${g.name}` : ''} (${kmTo(g).toFixed(1)} km)`
    // sites this one may extend, and sites that may extend this one
    const parentOptions = byDistance(doc.substationGroups.filter(g => !extensionLinkProblem(doc, record.id, g.id))).map(g => ({value: g.id, label: label(g)}))
    const suggestedChildren = doc.substationGroups.filter(g => !g.extensionOf && suggestedParentSite(doc, g)?.parent.id === record.id)
    const childOptions = byDistance(doc.substationGroups.filter(g => g.extensionOf !== record.id && !extensionLinkProblem(doc, g.id, record.id)))
        .map(g => ({value: g.id, label: `${label(g)}${suggestedChildren.includes(g) ? ' · suggested by its code' : ''}${g.extensionOf ? ` · now extends ${parentSiteOf(doc, g)?.groupName}` : ''}`}))
    const link = (childId: string, parentId: string | undefined) => {
        const problem = parentId ? extensionLinkProblem(doc, childId, parentId) : undefined
        if (problem) return window.alert(problem)
        ed.apply(setExtensionOfOps(doc, childId, parentId))
    }
    const open = (g: SubstationGroupRecord) => {
        ed.select({collection: 'substationGroups', id: g.id})
        locate?.({collection: 'substationGroups', id: g.id})
    }
    const siteLink = (g: SubstationGroupRecord) => <a href="#" onClick={e => {
        e.preventDefault()
        open(g)
    }}><strong>{g.groupName}</strong></a>

    return (
        <div className="panel">
            <h3>Extensions</h3>
            <p className="small muted" style={{marginTop: 0}}>An extension (e.g. a plant switchyard next to a substation) is drawn with the site it extends when zoomed out: one marker, whose label lists it on a line of its own; the lines between them are left out.</p>
            {parent ? (
                <div className="toolbar small" style={{marginBottom: 6}}>
                    <span>Extension of {siteLink(parent)}{parent.name && parent.name !== parent.groupName ? <span className="muted"> {parent.name}</span> : null}</span>
                    <span className="spacer" style={{flex: 1}}/>
                    <button type="button" className="small" onClick={() => link(record.id, undefined)} title="Make it a site of its own again">Unlink</button>
                </div>
            ) : extensions.length === 0 && (
                <div className="toolbar small" style={{marginBottom: 6}}>
                    <span className="muted">Extension of</span>
                    <select value={parentPick} onChange={e => setParentPick(e.target.value)} style={{flex: 1, minWidth: 0}}>
                        <option value="">choose the site it extends…</option>
                        {parentOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                    <button type="button" className="small" disabled={!parentPick} onClick={() => link(record.id, parentPick)}>Link</button>
                    {suggestion && <button type="button" className="small primary" onClick={() => link(record.id, suggestion.parent.id)}
                                           title={`Its code points at ${suggestion.parent.groupName}, ${suggestion.km.toFixed(2)} km away`}>Link to {suggestion.parent.groupName}</button>}
                </div>
            )}
            {!parent && (
                <>
                    {extensions.map(x => (
                        <div key={x.id} className="toolbar small" style={{marginBottom: 4}}>
                            <span className="muted">↳</span>
                            <span>{siteLink(x)}{x.name && x.name !== x.groupName ? <span className="muted"> {x.name}</span> : null}<span className="muted"> · {kmTo(x).toFixed(2)} km</span></span>
                            <span className="spacer" style={{flex: 1}}/>
                            <button type="button" className="small" onClick={() => link(x.id, undefined)} title={`Make ${x.groupName} a site of its own again`}>Unlink</button>
                        </div>
                    ))}
                    <div className="toolbar small" style={{marginTop: 4}}>
                        <span className="muted">Add extension</span>
                        <select value={childPick} onChange={e => setChildPick(e.target.value)} style={{flex: 1, minWidth: 0}}>
                            <option value="">choose a site that extends this one…</option>
                            {childOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                        <button type="button" className="small" disabled={!childPick} onClick={() => {
                            link(childPick, record.id)
                            setChildPick('')
                        }}>Link</button>
                    </div>
                    {suggestedChildren.length > 0 && (
                        <div className="toolbar small" style={{marginTop: 4}}>
                            <span className="muted">Suggested by code: {suggestedChildren.map(g => g.groupName).join(', ')}</span>
                            <span className="spacer" style={{flex: 1}}/>
                            <button type="button" className="small primary" onClick={() => ed.apply(suggestedChildren.flatMap(g => setExtensionOfOps(doc, g.id, record.id)))}>Link {suggestedChildren.length === 1 ? 'it' : `all ${suggestedChildren.length}`}</button>
                        </div>
                    )}
                </>
            )}
        </div>
    )
}

function SitePanel({meta, record, navigate, locate}: MapPanelsProps & { record: SubstationGroupRecord }) {
    const ed = useNetworkEditor()
    const d = useDraft(record)
    /** Id / name the model rules give this site from its code (`SSG_<code>`, name = code). */
    const auto = draftNaming(ed.doc, 'substationGroups', d.draft)
    const [coords, setCoords] = useState(coordsText(record.coords))
    useEffect(() => setCoords(coordsText(record.coords)), [record])
    const yards = ed.doc.substations.filter(s => s.groupId === record.id).sort((a, b) => a.yardName.localeCompare(b.yardName))
    /** Typed yard name; empty = from the voltage (`230KV`, `300KVDC`). */
    const [yardName, setYardName] = useState('')
    const [voltage, setVoltage] = useState<string>(TransmissionVoltage.AC230KV)
    const [toYard, setToYard] = useState('')
    const [toName, setToName] = useState('')
    /** Site the new take-off's line goes to; names it `<voltage>_<site code>_L<n>` when no name is typed. */
    const [toTarget, setToTarget] = useState('')
    const otherSites = ed.doc.substationGroups.filter(g => g.id !== record.id).sort((a, b) => a.groupName.localeCompare(b.groupName))
    const [yardId, setYardId] = useState('')
    const [toId, setToId] = useState('')
    const parsed = parseCoords(coords)
    const siteJunction = siteJunctionOf(ed.doc, record.id)
    const siteJunctionNodes = siteJunction ? connectionsAtJunction(ed.doc, siteJunction.id) : []

    const addYard = () => {
        if (!newIdOk(ed.doc, yardId)) return
        const naming = yardNaming(ed.doc, record.id, yardName, voltage)
        const rec: SubstationRecord = {id: pickId(ed.doc, yardId, naming.id), groupId: record.id, yardName: naming.name, voltage: voltage as TransmissionVoltage}
        ed.apply([{type: 'upsert', collection: 'substations', record: rec}])
        setYardId('')
    }
    const addTakeOff = () => {
        const yard = yards.find(y => y.id === (toYard || yards[0]?.id))
        const lineName = toName.trim() || (yard && toTarget ? takeOffLineName(ed.doc, yard.id, toTarget) : undefined)
        if (!yard || !lineName || !newIdOk(ed.doc, toId)) return
        const naming = takeOffNaming(ed.doc, yard.id, lineName)
        const rec: SubstationTakeOffRecord = {id: pickId(ed.doc, toId, naming.id), name: naming.name, substationId: yard.id, lineName, takeOffColumn: true}
        ed.apply([{type: 'upsert', collection: 'takeOffs', record: rec}])
        setToName('')
        setToId('')
    }

    return (
        <>
            <div className="panel">
                <Header title={`Site ${record.groupName}`} rename={{collection: 'substationGroups', id: record.id, auto: auto?.id}} onDelete={() => {
                    if (window.confirm(`Delete site ${record.groupName} with ${yards.length} yard(s) and everything in them?`)) {
                        ed.apply(cascadeDeleteOps(ed.doc, 'substationGroups', record.id))
                        ed.select(null)
                    }
                }}/>
                <div className="form-grid" style={{gridTemplateColumns: '1fr 1fr'}}>
                    <TextField label="Code" value={d.draft.groupName} onChange={v => d.set('groupName', v.toUpperCase())} hint="Short code, e.g. CNO"/>
                    <TextField label="Name" value={d.draft.name} onChange={v => d.set('name', v || undefined)} placeholder={auto?.name} hint="Display name; the code when left empty"
                               action={{label: 'auto', title: auto ? `Use the code as name: ${auto.name}` : 'Enter a code first', disabled: !auto || auto.name === d.draft.name, onClick: () => auto && d.set('name', auto.name)}}/>
                    <TextField label="Coordinates" value={coords} onChange={setCoords} mono hint="lat, lon (drag the marker to move)" error={parsed ? undefined : 'lat, lon expected'} className="span-all"/>
                    <CheckboxField label="Planned (not built yet): marker drawn in grey, yard symbols in a dull voltage colour; built yards here get a warning" checked={!!d.draft.planned} className="span-all" onChange={v => d.set('planned', v || undefined)}/>
                    <CheckboxField label="Generation site (power plant / power producer)" checked={!!d.draft.generation} className="span-all"
                                   onChange={v => d.setDraft(x => ({...x, generation: v || undefined, generationTypes: v ? x.generationTypes : undefined}))}/>
                    {d.draft.generation && (
                        <div className="span-all">
                            <div className="small muted" style={{marginBottom: 4}}>Generation types (one badge each on the map)</div>
                            <div className="toolbar" style={{gap: 10}}>
                                {(meta.enums.generationType as GenerationType[]).map(t => {
                                    const on = (d.draft.generationTypes ?? []).includes(t)
                                    const b = GENERATION_BADGES[t]
                                    return (
                                        <label key={t} className="small" style={{display: 'flex', alignItems: 'center', gap: 4}}>
                                            <input type="checkbox" checked={on} onChange={e => {
                                                const next = e.target.checked ? [...(d.draft.generationTypes ?? []), t] : (d.draft.generationTypes ?? []).filter(x => x !== t)
                                                d.set('generationTypes', next.length ? next : undefined)
                                            }}/>
                                            <span className="map-gen-badge" style={{background: b?.color}}>{b?.letter ?? t}</span> {GENERATION_LABELS[t] ?? t}
                                        </label>
                                    )
                                })}
                            </div>
                        </div>
                    )}
                </div>
                <ApplyBar dirty={d.dirty || (parsed !== undefined && coordsText(parsed) !== coordsText(record.coords))} onReset={() => {
                    d.reset()
                    setCoords(coordsText(record.coords))
                }} onApply={() => parsed && ed.apply(moveSiteOps(ed.doc, d.draft, parsed))}/>
            </div>
            <SiteExtensionsPanel record={record} locate={locate}/>
            <div className="panel">
                <div className="panel-header">
                    <h3 style={{margin: 0}}>Site junction</h3>
                    <span className="spacer"/>
                    {!siteJunction && <button type="button" className="small" title="A transmission junction at this site, named after it: circuits can be joined or teed here without entering a yard"
                                              onClick={() => {
                                                  const rec = newSiteJunctionRecord(ed.doc, record)
                                                  if (ed.apply([{type: 'upsert', collection: 'junctions', record: rec}])) ed.select({collection: 'junctions', id: rec.id})
                                              }}>+ Site junction</button>}
                </div>
                {siteJunction ? (
                    <p className="small" style={{margin: 0}}>
                        <a href="#" onClick={e => {
                            e.preventDefault()
                            ed.select({collection: 'junctions', id: siteJunction.id})
                        }}><strong>Junction {siteJunction.name ?? siteJunction.id}</strong></a>
                        <span className="muted"> · {siteJunctionNodes.length} electrical node{siteJunctionNodes.length === 1 ? '' : 's'}; it moves with the site and is a stop for lines like any junction</span>
                    </p>
                ) : <p className="small muted" style={{margin: 0}}>No junction at this site. One (at most) can be added: circuits are joined or teed there without entering a yard.</p>}
            </div>
            <div className="panel">
                <h3>Yards</h3>
                {yards.length === 0 && <p className="small muted">No yards yet.</p>}
                {yards.map(y => {
                    const takeOffs = ed.doc.takeOffs.filter(t => t.substationId === y.id)
                    return (
                        <div key={y.id} style={{marginBottom: 10}}>
                            <div className="toolbar">
                                <strong><VoltageSymbol voltage={y.voltage} planned={y.planned || record.planned}/> {y.yardName}</strong> <span className="muted small">{y.voltage}</span>
                                <span className="spacer" style={{flex: 1}}/>
                                <button type="button" className="small" onClick={() => navigate(`/network/${ed.networkId}/substation/${y.id}`)}>Open editor</button>
                            </div>
                            <div className="small muted" style={{paddingLeft: 8}}>
                                {takeOffs.length === 0 ? 'no take-offs' : takeOffs.map(t => {
                                    const used = ed.doc.connections.some(c => c.scope === ConnectionScope.TRANSMISSION && c.nodes.some(n => n.kind === NetworkNodeKind.SUBSTATION_TAKE_OFF && n.id === t.id))
                                    return <span key={t.id} className="tag" title={used ? 'connected to a circuit' : 'free'} style={used ? {borderColor: 'var(--ok)', color: 'var(--ok)'} : undefined}>{t.lineName}</span>
                                })}
                            </div>
                        </div>
                    )
                })}
                <div className="toolbar" style={{marginTop: 8}}>
                    <select value={voltage} onChange={e => setVoltage(e.target.value)}>
                        {meta.enums.transmissionVoltage.map(v => <option key={v} value={v}>{enumLabel(v)}</option>)}
                    </select>
                    <input type="text" value={yardName} onChange={e => setYardName(e.target.value.toUpperCase())} placeholder={`Yard name: ${yardNameForVoltage(voltage)}`} title="Left empty: named after the voltage" style={{width: 120}}/>
                    <NewIdField compact value={yardId} onChange={setYardId} auto={yardNaming(ed.doc, record.id, yardName, voltage).id}/>
                    <button type="button" className="small" onClick={addYard} disabled={!newIdOk(ed.doc, yardId)}>Add yard</button>
                </div>
                {yards.length > 0 && (
                    <div className="toolbar" style={{marginTop: 8}}>
                        <select value={toYard || yards[0].id} onChange={e => setToYard(e.target.value)}>
                            {yards.map(y => <option key={y.id} value={y.id}>{y.yardName}</option>)}
                        </select>
                        <select value={toTarget} onChange={e => setToTarget(e.target.value)} title="Site the line goes to: names the take-off <voltage>_<site code>_L<n> when no name is typed">
                            <option value="">line to…</option>
                            {otherSites.map(g => <option key={g.id} value={g.id}>{g.groupName}</option>)}
                        </select>
                        <input type="text" value={toName} onChange={e => setToName(e.target.value.toUpperCase())} style={{width: 130}} onKeyDown={e => e.key === 'Enter' && addTakeOff()}
                               placeholder={toTarget ? (takeOffLineName(ed.doc, toYard || yards[0].id, toTarget) ?? 'line name') : 'Take-off line name'}/>
                        <NewIdField compact value={toId} onChange={setToId}/>
                        <button type="button" className="small" onClick={addTakeOff} disabled={(!toName.trim() && !toTarget) || !newIdOk(ed.doc, toId)}>Add take-off</button>
                    </div>
                )}
            </div>
            <LinesAtPanel refs={[...yards.map(y => ({kind: ConnectionJunctionKind.SUBSTATION, id: y.id})), ...(siteJunction ? [{kind: ConnectionJunctionKind.TRANSMISSION_JUNCTION, id: siteJunction.id}] : [])]} locate={locate}/>
        </>
    )
}

/* ---------- junction ---------- */

function JunctionPanel({meta, record, locate}: MapPanelsProps & { record: TransmissionJunctionRecord }) {
    const ed = useNetworkEditor()
    const d = useDraft(record)
    const [coords, setCoords] = useState(coordsText(record.coords))
    useEffect(() => setCoords(coordsText(record.coords)), [record])
    const parsed = parseCoords(coords)
    const conns = ed.doc.connections.filter(c => c.junction.kind === ConnectionJunctionKind.TRANSMISSION_JUNCTION && c.junction.id === record.id)
    /** The site this junction belongs to, when it is a site junction. */
    const site = record.groupId ? ed.doc.substationGroups.find(g => g.id === record.groupId) : undefined

    // Circuit ends here, attached or loose, with checkboxes: the checked ones can be put into one node.
    const [checkedEnds, setCheckedEnds] = useState<Set<string>>(new Set())
    useEffect(() => setCheckedEnds(new Set()), [record.id])
    const loose = useMemo(() => looseEndsAtJunction(ed.doc, record.id), [ed.doc, record.id])
    const endKeyOf = (e: CircuitEndRef) => `${e.circuitId}:${e.end}`
    const allEnds: CircuitEndRef[] = [...conns.flatMap(c => c.nodes.filter(n => n.kind === NetworkNodeKind.TRANSMISSION_CIRCUIT).map(n => ({circuitId: n.id, end: n.terminal as CircuitEnd}))), ...loose]
    const chosenEnds = allEnds.filter(e => checkedEnds.has(endKeyOf(e)))
    const toggleEnd = (e: CircuitEndRef) => setCheckedEnds(prev => {
        const next = new Set(prev)
        const k = endKeyOf(e)
        if (next.has(k)) next.delete(k)
        else next.add(k)
        return next
    })
    const connectChecked = () => {
        const ops = formJunctionNodeOps(ed.doc, record.id, chosenEnds)
        if (ops.length && ed.apply(ops)) setCheckedEnds(new Set())
    }
    /** Two or more ends go into one node; a single end only when it is not connected yet (it gets a node of its own). */
    const canConnect = chosenEnds.length >= 2 || (chosenEnds.length === 1 && loose.some(e => endKeyOf(e) === endKeyOf(chosenEnds[0])))
    /** A circuit end whose path ends here, connected on its own: a new node holding just this end. */
    const connectAlone = (e: CircuitEndRef) => {
        const ops = formJunctionNodeOps(ed.doc, record.id, [e])
        if (ops.length && ed.apply(ops)) setCheckedEnds(prev => {
            const next = new Set(prev)
            next.delete(endKeyOf(e))
            return next
        })
    }
    const endCheckbox = (e: CircuitEndRef) => <input type="checkbox" checked={checkedEnds.has(endKeyOf(e))} onChange={() => toggleEnd(e)} title="Check circuit ends, then Connect checked to put them into one node"/>

    return (
        <>
            <div className="panel">
                <Header title={`Junction ${record.name ?? record.id}`} badge={site ? `site junction of ${site.groupName}` : undefined} rename={{collection: 'junctions', id: record.id, auto: draftNaming(ed.doc, 'junctions', d.draft)?.id}} onDelete={() => {
                    if (window.confirm('Delete this junction? Circuit ends connected here become loose.')) {
                        ed.apply(cascadeDeleteOps(ed.doc, 'junctions', record.id))
                        ed.select(null)
                    }
                }}/>
                {site && (
                    <p className="small muted" style={{margin: '0 0 8px'}}>
                        The junction of site <a href="#" onClick={e => {
                            e.preventDefault()
                            ed.select({collection: 'substationGroups', id: site.id})
                            locate?.({collection: 'substationGroups', id: site.id})
                        }}>{site.groupName}</a>: circuits are joined or teed here without entering a yard. It sits at the site and moves with it; the site marker on the map stands for it.
                    </p>
                )}
                <div className="form-grid" style={{gridTemplateColumns: '1fr'}}>
                    <TextField label="Name" value={d.draft.name} onChange={v => d.set('name', v || undefined)} placeholder={site?.groupName} hint={site ? 'The site code when left empty' : undefined}/>
                    {site ? <TextField label="Coordinates" value={coords} onChange={() => undefined} readOnly mono hint="Follows the site (edit the site's coordinates or drag its marker)"/>
                        : <TextField label="Coordinates" value={coords} onChange={setCoords} mono error={parsed ? undefined : 'lat, lon expected'}/>}
                </div>
                <ApplyBar dirty={d.dirty || (parsed !== undefined && coordsText(parsed) !== coordsText(record.coords))} onReset={() => {
                    d.reset()
                    setCoords(coordsText(record.coords))
                }} onApply={() => parsed && ed.apply([{type: 'upsert', collection: 'junctions', record: {...d.draft, coords: parsed}}])}/>
            </div>
            <div className="panel">
                <div className="panel-header">
                    <h3 style={{margin: 0}}>Connections at this junction</h3>
                    <span className="spacer"/>
                    {chosenEnds.length > 0 && <span className="small muted">{chosenEnds.length} checked</span>}
                    <button type="button" className="small" disabled={!canConnect} onClick={connectChecked}
                            title="Put the checked circuit ends into one node (a splice or tee; a single loose end gets a node of its own); nodes left without circuit ends are removed">Connect checked</button>
                </div>
                {conns.length === 0 && <p className="small muted">No connections here yet. Use "+ Circuit" and click this junction as an end.</p>}
                {conns.map(c => (
                    <div key={c.id} style={{marginBottom: 8}}>
                        <div className="toolbar small">
                            <input type="text" defaultValue={c.name ?? ''} placeholder="Connection name" style={{width: 130}} title={c.id}
                                   onBlur={e => {
                                       const name = e.target.value.trim()
                                       if (name && name !== c.name) ed.apply([{type: 'upsert', collection: 'connections', record: {...c, name}}])
                                       else e.target.value = c.name ?? ''
                                   }}
                                   onKeyDown={e => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}/>
                            <select value={c.voltage ?? ''} title="Nominal voltage of this node (informational; circuits of other voltages may still connect)"
                                    onChange={e => ed.apply([{type: 'upsert', collection: 'connections', record: {...c, voltage: (e.target.value || undefined) as TransmissionVoltage | undefined}}])}>
                                <option value="">voltage: –</option>
                                {meta.enums.transmissionVoltage.map(v => <option key={v} value={v}>{enumLabel(v)}</option>)}
                            </select>
                            <label title="Planned (not built yet): drawn dotted inside the junction; a built circuit joined here gets a warning" style={{display: 'flex', gap: 4, alignItems: 'center'}}>
                                <input type="checkbox" checked={!!c.planned} onChange={e => ed.apply([{type: 'upsert', collection: 'connections', record: {...c, planned: e.target.checked || undefined}}])}/> planned
                            </label>
                            <span className="spacer" style={{flex: 1}}/>
                            <button type="button" className="small danger" title="Delete this node; its circuit ends come loose" onClick={() => ed.apply([{type: 'delete', collection: 'connections', id: c.id}])}>×</button>
                        </div>
                        <ul className="small" style={{margin: '4px 0 0', paddingLeft: 18}}>
                            {c.nodes.map(n => (
                                <li key={`${n.id}:${n.terminal}`} className="toolbar" style={{gap: 6}}>
                                    {n.kind === NetworkNodeKind.TRANSMISSION_CIRCUIT && endCheckbox({circuitId: n.id, end: n.terminal as CircuitEnd})}
                                    <a href="#" onClick={e => {
                                        e.preventDefault()
                                        ed.select({collection: 'circuits', id: n.id})
                                    }}>{describeNode(ed.doc, n)}</a>
                                    <MoveEndSelect circuitId={n.id} end={n.terminal as CircuitEnd} junctionId={record.id} currentId={c.id}/>
                                </li>
                            ))}
                        </ul>
                    </div>
                ))}
                {loose.length > 0 && (
                    <div style={{marginBottom: 8}}>
                        <div className="small muted">Not connected here (their path ends at this junction)</div>
                        <ul className="small" style={{margin: '4px 0 0', paddingLeft: 18}}>
                            {loose.map(e => (
                                <li key={endKeyOf(e)} className="toolbar" style={{gap: 6}}>
                                    {endCheckbox(e)}
                                    <a href="#" onClick={ev => {
                                        ev.preventDefault()
                                        ed.select({collection: 'circuits', id: e.circuitId})
                                    }}>{describeNode(ed.doc, {kind: NetworkNodeKind.TRANSMISSION_CIRCUIT, id: e.circuitId, terminal: e.end})}</a>
                                    <button type="button" className="small" onClick={() => connectAlone(e)} title="Connect this circuit end here in a new node of its own">+ node</button>
                                </li>
                            ))}
                        </ul>
                    </div>
                )}
                <p className="small muted">Circuit ends in the same node are electrically joined (a splice or tee); separate nodes are isolated. Check two or more circuit ends and press <em>Connect checked</em> to put them into one node; a single circuit end not connected yet (with <em>Connect checked</em> or its <em>+ node</em>) gets a node of its own. A node exists only with circuit ends in it: one left empty is removed.</p>
            </div>
            <BypassJunctionPanel junctionId={record.id} locate={locate}/>
            <LinesAtPanel refs={[{kind: ConnectionJunctionKind.TRANSMISSION_JUNCTION, id: record.id}]} locate={locate}/>
        </>
    )
}

/** Select that moves a circuit end into another node at the same junction, or into a new node. */
function MoveEndSelect({circuitId, end, junctionId, currentId}: { circuitId: string; end: CircuitEnd; junctionId: string; currentId: string }) {
    const ed = useNetworkEditor()
    const nodes = connectionsAtJunction(ed.doc, junctionId)
    return (
        <select value={currentId} className="small" title="Move this circuit end to another node at the junction"
                onChange={e => {
                    const v = e.target.value
                    if (v === '__new') {
                        const name = window.prompt('Name of the new node', nextJunctionConnectionName(ed.doc, junctionId)) ?? ''
                        if (!name.trim()) return
                        const id = window.prompt('Id of the new node (empty = generated)', '') ?? ''
                        ed.apply(moveCircuitEndOps(ed.doc, circuitId, end, {newName: name, newId: id}))
                    } else if (v !== currentId) ed.apply(moveCircuitEndOps(ed.doc, circuitId, end, {connectionId: v}))
                }}>
            {nodes.map(n => <option key={n.id} value={n.id}>{n.name ?? n.id}</option>)}
            <option value="__new">+ new node…</option>
        </select>
    )
}

/**
 * What passes through the junction (two circuit ends spliced in one node),
 * each with a checkbox: the checked ones are bypassed in one journaled step,
 * their two circuits joined into one running directly between the far ends
 * (`buildBypassPlan`). Nodes left without circuit ends go, and the junction
 * too when nothing is left there.
 */
function BypassJunctionPanel({junctionId, locate}: { junctionId: string; locate?: (sel: Selection) => void }) {
    const ed = useNetworkEditor()
    const doc = ed.doc
    const items = useMemo(() => passThroughs(doc, junctionId), [doc, junctionId])
    const [checked, setChecked] = useState<Set<string>>(new Set())
    // Drop checks of pass-throughs that are gone (bypassed, or changed elsewhere).
    useEffect(() => setChecked(prev => {
        const alive = new Set(items.filter(i => !i.reason).map(i => i.key))
        const next = new Set([...prev].filter(k => alive.has(k)))
        return next.size === prev.size ? prev : next
    }), [items])
    const selectable = items.filter(i => !i.reason)
    const allChecked = selectable.length > 0 && selectable.every(i => checked.has(i.key))
    const toggle = (key: string) => setChecked(prev => {
        const next = new Set(prev)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        return next
    })
    const bypass = () => {
        const keys = [...checked]
        let plan = buildBypassPlan(doc, junctionId, keys)
        if (plan.withExistingPath && window.confirm(`${plan.withExistingPath} of the checked already ha${plan.withExistingPath === 1 ? 's' : 've'} a path running between the joined ends.\n\nOK = run the joined circuit${plan.withExistingPath === 1 ? '' : 's'} on that existing path; Cancel = keep the route through this junction's position (an extended or new path).`))
            plan = buildBypassPlan(doc, junctionId, keys, {reuseExistingPaths: true})
        if (!plan.joined.length) return window.alert(plan.errors.join('\n') || 'Nothing to bypass.')
        const paths = plan.joined.map(j => j.path)
        const summary = [
            `Bypass ${plan.joined.length} pass-through${plan.joined.length === 1 ? '' : 's'}: ${plan.joined.map(j => `${j.circuit.name} + ${j.removed.name}`).join(', ')} become${plan.joined.length === 1 ? 's' : ''} ${plan.joined.length} circuit${plan.joined.length === 1 ? '' : 's'} running past the junction.`,
            `Paths: ${[...new Set(paths.map(p => `"${p.name}"${p.reused ? ' (existing)' : p.extended ? ' (extended)' : p.created ? ' (new)' : ''}`))].join(', ')}.`,
            plan.removedPaths.length ? `Removes unused path(s) ${plan.removedPaths.map(p => p.name).join(', ')}.` : '',
            plan.junctionRemoved ? 'Nothing is left at the junction: it is removed too.' : '',
            ...plan.errors.map(e => `✗ skipped: ${e}`),
            ...plan.warnings.map(w => `⚠ ${w}`),
        ].filter(Boolean).join('\n')
        if (!window.confirm(`${summary}\n\nContinue?`)) return
        const rename = plan.regenerate.changes.length > 0 && window.confirm(`Also rename the joined circuits and their paths by the model rules (${plan.regenerate.changes.length} change(s))?`)
        if (!ed.apply(rename ? [...plan.ops, ...plan.regenerate.ops] : plan.ops)) return
        setChecked(new Set())
        // The junction is gone: show the first joined circuit instead (under its new id when it was renamed).
        if (plan.junctionRemoved) {
            const id = plan.joined[0].circuit.id
            const sel: Selection = {collection: 'circuits', id: (rename && plan.regenerate.changes.find(c => c.collection === 'circuits' && c.id === id)?.newId) || id}
            ed.select(sel)
            locate?.(sel)
        }
    }
    return (
        <div className="panel">
            <div className="panel-header">
                <h3 style={{margin: 0}}>Through this junction</h3>
                <span className="spacer"/>
                {selectable.length > 1 && <label className="small" style={{display: 'flex', gap: 4, alignItems: 'center'}}>
                    <input type="checkbox" checked={allChecked} onChange={() => setChecked(allChecked ? new Set() : new Set(selectable.map(i => i.key)))}/> all
                </label>}
                <button type="button" className="small danger" disabled={checked.size === 0} onClick={bypass}
                        title="Join the two circuits of each checked pass-through into one circuit that runs directly between their far ends, no longer through this junction">Bypass checked</button>
            </div>
            {items.length === 0 && <p className="small muted" style={{margin: 0}}>Nothing passes through here (a pass-through is a node holding two circuit ends).</p>}
            <div className="find-results" style={{marginTop: 0}}>
                {items.map(i => (
                    <label key={i.key} className="find-item" style={{alignItems: 'flex-start', padding: '3px 0'}} title={i.reason}>
                        <input type="checkbox" checked={checked.has(i.key)} disabled={!!i.reason} onChange={() => toggle(i.key)} style={{marginTop: 3}}/>
                        <span className="small">
                            <strong>{i.lines.length ? i.lines.map(l => l.name).join(', ') : `${i.circuits[0].name} + ${i.circuits[1].name}`}</strong>
                            <span className="muted"> · {refLabel(doc, i.farEnds[0])} ↔ {refLabel(doc, i.farEnds[1])} · node {i.connection.name ?? i.connection.id}</span>
                            {i.lines.length > 0 && <span className="muted"><br/>{i.circuits[0].name} + {i.circuits[1].name}</span>}
                            {i.reason && <span className="warn-dot"><br/>⚠ {i.reason}</span>}
                        </span>
                    </label>
                ))}
            </div>
            {items.length > 0 && <p className="small muted" style={{marginBottom: 0}}>Bypassing joins the two circuits of a pass-through into one circuit that runs directly between their far ends (lines keep it as one section; lengths add up). The node here goes, unused paths are removed, and the junction too when nothing is left.</p>}
        </div>
    )
}

/* ---------- transmission path ---------- */

/**
 * Options for choosing a path end, or a place to route to: every site and every line junction. A route runs between
 * places: it is not specific to a voltage (so it ends at a site, not a yard), and a site's own junction is at the site.
 */
function useEndOptions() {
    const ed = useNetworkEditor()
    const doc = ed.doc
    const sites = doc.substationGroups.map(g => ({value: `G:${g.id}`, label: `${g.groupName}${g.name && g.name !== g.groupName ? ` – ${g.name}` : ''} (${doc.substations.filter(y => y.groupId === g.id).map(y => y.yardName).join(', ') || 'no yards'})`}))
        .sort((a, b) => a.label.localeCompare(b.label))
    const junctions = doc.junctions.filter(j => !j.groupId).map(j => ({value: `J:${j.id}`, label: `Junction ${j.name ?? j.id}`})).sort((a, b) => a.label.localeCompare(b.label))
    return [...sites, ...junctions]
}

const encodeRef = (r?: ConnectionJunctionRef) => r ? `${r.kind === ConnectionJunctionKind.SUBSTATION_GROUP ? 'G' : r.kind === ConnectionJunctionKind.SUBSTATION ? 'S' : 'J'}:${r.id}` : ''
const decodeRef = (v: string): ConnectionJunctionRef | undefined => {
    const m = /^([GSJ]):(.+)$/.exec(v)
    return m ? {kind: m[1] === 'G' ? ConnectionJunctionKind.SUBSTATION_GROUP : m[1] === 'S' ? ConnectionJunctionKind.SUBSTATION : ConnectionJunctionKind.TRANSMISSION_JUNCTION, id: m[2]} : undefined
}

/** Link to a site (a yard selects its site) or a junction, panning the map there. */
function RefLink({target, locate}: { target: ConnectionJunctionRef; locate?: (sel: Selection) => void }) {
    const ed = useNetworkEditor()
    const sel: Selection | undefined = target.kind === ConnectionJunctionKind.SUBSTATION_GROUP ? {collection: 'substationGroups', id: target.id}
        : target.kind === ConnectionJunctionKind.SUBSTATION
            ? (() => {
                const yard = ed.doc.substations.find(s => s.id === target.id)
                return yard ? {collection: 'substationGroups' as const, id: yard.groupId} : undefined
            })()
            : {collection: 'junctions', id: target.id}
    const label = refLabel(ed.doc, target)
    if (!sel) return <span>{label}</span>
    return <a href="#" title={target.kind === ConnectionJunctionKind.TRANSMISSION_JUNCTION ? 'Open the junction' : 'Open the site'} onClick={e => {
        e.preventDefault()
        ed.select(sel)
        locate?.(sel)
    }}>{label}</a>
}

/**
 * One end of a path: a select of the places a route can end at (every site and every line junction, `useEndOptions`; a
 * site junction or yard end shows as its site), changeable at any time, with the circuits attached there and *detach*.
 * Moving or detaching an end detaches the circuit ends at the old place (after a confirmation).
 */
function PathEndRow({path, end, locate}: { path: TransmissionPathRecord; end: CircuitEnd; locate?: (sel: Selection) => void }) {
    const ed = useNetworkEditor()
    const doc = ed.doc
    const ref = end === CIRCUIT_END_FROM ? path.from : path.to
    const other = end === CIRCUIT_END_FROM ? path.to : path.from
    const shown = pathEndOf(doc, ref) ?? ref
    const options = useEndOptions().filter(o => !other || !samePlace(doc, decodeRef(o.value), other))
    const circuits = doc.circuits.filter(c => c.pathId === path.id)
    const attachedHere = circuits.filter(c => atPathEnd(doc, circuitEndRef(doc, c.id, end), ref)).length
    const label = end === CIRCUIT_END_FROM ? 'FROM' : 'TO'
    const change = (v: string) => {
        const r = decodeRef(v)
        if (!r || (shown && samePlace(doc, r, shown))) return
        if (attachedHere && !window.confirm(`Move the ${label} end of ${path.name} from ${refLabel(doc, shown)} to ${refLabel(doc, r)}? The ${attachedHere} circuit end(s) attached at ${refLabel(doc, shown)} are detached.`)) return
        ed.apply(attachedHere ? [...detachPathEndOps(doc, path, end), ...attachPathEndOps(path, end, r)] : attachPathEndOps(path, end, r))
    }
    return (
        <>
            <dt>{end === CIRCUIT_END_FROM ? 'From' : 'To'}</dt>
            <dd>
                <span className="toolbar" style={{display: 'inline-flex', flexWrap: 'wrap'}}>
                    {!ref && <span className="warn-dot">⚠ not set</span>}
                    <select value={encodeRef(shown)} onChange={e => change(e.target.value)} style={{maxWidth: 220}}>
                        {!shown && <option value="">choose a site or junction…</option>}
                        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                    {shown && <>
                        <RefLink target={shown} locate={locate}/>
                        <span className="muted small">({attachedHere}/{circuits.length} circuits attached)</span>
                        <button type="button" className="small" title="Clear this end and detach the circuits here" onClick={() => {
                            if (!attachedHere || window.confirm(`Detach ${attachedHere} circuit end(s) at ${refLabel(doc, shown)} as well?`)) ed.apply(detachPathEndOps(doc, path, end))
                        }}>detach</button>
                    </>}
                </span>
            </dd>
        </>
    )
}

function PathPanel({record, setMode, locate}: MapPanelsProps & { record: TransmissionPathRecord }) {
    const ed = useNetworkEditor()
    const d = useDraft(record)
    const circuits = ed.doc.circuits.filter(c => c.pathId === record.id)
    /** Id / name the model rules give this path (`<from>-<to>`). */
    const auto = draftNaming(ed.doc, 'paths', d.draft)
    /** Lines that use at least one circuit of this path. */
    const lines = ed.doc.lines.filter(l => l.circuitIds.some(id => circuits.some(c => c.id === id)))
    /** Yards / junctions where a circuit of the path is connected other than at the path ends. */
    const elsewhere = circuits.flatMap(c => [circuitEndRef(ed.doc, c.id, CIRCUIT_END_FROM), circuitEndRef(ed.doc, c.id, CIRCUIT_END_TO)])
        .filter((r): r is ConnectionJunctionRef => !!r && !atPathEnd(ed.doc, r, record.from) && !atPathEnd(ed.doc, r, record.to))
        .filter((r, i, all) => all.findIndex(x => sameRef(x, r)) === i)
    return (
        <>
            <div className="panel">
                <Header title={`Path ${record.name}`} rename={{collection: 'paths', id: record.id, auto: auto?.id}} onDelete={() => {
                    if (window.confirm(`Delete path ${record.name}?${circuits.length ? ` Its ${circuits.length} circuit(s) stay, without a path (drawn as dashed lines between their ends).` : ''}`)) {
                        ed.apply(cascadeDeleteOps(ed.doc, 'paths', record.id))
                        ed.select(null)
                    }
                }}/>
                <div className="form-grid" style={{gridTemplateColumns: '1fr'}}>
                    <TextField label="Name" value={d.draft.name} onChange={v => d.set('name', v)} hint={auto && auto.name !== d.draft.name ? `Rule name: ${auto.name}` : undefined}
                               action={{label: 'auto', title: auto ? `Use the rule name ${auto.name}` : 'Set the ends first', disabled: !auto || auto.name === d.draft.name, onClick: () => auto && d.set('name', auto.name)}}/>
                </div>
                <ApplyBar dirty={d.dirty} onReset={d.reset} onApply={() => ed.apply([{type: 'upsert', collection: 'paths', record: d.draft}])}/>
                <h4 className="muted" style={{marginTop: 12}}>Ends</h4>
                <dl className="kv small">
                    <PathEndRow path={record} end={CIRCUIT_END_FROM} locate={locate}/>
                    <PathEndRow path={record} end={CIRCUIT_END_TO} locate={locate}/>
                </dl>
                <p className="small muted">A path runs between two places, a site or a line junction. Moving or detaching an end also detaches the circuits there; circuits are re-attached from their own panel.</p>
                <div className="toolbar" style={{marginTop: 10}}>
                    <button type="button" className="small" onClick={() => setMode('editWaypoints')}>Edit waypoints ({record.waypoints.length})</button>
                </div>
            </div>
            <DuplicatePathsBox path={record} locate={locate}/>
            <div className="panel">
                <h3>Circuits on this path ({circuits.length})</h3>
                {circuits.length === 0 && <p className="small muted">No circuit uses this path. It can be picked when creating a circuit, or deleted above.</p>}
                <CircuitsWithTower path={record} circuits={circuits} locate={locate}/>
                {elsewhere.length > 0 && (
                    <p className="small" style={{marginTop: 8}}>
                        <span className="warn-dot">⚠ Circuit ends away from the path ends:</span>{' '}
                        {elsewhere.map((r, i) => <span key={`${r.kind}:${r.id}`}>{i ? ', ' : ''}<RefLink target={r} locate={locate}/></span>)}
                    </p>
                )}
            </div>
            {circuits.length > 0 && <PathLinesPanel path={record} circuits={circuits} locate={locate}/>}
            <div className="panel">
                <h3>Lines over this path ({lines.length})</h3>
                {lines.length === 0 && <p className="small muted">No line uses a circuit of this path yet. Select a circuit and use "Form a line" in its panel.</p>}
                {lines.map(l => {
                    const onPath = l.circuitIds.filter(id => circuits.some(c => c.id === id))
                    return (
                        <div key={l.id} className="toolbar small" style={{marginBottom: 6}}>
                            <span style={{color: voltageColor(l.voltage)}}>■</span>
                            <div style={{flex: 1, minWidth: 0}}>
                                <a href="#" onClick={e => {
                                    e.preventDefault()
                                    ed.select({collection: 'lines', id: l.id})
                                    locate?.({collection: 'lines', id: l.id})
                                }}><strong>{l.name}</strong></a>
                                <span className="muted"> · {l.from ? <RefLink target={l.from} locate={locate}/> : '–'} → {l.to ? <RefLink target={l.to} locate={locate}/> : '–'}</span>
                                <div className="muted">{onPath.length} of {l.circuitIds.length} section{l.circuitIds.length === 1 ? '' : 's'} on this path: {onPath.map(id => ed.doc.circuits.find(c => c.id === id)?.name ?? id).join(', ')}</div>
                            </div>
                        </div>
                    )
                })}
            </div>
        </>
    )
}

/** Other paths between the same two places (either direction), with a button merging them into this one (`buildMergePathsPlan`). */
function DuplicatePathsBox({path, locate}: { path: TransmissionPathRecord; locate?: (sel: Selection) => void }) {
    const ed = useNetworkEditor()
    const doc = ed.doc
    const others = duplicatesOf(doc, path.id)
    if (!others.length) return null
    const count = (id: string) => doc.circuits.filter(c => c.pathId === id).length
    const merge = () => {
        const plan = buildMergePathsPlan(doc, path.id, others.map(o => o.id))
        if (plan.errors.length) return window.alert(plan.errors.join('\n'))
        const summary = [
            `Merge into ${path.name}:`,
            ...plan.merged.map(m => `• ${m.path.name}: ${m.circuits.length} circuit(s) move here${m.reversed ? ' (it ran the other way)' : ''}; the path is deleted`),
            plan.routeFrom ? `${path.name} had no waypoints: it takes over the route of ${plan.routeFrom.name}.` : '',
            ...plan.warnings.map(w => `⚠ ${w}`),
        ].filter(Boolean).join('\n')
        if (!window.confirm(`${summary}\n\nContinue?`)) return
        const rename = plan.regenerate.changes.length > 0 && window.confirm(`Also rename this path and the moved circuits by the model rules (${plan.regenerate.changes.length} change(s))?`)
        if (!ed.apply(rename ? [...plan.ops, ...plan.regenerate.ops] : plan.ops)) return
        const id = (rename && plan.regenerate.changes.find(c => c.collection === 'paths' && c.id === path.id)?.newId) || path.id
        ed.select({collection: 'paths', id})
        locate?.({collection: 'paths', id})
    }
    return (
        <div className="panel">
            <h3>Same ends as this path ({others.length})</h3>
            {others.map(o => (
                <div key={o.id} className="toolbar small" style={{marginBottom: 3}}>
                    <span className="warn-dot">⚠</span>
                    <a href="#" onClick={e => {
                        e.preventDefault()
                        ed.select({collection: 'paths', id: o.id})
                        locate?.({collection: 'paths', id: o.id})
                    }}><strong>{o.name}</strong></a>
                    <span className="muted">{refLabel(doc, o.from)} → {refLabel(doc, o.to)} · {count(o.id)} circuit{count(o.id) === 1 ? '' : 's'} · {o.waypoints.length} pts{runsReversed(doc, path, o) ? ' · runs the other way' : ''}</span>
                </div>
            ))}
            <div className="toolbar" style={{marginTop: 6}}>
                <button type="button" className="small primary" onClick={merge}>Merge {others.length === 1 ? 'it' : 'them'} into {path.name}</button>
            </div>
            <p className="small muted" style={{marginBottom: 0}}>Their circuits move onto this path (following its direction) and they are deleted; this path keeps its route (a straight one takes over theirs).</p>
        </div>
    )
}

/** What the path's line operations do with the checked circuits. */
type LineOp = 'via' | 'to' | 'from'

const LINE_OPS: { key: LineOp; label: string; title: string }[] = [
    {key: 'via', label: 'Route via', title: 'Cut the checked circuits where they pass a site or junction and run them through it'},
    {key: 'to', label: 'Route to', title: 'Run the checked circuits on past the TO end of the path to another site or junction'},
    {key: 'from', label: 'Route from', title: 'Start the checked circuits at another site or junction, coming in past the FROM end of the path'},
]

interface LineOpProps {
    path: TransmissionPathRecord
    /** The checked circuits. */
    chosen: TransmissionCircuitRecord[]
    locate?: (sel: Selection) => void
    /** After the operation was applied: clears the checks. */
    onDone: () => void
}

/** Sites and junctions the circuits of a path can be routed via, to or from: every one but the path's own ends. */
function useRouteOptions(path: TransmissionPathRecord) {
    const doc = useNetworkEditor().doc
    return useEndOptions().filter(o => {
        const ref = decodeRef(o.value)
        return !!ref && !atPathEnd(doc, ref, path.from) && !atPathEnd(doc, ref, path.to)
    })
}

/**
 * Line operations on a path: checkboxes pick circuits of the path (labelled by their lines, with *all*), the tabs what
 * happens to them: routed via a site or junction on the way (`RouteViaFields`), on past the TO end to another place or
 * in from another place past the FROM end (`RouteEndFields`). The checks stay when switching tabs.
 */
function PathLinesPanel({path, circuits, locate}: { path: TransmissionPathRecord; circuits: TransmissionCircuitRecord[]; locate?: (sel: Selection) => void }) {
    const ed = useNetworkEditor()
    const doc = ed.doc
    const [checked, setChecked] = useState<Set<string>>(new Set())
    const [op, setOp] = useState<LineOp>('via')
    useEffect(() => {
        setChecked(new Set())
    }, [path.id])
    const chosen = circuits.filter(c => checked.has(c.id))
    const lineNames = (c: TransmissionCircuitRecord) => doc.lines.filter(l => l.circuitIds.includes(c.id)).map(l => l.name)
    const toggle = (id: string) => setChecked(prev => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
    })
    const done = () => setChecked(new Set())
    return (
        <div className="panel">
            <div className="panel-header">
                <h3 style={{margin: 0}}>Re-route lines</h3>
                <span className="spacer"/>
                {circuits.length > 1 && <label className="small" style={{display: 'flex', gap: 4, alignItems: 'center'}}>
                    <input type="checkbox" checked={chosen.length === circuits.length} onChange={() => setChecked(chosen.length === circuits.length ? new Set() : new Set(circuits.map(c => c.id)))}/> all
                </label>}
            </div>
            <div className="panel-tabs" role="tablist" style={{margin: '6px 0'}}>
                {LINE_OPS.map(o => <button key={o.key} type="button" role="tab" aria-selected={op === o.key} className={op === o.key ? 'active' : ''} title={o.title} onClick={() => setOp(o.key)}>{o.label}</button>)}
            </div>
            <div className="find-results" style={{marginTop: 0}}>
                {circuits.map(c => (
                    <label key={c.id} className="find-item small" style={{padding: '2px 0'}}>
                        <input type="checkbox" checked={checked.has(c.id)} onChange={() => toggle(c.id)}/>
                        <VoltageSwatch circuit={c}/>
                        <span><strong>{lineNames(c).join(', ') || c.name}</strong>{lineNames(c).length > 0 && <span className="muted"> · {c.name}</span>}<span className="muted"> · {runVoltage(c) ?? 'no voltage'}</span></span>
                    </label>
                ))}
            </div>
            {op === 'via'
                ? <RouteViaFields path={path} circuits={circuits} chosen={chosen} locate={locate} onDone={done}/>
                : <RouteEndFields key={op} path={path} chosen={chosen} end={op === 'to' ? CIRCUIT_END_TO : CIRCUIT_END_FROM} locate={locate} onDone={done}/>}
        </div>
    )
}

/** The "don't reuse" option of a part: with every circuit going via, the cut path itself carries the first part not reused. */
const newPathLabel = (part: 'before' | 'after', all: boolean) => all && part === 'before' ? 'Cut this path at the via point (no reuse)' : 'New path (no reuse)'

/**
 * Route checked circuits of a path via a site or a junction (`buildRouteViaPlan`): at a junction (or a site's own
 * junction) the two parts are spliced and stay one run; into a yard they loop in through a take-off each, which only a
 * yard at the voltage the circuits are energized at allows (the others are listed disabled, with the reason).
 */
function RouteViaFields({path, circuits, chosen, locate, onDone}: LineOpProps & { circuits: TransmissionCircuitRecord[] }) {
    const ed = useNetworkEditor()
    const doc = ed.doc
    const [viaValue, setViaValue] = useState('')
    const [connect, setConnect] = useState('J')   // 'J' = through the site junction, 'Y:<id>' = into that yard
    /** Path choice per part: an existing path's id, NEW_PATH, or unset = the first existing path when there is one. */
    const [pathPick, setPathPick] = useState<{ before?: string; after?: string }>({})
    useEffect(() => {
        setViaValue('')
        setPathPick({})
    }, [path.id])
    const endOptions = useRouteOptions(path)
    const viaRef = decodeRef(viaValue)
    const site = viaRef?.kind === ConnectionJunctionKind.SUBSTATION_GROUP ? doc.substationGroups.find(g => g.id === viaRef.id) : undefined
    const yards = site ? yardChoices(doc, site.id, chosen) : []
    const siteJunction = site ? siteJunctionOf(doc, site.id) : undefined
    // a yard choice that is no longer allowed (other circuits checked) falls back to passing through
    const yardPick = connect.startsWith('Y:') ? yards.find(y => y.yard.id === connect.slice(2) && !y.reason) : undefined
    const via: RouteVia | undefined = !viaRef ? undefined
        : site ? (yardPick ? {kind: 'yard', yardId: yardPick.yard.id} : {kind: 'siteJunction', groupId: site.id})
            : {kind: 'junction', junctionId: viaRef.id}
    const pathChoices = via ? routeViaPathChoices(doc, path.id, via) : {before: [], after: []}
    const partChoice = (part: 'before' | 'after') => {
        const list = pathChoices[part], pick = pathPick[part]
        return pick === NEW_PATH ? undefined : list.find(p => p.id === pick) ?? list[0]
    }
    const reuseBefore = partChoice('before'), reuseAfter = partChoice('after')
    const viaName = site ? site.groupName : viaRef ? refLabel(doc, viaRef) : '…'

    const run = () => {
        if (!via || !chosen.length) return
        const plan = buildRouteViaPlan(doc, path.id, chosen.map(c => c.id), via, {reuseBeforeId: reuseBefore?.id, reuseAfterId: reuseAfter?.id})
        if (plan.errors.length) return window.alert(plan.errors.join('\n'))
        const summary = [
            `Route ${plan.circuits.length} circuit(s) of path ${path.name} via ${plan.viaLabel}:`,
            ...plan.circuits.map(x => `• ${x.original.name} → ${x.original.name} + ${x.continuation.name}`),
            `First part on ${plan.reused.before ? 'existing path' : plan.pathCut ? 'the cut path' : 'new path'} ${plan.pathA?.name}, second part on ${plan.reused.after ? 'existing path' : plan.pathCut && plan.reused.before ? 'the cut path' : 'new path'} ${plan.pathB?.name}.`,
            plan.pathCut ? '' : `The other circuits stay on ${path.name}.`,
            plan.removedPath ? `Path ${plan.removedPath.name} is removed: no circuits are left on it.` : '',
            ...plan.warnings.map(w => `⚠ ${w}`),
            plan.createdJunction ? `The site junction ${plan.createdJunction.name} is created.` : '',
            plan.takeOffs.length ? `New take-offs: ${plan.takeOffs.map(t => t.lineName).join(', ')}.` : '',
            plan.splitLines.length ? `Lines split at the yard: ${plan.splitLines.map(s => `${s.line.name} → ${s.line.name} + ${s.added.name}`).join('; ')}.` : '',
            plan.lines.length ? `${plan.lines.length} line(s) keep running through, one section more.` : '',
        ].filter(Boolean).join('\n')
        if (!window.confirm(`${summary}\n\nContinue?`)) return
        const rename = plan.regenerate.changes.length > 0 && window.confirm(`Also rename the changed circuits, paths and lines by the model rules (${plan.regenerate.changes.length} change(s))?`)
        if (!ed.apply(rename ? [...plan.ops, ...plan.regenerate.ops] : plan.ops)) return
        onDone()
        // the path may have been renamed: show the first part
        const pathId = (rename && plan.regenerate.changes.find(c => c.collection === 'paths' && c.id === plan.pathA?.id)?.newId) || plan.pathA?.id
        if (pathId) {
            ed.select({collection: 'paths', id: pathId})
            locate?.({collection: 'paths', id: pathId})
        }
    }

    return (
        <>
            <div className="form-grid" style={{gridTemplateColumns: '1fr', marginTop: 6}}>
                <SelectField label="Via" value={viaValue || undefined} options={endOptions} allowEmpty emptyLabel="Choose a site or junction…" onChange={v => {
                    setViaValue(v ?? '')
                    setConnect('J')
                }} hint="The circuits are cut where their route passes nearest to it"/>
                {site && (
                    <div className="field">
                        <label>Connect at {site.groupName}</label>
                        <select value={yardPick ? connect : 'J'} onChange={e => setConnect(e.target.value)}>
                            <option value="J">Pass through the site junction{siteJunction ? ` ${siteJunction.name ?? siteJunction.id}` : ' (created)'}: spliced, no yard</option>
                            {yards.map(y => <option key={y.yard.id} value={`Y:${y.yard.id}`} disabled={!!y.reason}>Into yard {y.yard.yardName} ({y.yard.voltage}){y.reason ? ` – ${y.reason}` : ''}</option>)}
                        </select>
                        <span className="hint">{yardPick ? 'Each circuit loops in through a new take-off toward each far end; its lines are split at the yard.' : 'The two parts are joined in one node at the site junction and stay one run; lines keep them as consecutive sections.'}
                            {yards.length > 0 && yards.every(y => y.reason) && chosen.length > 0 ? ` No yard here is at ${[...new Set(chosen.map(runVoltage))].join(' / ')}.` : ''}</span>
                    </div>
                )}
                {(['before', 'after'] as const).filter(part => pathChoices[part].length > 0).map(part => (
                    <div key={part} className="field">
                        <label>{part === 'before' ? `Path ${refLabel(doc, path.from)} – ${viaName}` : `Path ${viaName} – ${refLabel(doc, path.to)}`}</label>
                        <select value={(part === 'before' ? reuseBefore : reuseAfter)?.id ?? NEW_PATH} onChange={e => setPathPick(prev => ({...prev, [part]: e.target.value}))}>
                            {pathChoices[part].map(p => <option key={p.id} value={p.id}>Use existing path {p.name} ({doc.circuits.filter(c => c.pathId === p.id).length} circuits)</option>)}
                            <option value={NEW_PATH}>{newPathLabel(part, chosen.length === circuits.length)}</option>
                        </select>
                        <span className="hint">A path already runs there; the circuits can share it (one running the other way: they follow its direction).</span>
                    </div>
                ))}
            </div>
            <div className="toolbar" style={{marginTop: 6}}>
                <button type="button" className="small primary" disabled={!via || chosen.length === 0} onClick={run}>Route {chosen.length || ''} via {viaName}</button>
            </div>
        </>
    )
}

/**
 * Route checked circuits of a path to another site or junction past its TO end, or from one past its FROM end
 * (`buildRouteEndPlan`): at that end each circuit is spliced, through the junction there (a site's own, created when
 * missing), with new sections to / from the place chosen here; the last one enters a yard at the circuits' voltage
 * through a new take-off or ends in a node at a junction. The sections run on existing paths that already lead there,
 * directly or through line junctions (`routeEndRoutes`, the shortest picked by default), or on a new straight path;
 * lines through the circuits end at the new place. A take-off the circuits leave without a circuit at the old end can
 * be removed (checked by default).
 */
function RouteEndFields({path, chosen, end, locate, onDone}: LineOpProps & { end: CircuitEnd }) {
    const ed = useNetworkEditor()
    const doc = ed.doc
    const [placeValue, setPlaceValue] = useState('')
    /** 'J' = the site junction, 'Y:<id>' = into that yard, '' = the first yard the checked circuits may enter, else the junction. */
    const [connect, setConnect] = useState('')
    /** A route of existing paths (`routeKey`), NEW_PATH, or unset = the first route found, when there is one. */
    const [routePick, setRoutePick] = useState<string | undefined>()
    const [removeTakeOffs, setRemoveTakeOffs] = useState(true)
    useEffect(() => {
        setPlaceValue('')
        setConnect('')
        setRoutePick(undefined)
    }, [path.id])
    const placeOptions = useRouteOptions(path)
    const toEnd = end === CIRCUIT_END_TO
    const endRef = toEnd ? path.to : path.from
    const placeRef = decodeRef(placeValue)
    const site = placeRef?.kind === ConnectionJunctionKind.SUBSTATION_GROUP ? doc.substationGroups.find(g => g.id === placeRef.id) : undefined
    const yards = site ? yardChoices(doc, site.id, chosen) : []
    const siteJunction = site ? siteJunctionOf(doc, site.id) : undefined
    // a yard no longer allowed (other circuits checked) falls back to the first allowed one, else the site junction
    const yardPick = connect === 'J' ? undefined : yards.find(y => `Y:${y.yard.id}` === connect && !y.reason) ?? yards.find(y => !y.reason)
    const target: RouteTarget | undefined = !placeRef ? undefined
        : site ? (yardPick ? {kind: 'yard', yardId: yardPick.yard.id} : {kind: 'siteJunction', groupId: site.id})
            : {kind: 'junction', junctionId: placeRef.id}
    const routes = useMemo(() => target ? routeEndRoutes(doc, path.id, end, target) : [], [doc, path.id, end, placeValue, yardPick?.yard.id])  // eslint-disable-line react-hooks/exhaustive-deps
    const route = routePick === NEW_PATH ? undefined : routes.find(r => routeKey(r) === routePick) ?? routes[0]
    const freed = freedTakeOffs(doc, chosen.map(c => c.id), end)
    const placeName = site ? site.groupName : placeRef ? refLabel(doc, placeRef) : '…'
    const endName = refLabel(doc, endRef)
    const passJunction = endRef?.kind === ConnectionJunctionKind.TRANSMISSION_JUNCTION ? doc.junctions.find(j => j.id === endRef.id)
        : endRef ? siteJunctionOf(doc, endRef.id) : undefined
    /** Where the circuits are spliced at that end: the junction it is, or the site's junction. */
    const passLabel = endRef?.kind === ConnectionJunctionKind.TRANSMISSION_JUNCTION ? 'there' : `in the site junction ${passJunction ? passJunction.name ?? passJunction.id : '(created)'}`
    const km = (n?: number) => n !== undefined ? ` · ${n.toFixed(1)} km` : ''
    const routeLabel = (r: RouteEndRoute) => r.hops.length === 1
        ? `Existing path ${r.hops[0].path.name} (${doc.circuits.filter(c => c.pathId === r.hops[0].path.id).length} circuits)${km(r.km)}`
        : `Existing paths ${r.hops.map(h => h.path.name).join(' + ')} via ${r.via.map(j => j.name ?? j.id).join(', ')}${km(r.km)}`
    const from = locationOfRef(doc, endRef), to = placeRef && locationOfRef(doc, placeRef)
    const straightKm = from && to ? haversineKm(from.coords, to.coords) : undefined
    const takeOffLabel = (t: SubstationTakeOffRecord) => `${t.lineName} (${refLabel(doc, {kind: ConnectionJunctionKind.SUBSTATION, id: t.substationId})})`

    const run = () => {
        if (!target || !chosen.length) return
        const plan = buildRouteEndPlan(doc, path.id, chosen.map(c => c.id), end, target, {reusePathIds: route?.hops.map(h => h.path.id), removeFreedTakeOffs: removeTakeOffs})
        if (plan.errors.length) return window.alert(plan.errors.join('\n'))
        const created = plan.hops.find(h => h.created)
        const summary = [
            `Route ${plan.circuits.length} circuit(s) of path ${path.name} ${toEnd ? `to ${plan.targetLabel} (on past ${plan.endLabel})` : `from ${plan.targetLabel} (in past ${plan.endLabel})`}:`,
            ...plan.circuits.map(x => `• ${x.original.name} → ${(toEnd ? [x.original, ...x.sections] : [...[...x.sections].reverse(), x.original]).map(c => c.name).join(' + ')}`),
            `At ${plan.endLabel} each is spliced with its first new section${endRef?.kind === ConnectionJunctionKind.TRANSMISSION_JUNCTION ? '' : ` in the site junction ${plan.passJunction?.name ?? plan.passJunction?.id}`}.`,
            created ? `The new sections run on new path ${created.path.name} (straight: edit its waypoints after).`
                : `The new sections run on existing path${plan.hops.length === 1 ? '' : 's'} ${plan.hops.map(h => h.path.name).join(' + ')}${plan.via.length ? `, spliced at junction${plan.via.length === 1 ? '' : 's'} ${plan.via.map(j => j.name ?? j.id).join(', ')}` : ''}.`,
            plan.createdJunctions.length ? `Site junction${plan.createdJunctions.length === 1 ? '' : 's'} created: ${plan.createdJunctions.map(j => j.name ?? j.id).join(', ')}.` : '',
            plan.takeOffs.length ? `New take-offs: ${plan.takeOffs.map(t => t.lineName).join(', ')}.` : '',
            plan.takeOffsRemoved ? `Take-off${plan.freedTakeOffs.length === 1 ? '' : 's'} ${plan.freedTakeOffs.map(takeOffLabel).join(', ')} ${plan.freedTakeOffs.length === 1 ? 'is' : 'are'} removed, with ${plan.freedTakeOffs.length === 1 ? 'its' : 'their'} wiring in the yard.` : '',
            ...plan.lines.map(x => `Line ${x.line.name} now runs ${refLabel(doc, x.line.from)} → ${refLabel(doc, x.line.to)}${x.dropped.length ? `, without ${x.dropped.map(c => c.name).join(', ')}` : ''}.`),
            ...plan.warnings.map(w => `⚠ ${w}`),
        ].filter(Boolean).join('\n')
        if (!window.confirm(`${summary}\n\nContinue?`)) return
        const rename = plan.regenerate.changes.length > 0 && window.confirm(`Also rename the changed circuits, paths and lines by the model rules (${plan.regenerate.changes.length} change(s))?`)
        if (!ed.apply(rename ? [...plan.ops, ...plan.regenerate.ops] : plan.ops)) return
        onDone()
        // show the first path the new sections run on (a new one may have been renamed)
        const first = plan.hops[0]?.path.id
        const pathId = (rename && plan.regenerate.changes.find(c => c.collection === 'paths' && c.id === first)?.newId) || first
        if (pathId) {
            ed.select({collection: 'paths', id: pathId})
            locate?.({collection: 'paths', id: pathId})
        }
    }

    if (!endRef) return <p className="small muted" style={{marginBottom: 0}}>Set the path's {toEnd ? 'TO' : 'FROM'} end first.</p>
    return (
        <>
            <p className="small muted" style={{margin: '6px 0 0'}}>
                {toEnd ? `The checked circuits no longer end at ${endName}: they run on past it, and their lines end at the place chosen here.`
                    : `The checked circuits no longer start at ${endName}: they come in past it, and their lines start at the place chosen here.`}
            </p>
            <div className="form-grid" style={{gridTemplateColumns: '1fr', marginTop: 6}}>
                <SelectField label={toEnd ? 'To' : 'From'} value={placeValue || undefined} options={placeOptions} allowEmpty emptyLabel="Choose a site or junction…" onChange={v => {
                    setPlaceValue(v ?? '')
                    setConnect('')
                    setRoutePick(undefined)
                }} hint={`At ${endName} each circuit is spliced ${passLabel} with a new section ${toEnd ? 'running on to it' : 'coming from it'}`}/>
                {site && (
                    <div className="field">
                        <label>Connect at {site.groupName}</label>
                        <select value={yardPick ? `Y:${yardPick.yard.id}` : 'J'} onChange={e => setConnect(e.target.value)}>
                            {yards.map(y => <option key={y.yard.id} value={`Y:${y.yard.id}`} disabled={!!y.reason}>Into yard {y.yard.yardName} ({y.yard.voltage}){y.reason ? ` – ${y.reason}` : ''}</option>)}
                            <option value="J">Site junction{siteJunction ? ` ${siteJunction.name ?? siteJunction.id}` : ' (created)'}: a node of its own, no yard</option>
                        </select>
                        <span className="hint">{yardPick ? 'Each new section enters the yard through a new take-off; the lines end at the yard.' : 'Each new section ends in a node of its own at the site junction; a line ends at a yard only, so that end of the lines is cleared.'}
                            {yards.length > 0 && yards.every(y => y.reason) && chosen.length > 0 ? ` No yard here is at ${[...new Set(chosen.map(runVoltage))].join(' / ')}.` : ''}</span>
                    </div>
                )}
                {placeRef && !site && <span className="hint">Each new section ends in a node of its own at the junction (join it to others there from the junction panel); a line ends at a yard only, so that end of the lines is cleared.</span>}
                {target && (
                    <div className="field">
                        <label>Route {toEnd ? `${endName} – ${placeName}` : `${placeName} – ${endName}`}</label>
                        <select value={route ? routeKey(route) : NEW_PATH} onChange={e => setRoutePick(e.target.value)}>
                            {routes.map(r => <option key={routeKey(r)} value={routeKey(r)}>{routeLabel(r)}</option>)}
                            <option value={NEW_PATH}>New straight path{km(straightKm)}</option>
                        </select>
                        <span className="hint">{routes.length > 0
                            ? 'Existing paths already lead there (through line junctions when needed): the new sections run on them, one per path, spliced at each junction passed; on a path running the other way they follow its direction.'
                            : 'No existing path leads there: a new straight path is created; edit its waypoints after.'}</span>
                    </div>
                )}
                {freed.length > 0 && (
                    <label className="small" style={{display: 'flex', gap: 6, alignItems: 'flex-start'}}>
                        <input type="checkbox" checked={removeTakeOffs} onChange={e => setRemoveTakeOffs(e.target.checked)}/>
                        <span>Remove take-off{freed.length === 1 ? '' : 's'} {freed.map(takeOffLabel).join(', ')}, left without a circuit (with {freed.length === 1 ? 'its' : 'their'} wiring in the yard)</span>
                    </label>
                )}
            </div>
            <div className="toolbar" style={{marginTop: 6}}>
                <button type="button" className="small primary" disabled={!target || chosen.length === 0} onClick={run}>Route {chosen.length || ''} {toEnd ? 'to' : 'from'} {placeName}</button>
            </div>
        </>
    )
}

/* ---------- tower ---------- */

const TOWER_PANEL_KEY = 'thgrid.towerPanel'

/** A circuit's number on its tower in words: `1` → "1 (top left)", `4` → "4 (2nd right)". */
const towerNumberLabel = (n: number) => {
    const level = Math.ceil(n / 2)
    return `${n} (${level === 1 ? 'top' : level === 2 ? '2nd' : level === 3 ? '3rd' : `${level}th`} ${n % 2 === 1 ? 'left' : 'right'})`
}

/** The lines a circuit is a section of, by name. */
const circuitLines = (doc: NetworkDocument, circuitId: string) => doc.lines.filter(l => l.circuitIds.includes(circuitId)).sort((a, b) => a.name.localeCompare(b.name))

/**
 * The circuits of a path, each with its line(s) and its tower position (line group and number, `towerLayout.ts`;
 * "auto" = assigned when drawn), and below them a drawing of the towers (`TowerDiagram`) that folds away (open by
 * default; an explicit choice is remembered by the browser).
 */
function CircuitsWithTower({path, circuits, locate}: { path: TransmissionPathRecord; circuits: TransmissionCircuitRecord[]; locate?: (sel: Selection) => void }) {
    const ed = useNetworkEditor()
    const [show, setShow] = useState(() => {
        try {
            return window.localStorage.getItem(TOWER_PANEL_KEY) !== 'hide'
        } catch {
            return true
        }
    })
    const toggle = () => {
        setShow(!show)
        try {
            window.localStorage.setItem(TOWER_PANEL_KEY, show ? 'hide' : 'show')
        } catch {
            // storage unavailable: the choice is just not remembered
        }
    }
    const sorted = [...circuits].sort((a, b) => a.name.localeCompare(b.name))
    const slots = towerSlots(sorted)
    const maxGroup = Math.max(1, ...slots.map(s => s.group))
    const pick = (sel: Selection) => {
        ed.select(sel)
        locate?.(sel)
    }
    const open = (c: TransmissionCircuitRecord) => pick({collection: 'circuits', id: c.id})
    const setPosition = (c: TransmissionCircuitRecord, value: string) => {
        const {lineGroup: _g, groupCircuit: _s, ...rest} = c
        const [g, s] = value.split('-').map(Number)
        ed.apply([{type: 'upsert', collection: 'circuits', record: value === 'auto' ? rest : {...rest, lineGroup: g, groupCircuit: s}}])
    }
    if (!circuits.length) return null
    return (
        <div>
            {sorted.map(c => {
                const from = endLocation(ed.doc, c.id, CIRCUIT_END_FROM)
                const to = endLocation(ed.doc, c.id, CIRCUIT_END_TO)
                const warn = circuitWarnings(ed.doc, c.id).join(', ')
                const reVolted = !!c.energizedVoltage && c.energizedVoltage !== c.voltage
                const slot = slots.find(s => s.circuit.id === c.id)!
                const lines = circuitLines(ed.doc, c.id)
                return (
                    <div key={c.id} className="toolbar small" style={{marginBottom: 6}}>
                        <VoltageSwatch circuit={c}/>
                        <div style={{flex: 1, minWidth: 0}}>
                            <strong>{c.name}</strong>{c.voltage ? <span className="muted"> · {c.voltage}</span> : null}{reVolted ? <span className="muted"> · energized {enumLabel(c.energizedVoltage!)}</span> : null}<span className="muted" title="Conductor (bundle × size unit type)"> · {conductorText(c)}</span>
                            {warn && <span className="warn-dot"> ⚠ {warn}</span>}
                            <div className="muted">
                                {lines.length ? <>line {lines.map((l, i) => <span key={l.id}>{i ? ', ' : ''}<a href="#" onClick={e => {
                                    e.preventDefault()
                                    pick({collection: 'lines', id: l.id})
                                }}>{l.name}</a></span>)} · </> : 'no line · '}
                                {from?.label ?? 'loose'} → {to?.label ?? 'loose'}
                            </div>
                        </div>
                        <select value={c.lineGroup !== undefined && c.groupCircuit !== undefined ? `${c.lineGroup}-${c.groupCircuit}` : 'auto'} onChange={e => setPosition(c, e.target.value)}
                                title="Tower position: the line group (tower) and the circuit's place on it, looking from the path's FROM end; drives the order of the parallel lines on the map">
                            <option value="auto">auto (T{slot.group} {towerNumberLabel(slot.number)})</option>
                            {Array.from({length: maxGroup + 1}, (_, i) => i + 1).flatMap(g => Array.from({length: Math.max(2, ...slots.filter(s => s.group === g).map(s => s.number + 1))}, (_, k) => k + 1).map(n => (
                                <option key={`${g}-${n}`} value={`${g}-${n}`}>T{g} {towerNumberLabel(n)}</option>
                            )))}
                        </select>
                        <button type="button" className="small" onClick={() => open(c)}>Edit</button>
                    </div>
                )
            })}
            <div style={{borderTop: '1px solid var(--border)', marginTop: 6, paddingTop: 6}}>
                <button type="button" className="small" onClick={toggle} aria-expanded={show} title={show ? 'Fold the tower drawing away' : 'Show the circuits on their towers'}>
                    {show ? '▾' : '▸'} Towers ({maxGroup})
                </button>
                {show && <div style={{overflowX: 'auto', textAlign: 'center', marginTop: 4}}><TowerDiagram path={path} slots={slots} onPick={open}/></div>}
            </div>
        </div>
    )
}

/**
 * Schematic lattice towers seen from the path's FROM end, one per line group, side by side (group 1 on the left) on a
 * common ground line, each as tall as its pairs of circuits need, drawn like a double-circuit suspension tower: a
 * narrow straight body braced with X panels from the earth-wire arm down past the lowest cross-arm, then legs splaying
 * out to a wide braced base. On top the earth-wire arm (a flat top chord with members sloping down to the body, an earth
 * wire at each end); per pair of circuits (1 / 2 on top, 3 / 4 below, …) three lattice cross-arms, one per phase (flat
 * bottom chord, top chord rising to the body), the lowest one reaching a little further, an insulator string hanging
 * from each tip with the conductor under it: the left circuit's on the left, the right one's on the right, in its
 * voltage colour (paler and dashed when its position is assigned automatically; hollow where no circuit hangs), named
 * under its conductors by its line (else its own name's tail). Clicking a circuit's conductors opens it.
 */
function TowerDiagram({path, slots, onPick}: { path: TransmissionPathRecord; slots: TowerSlot[]; onPick: (c: TransmissionCircuitRecord) => void }) {
    const ed = useNetworkEditor()
    const groups = [...new Set(slots.map(s => s.group))].sort((a, b) => a - b)
    const levelsOf = (g: number) => Math.max(1, ...slots.filter(s => s.group === g).map(s => s.level))
    const maxLevels = Math.max(1, ...groups.map(levelsOf))
    const PHASES = 3, PHASE_GAP = 22, LEVEL_GAP = 16, REACH = 30, BODY = 4.5, BASE = 25, INSULATOR = 9, TW = 2 * (REACH + 4) + 76
    const LEVEL_H = PHASES * PHASE_GAP + LEVEL_GAP
    const earthY = 10, firstArm = 36
    /** Arm height on a tower with `levels` pairs: towers stand on one ground line, so a shorter one starts lower. */
    const armYOf = (levels: number) => (level: number, phase: number) => firstArm + (maxLevels - levels + level - 1) * LEVEL_H + phase * PHASE_GAP
    const footY = armYOf(maxLevels)(maxLevels, PHASES - 1) + 14 + 80, H = footY + 36, W = Math.max(1, groups.length) * TW
    const reach = (phase: number) => phase === PHASES - 1 ? REACH + 4 : REACH
    /** Label of a circuit on the tower: its line without the voltage (else the tail of its name), shortened to fit. */
    const label = (c: TransmissionCircuitRecord) => {
        const line = circuitLines(ed.doc, c.id)[0]
        const text = line ? line.name.replace(/^[^_]*KV(?:DC)?_/i, '') : /_(S\d+)$/.exec(c.name)?.[1] ?? c.name.slice(-8)
        return text.length > 14 ? `${text.slice(0, 13)}…` : text
    }
    const colorOf = (c: TransmissionCircuitRecord) => c.planned ? plannedVoltageColor(c.energizedVoltage ?? c.voltage) : voltageColor(c.energizedVoltage ?? c.voltage)
    const thin = {stroke: 'currentColor', strokeWidth: 0.6, fill: 'none', opacity: 0.75}
    const chord = {stroke: 'currentColor', strokeWidth: 1.3, fill: 'none'}

    /** Zigzag web between two chords given as functions of t ∈ [0, 1], in `panels` panels. */
    const web = (a: (t: number) => [number, number], b: (t: number) => [number, number], panels: number) => {
        let d = ''
        for (let i = 0; i < panels; i++) {
            const [p, q] = i % 2 === 0 ? [a(i / panels), b((i + 1) / panels)] : [b(i / panels), a((i + 1) / panels)]
            d += `M${p[0]} ${p[1]} L${q[0]} ${q[1]} `
        }
        return d
    }

    const tower = (g: number, index: number) => {
        const cx = index * TW + TW / 2
        const levels = levelsOf(g)
        const armY = armYOf(levels)
        const top = earthY + (maxLevels - levels) * LEVEL_H   // this tower's earth-wire arm
        const waistY = armY(levels, PHASES - 1) + 14
        /** Half width of the body at height y: straight down to the waist, then splaying out to the base. */
        const half = (y: number) => y <= waistY ? BODY : BODY + (BASE - BODY) * (y - waistY) / (footY - waistY)
        /** X-braced panels between the two legs from y1 to y2, `n` panels, with a strut at each panel line. */
        const bracing = (y1: number, y2: number, n: number) => {
            let d = ''
            for (let i = 0; i < n; i++) {
                const a = y1 + (y2 - y1) * i / n, b = y1 + (y2 - y1) * (i + 1) / n
                d += `M${cx - half(a)} ${a} L${cx + half(b)} ${b} M${cx + half(a)} ${a} L${cx - half(b)} ${b} M${cx - half(b)} ${b} L${cx + half(b)} ${b} `
            }
            return d
        }
        /** A cross-arm at height y toward `dir` (−1 left, 1 right): flat bottom chord, top chord rising to the body. */
        const arm = (y: number, dir: number, len: number, key: string) => {
            const x0 = cx + dir * BODY, x1 = cx + dir * len, rise = 8
            const topChord = (t: number): [number, number] => [x0 + (x1 - x0) * t, y - rise * (1 - t)]
            const bottom = (t: number): [number, number] => [x0 + (x1 - x0) * t, y]
            return (
                <g key={key}>
                    <path d={`M${x0} ${y - rise} L${x1} ${y} L${x0} ${y}`} {...chord}/>
                    <path d={web(topChord, bottom, 4)} {...thin}/>
                </g>
            )
        }
        const ew = REACH - 2
        return (
            <g key={g}>
                {/* earth-wire arm: flat top chord between the earth wires, members sloping down to the body */}
                <path d={`M${cx - ew} ${top} L${cx + ew} ${top} M${cx - ew} ${top} L${cx - BODY} ${top + 9} M${cx + ew} ${top} L${cx + BODY} ${top + 9}`} {...chord}/>
                {[-1, 1].map(dir => {
                    const tip = (t: number): [number, number] => [cx + dir * (ew - (ew - BODY) * t), top]
                    const low = (t: number): [number, number] => [cx + dir * (ew - (ew - BODY) * t), top + 9 * t]
                    return <path key={dir} d={web(tip, low, 4)} {...thin}/>
                })}
                {[-1, 1].map(dir => <circle key={`ew${dir}`} cx={cx + dir * ew} cy={top - 2.5} r={2.2} fill="currentColor"><title>earth wire</title></circle>)}
                {/* body: two legs, straight to the waist, then splaying out to the base; X bracing all the way */}
                <path d={`M${cx - BODY} ${top} L${cx - BODY} ${waistY} L${cx - BASE} ${footY} M${cx + BODY} ${top} L${cx + BODY} ${waistY} L${cx + BASE} ${footY}`} {...chord}/>
                <path d={bracing(top, waistY, Math.max(4, Math.round((waistY - top) / 9)))} {...thin}/>
                <path d={bracing(waistY, footY, 5)} {...thin}/>
                {Array.from({length: levels}, (_, i) => i + 1).map(level => [1, 2].map(side => {
                    const s = slots.find(t => t.group === g && t.level === level && t.side === side)
                    const dir = side === 1 ? -1 : 1
                    const color = s ? colorOf(s.circuit) : undefined
                    const lowest = armY(level, PHASES - 1)
                    return (
                        <g key={`${level}-${side}`} style={{cursor: s ? 'pointer' : undefined}} onClick={() => s && onPick(s.circuit)}>
                            {s && <title>{`${s.circuit.name} · tower ${g}, circuit ${s.number}${circuitLines(ed.doc, s.circuit.id).length ? ` · line ${circuitLines(ed.doc, s.circuit.id).map(l => l.name).join(', ')}` : ''}${s.auto ? ' · position assigned automatically' : ''}`}</title>}
                            {Array.from({length: PHASES}, (_, p) => {
                                const y = armY(level, p), x = cx + dir * reach(p)
                                return (
                                    <g key={p}>
                                        {arm(y, dir, reach(p), `a${p}`)}
                                        {/* insulator string: a stack of discs hanging from the tip */}
                                        <line x1={x} y1={y} x2={x} y2={y + INSULATOR} stroke="currentColor" strokeWidth={2.4} strokeDasharray="1.6 0.9"/>
                                        {s ? <circle cx={x} cy={y + INSULATOR + 3} r={3.2} fill={color} fillOpacity={s.auto ? 0.55 : 1} stroke={color} strokeWidth={1} strokeDasharray={s.auto ? '2 1.5' : undefined}/>
                                            : <circle cx={x} cy={y + INSULATOR + 3} r={2.8} fill="none" stroke="currentColor" strokeDasharray="1.5 1.5" opacity={0.45}/>}
                                    </g>
                                )
                            })}
                            {s && <text x={cx + dir * reach(PHASES - 1)} y={lowest + INSULATOR + 13} fontSize={8} fontWeight={700} textAnchor="middle" fill={color}
                                        style={{paintOrder: 'stroke', stroke: 'var(--panel, #fff)', strokeWidth: 3}}>{label(s.circuit)}</text>}
                        </g>
                    )
                }))}
                <text x={cx} y={footY + 11} fontSize={8} fontWeight={700} textAnchor="middle" fill="currentColor" opacity={0.8}>{`T${g}`}</text>
            </g>
        )
    }

    return (
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="tower-diagram" role="img" aria-label="Circuits on the towers">
            <line x1={0} y1={footY} x2={W} y2={footY} stroke="currentColor" strokeWidth={1} opacity={0.4}/>
            {groups.map((g, i) => tower(g, i))}
            <text x={W / 2} y={H - 6} fontSize={8} textAnchor="middle" fill="currentColor" opacity={0.7}>{`seen from ${refLabel(ed.doc, path.from)}`}</text>
        </svg>
    )
}

/* ---------- conductor ---------- */

/** The conductor values a circuit keeps: copied from a TRANSMISSION_CONDUCTOR template (the record stays self-describing). */
function conductorFromTemplate(data: TransmissionConductorTemplate): TransmissionConductor {
    return {size: data.size, unit: data.unit, type: data.type, code: data.code}
}

/** Short conductor text for lists: `4×1272 MCM ACSR/GA (code)`; `–` when unknown. */
function conductorText(c: TransmissionCircuitRecord): string {
    if (!c.conductor) return '–'
    return `${c.bundle ? `${c.bundle}×` : ''}${c.conductor.size} ${c.conductor.unit} ${c.conductor.type}${c.conductor.code ? ` (${c.conductor.code})` : ''}`
}

/** Fetches a conductor template and hands its values to `set`; without an id, or when the template cannot be loaded, the GENERIC conductor is used. */
async function loadConductor(id: string | undefined, set: (c: TransmissionConductor | undefined) => void) {
    if (!id) {
        set(genericConductor())
        return
    }
    try {
        const t = await api.templates.get(TemplateKind.TRANSMISSION_CONDUCTOR, id)
        set(conductorFromTemplate(t.data as TransmissionConductorTemplate))
    } catch (e) {
        window.alert(`${(e as Error).message}\n\nThe GENERIC conductor (size 0, SQMM) is used instead.`)
        set(genericConductor())
    }
}

/** Conductor of a circuit: "fill from template" plus size / unit / type / code, each editable. Renders grid cells (use inside a `form-grid`). */
function ConductorFields({meta, value, onChange}: { meta: MetaResponse; value?: TransmissionConductor; onChange: (c: TransmissionConductor | undefined) => void }) {
    const {templates} = useTemplates(TemplateKind.TRANSMISSION_CONDUCTOR)
    const set = (patch: Partial<TransmissionConductor>) => onChange({...genericConductor(), ...value, ...patch})
    const summary = value ? `${value.size} ${value.unit} ${value.type}${value.code ? ` (${value.code})` : ''}` : 'none (GENERIC when saved)'
    /** The template picker is shown only after the button is pressed. */
    const [picking, setPicking] = useState(false)
    return (
        <>
            {picking ? (
                <SelectField label="Conductor from template" value={undefined} emptyLabel="choose a conductor template…" options={templates.map(t => ({value: t.id, label: t.name}))} className="span-all"
                             onChange={v => {
                                 setPicking(false)
                                 if (v) void loadConductor(v, onChange)
                             }} hint="Copies size, unit, type and code into the fields below"/>
            ) : (
                <div className="toolbar span-all">
                    <span className="small">Conductor: <b>{summary}</b></span>
                    <span className="spacer" style={{flex: 1}}/>
                    <button type="button" className="small" disabled={templates.length === 0} title={templates.length ? 'Copy size, unit, type and code from a conductor template' : 'No conductor templates yet'}
                            onClick={() => setPicking(true)}>From conductor template…</button>
                </div>
            )}
            <NumberField label="Conductor size" value={value?.size} min={0} onChange={v => set({size: v ?? 0})}/>
            <SelectField label="Unit" value={value?.unit} options={meta.enums.transmissionWireUnit} onChange={v => set({unit: v as TransmissionWireUnit})}/>
            <SelectField label="Type" value={value?.type} options={meta.enums.transmissionWireType} onChange={v => set({type: v as TransmissionWireType})}/>
            <TextField label="Conductor code" value={value?.code} onChange={v => set({code: v || undefined})}
                       action={{label: 'generic', title: 'Reset to the GENERIC conductor (size 0, SQMM)', disabled: !!value && value.type === 'GENERIC' && value.size === 0, onClick: () => onChange(genericConductor())}}/>
        </>
    )
}

/* ---------- circuit ---------- */

/** When a circuit end sits at a junction: which node it is in, with the option to move it. */
function EndNodeSelect({circuit, end}: { circuit: TransmissionCircuitRecord; end: CircuitEnd }) {
    const ed = useNetworkEditor()
    const conn = circuitEndConnection(ed.doc, circuit.id, end)
    if (!conn || conn.junction.kind !== ConnectionJunctionKind.TRANSMISSION_JUNCTION) return null
    return <MoveEndSelect circuitId={circuit.id} end={end} junctionId={conn.junction.id} currentId={conn.id}/>
}

/** Controls to re-attach a loose circuit end at the place where its path ends. */
function AttachEnd({circuit, end, pathEnd}: { circuit: TransmissionCircuitRecord; end: CircuitEnd; pathEnd?: ConnectionJunctionRef }) {
    const ed = useNetworkEditor()
    const [takeOffId, setTakeOffId] = useState('')
    const [newName, setNewName] = useState('')
    const [newYardId, setNewYardId] = useState('')
    const [junctionNodeId, setJunctionNodeId] = useState('')
    if (!pathEnd) return <span className="warn-dot">⚠ loose <span className="muted">(set the path end first, in the path panel)</span></span>
    if (pathEnd.kind === ConnectionJunctionKind.TRANSMISSION_JUNCTION) {
        const nodes = connectionsAtJunction(ed.doc, pathEnd.id)
        return (
            <span className="toolbar" style={{display: 'inline-flex'}}>
                <span className="warn-dot">⚠ loose</span>
                <select value={takeOffId} onChange={e => setTakeOffId(e.target.value)}>
                    <option value="">{nodes.length ? 'node at junction…' : 'new node'}</option>
                    {nodes.map(n => <option key={n.id} value={n.id}>{n.name ?? n.id}</option>)}
                    <option value="__new">+ new node…</option>
                </select>
                <button type="button" className="small" disabled={nodes.length > 0 && !takeOffId} onClick={() => {
                    if (takeOffId === '__new' || !nodes.length) {
                        const name = window.prompt('Name of the new node', nextJunctionConnectionName(ed.doc, pathEnd.id)) ?? ''
                        if (!name.trim()) return
                        const id = window.prompt('Id of the new node (empty = generated)', '') ?? ''
                        ed.apply(attachCircuitEndToJunctionOps(ed.doc, circuit.id, end, pathEnd.id, circuit.voltage, {forceNew: true, newName: name, newId: id}))
                    } else ed.apply(attachCircuitEndToJunctionOps(ed.doc, circuit.id, end, pathEnd.id, circuit.voltage, {connectionId: takeOffId}))
                    setTakeOffId('')
                }}>Attach at {refLabel(ed.doc, pathEnd)}</button>
            </span>
        )
    }
    // At a site (or, in an older document, a single yard): a free take-off of any of its yards, or a new take-off at a chosen yard.
    const yards = (pathEnd.kind === ConnectionJunctionKind.SUBSTATION_GROUP ? ed.doc.substations.filter(y => y.groupId === pathEnd.id) : ed.doc.substations.filter(y => y.id === pathEnd.id)).sort((a, b) => a.yardName.localeCompare(b.yardName))
    const free = yards.flatMap(y => freeTakeOffs(ed.doc, y.id).map(t => ({takeOff: t, yard: y})))
    // The yard for a new take-off: the chosen one, else the yard at the circuit's energized / rated voltage, else the only one.
    const defaultYard = yards.find(y => y.voltage === (circuit.energizedVoltage ?? circuit.voltage)) ?? (yards.length === 1 ? yards[0] : undefined)
    const yard = yards.find(y => y.id === newYardId) ?? defaultYard
    const site = pathEnd.kind === ConnectionJunctionKind.SUBSTATION_GROUP ? ed.doc.substationGroups.find(g => g.id === pathEnd.id) : undefined
    const attachNew = () => {
        if (!newName.trim() || !yard) return
        const rec: SubstationTakeOffRecord = {id: uniqueId(ed.doc, takeOffNaming(ed.doc, yard.id, newName.trim()).id), substationId: yard.id, lineName: newName.trim(), takeOffColumn: true}
        const probe = {...ed.doc, takeOffs: [...ed.doc.takeOffs, rec]}
        ed.apply([{type: 'upsert', collection: 'takeOffs', record: rec}, ...attachCircuitEndToTakeOffOps(probe, circuit.id, end, rec.id)])
        setNewName('')
    }
    return (
        <span className="toolbar" style={{display: 'inline-flex', flexWrap: 'wrap'}}>
            <span className="warn-dot">⚠ loose</span>
            <select value={takeOffId} onChange={e => setTakeOffId(e.target.value)}>
                <option value="">{free.length ? `take-off at ${refLabel(ed.doc, pathEnd)}…` : `no free take-off at ${refLabel(ed.doc, pathEnd)}`}</option>
                {free.map(({takeOff, yard: y}) => <option key={takeOff.id} value={takeOff.id}>{yards.length > 1 ? `${y.yardName} · ` : ''}{takeOff.lineName}</option>)}
            </select>
            <button type="button" className="small" disabled={!takeOffId} onClick={() => {
                ed.apply(attachCircuitEndToTakeOffOps(ed.doc, circuit.id, end, takeOffId))
                setTakeOffId('')
            }}>Attach</button>
            {yards.length > 1 && (
                <select value={yard?.id ?? ''} onChange={e => setNewYardId(e.target.value)} title="Yard of the new take-off">
                    {!yard && <option value="">yard…</option>}
                    {yards.map(y => <option key={y.id} value={y.id}>{y.yardName}</option>)}
                </select>
            )}
            <input type="text" value={newName} placeholder="new take-off" style={{width: 110}} onChange={e => setNewName(e.target.value.toUpperCase())} onKeyDown={e => e.key === 'Enter' && attachNew()}/>
            <button type="button" className="small" disabled={!newName.trim() || !yard} onClick={attachNew} title={yard ? `Create the take-off at ${yard.yardName} and attach` : 'Pick the yard of the new take-off'}>Create & attach</button>
            {site && <SiteJunctionAttach circuit={circuit} end={end} site={site} nodeId={junctionNodeId} setNodeId={setJunctionNodeId}/>}
        </span>
    )
}

/**
 * Attaches a loose circuit end at a site's junction (no yard): into one of its nodes or a new node; the junction is
 * created first when the site has none. A path ending at the site counts as ending at its junction.
 */
function SiteJunctionAttach({circuit, end, site, nodeId, setNodeId}: {
    circuit: TransmissionCircuitRecord; end: CircuitEnd; site: SubstationGroupRecord; nodeId: string; setNodeId: (id: string) => void
}) {
    const ed = useNetworkEditor()
    const junction = siteJunctionOf(ed.doc, site.id)
    const nodes = junction ? connectionsAtJunction(ed.doc, junction.id) : []
    const chosen = nodes.find(n => n.id === nodeId)
    const label = junction ? junction.name ?? junction.id : undefined
    const attach = () => {
        if (junction) {
            ed.apply(attachCircuitEndToJunctionOps(ed.doc, circuit.id, end, junction.id, circuit.voltage, chosen ? {connectionId: chosen.id} : {forceNew: true}))
        } else {
            const rec = newSiteJunctionRecord(ed.doc, site)
            const probe = {...ed.doc, junctions: [...ed.doc.junctions, rec]}
            ed.apply([{type: 'upsert', collection: 'junctions', record: rec}, ...attachCircuitEndToJunctionOps(probe, circuit.id, end, rec.id, circuit.voltage, {forceNew: true})])
        }
        setNodeId('')
    }
    return (
        <span className="toolbar" style={{display: 'inline-flex', flexBasis: '100%'}}>
            <span className="muted">or site junction{label ? ` ${label}` : ''}:</span>
            {junction && (
                <select value={chosen?.id ?? ''} onChange={e => setNodeId(e.target.value)} title="Node at the site junction">
                    <option value="">+ new node</option>
                    {nodes.map(n => <option key={n.id} value={n.id}>{n.name ?? n.id}</option>)}
                </select>
            )}
            <button type="button" className="small" onClick={attach}
                    title={junction ? (chosen ? `Put this end into node ${chosen.name ?? chosen.id}` : `A new node at ${label} holding this end`) : `Create the junction of ${site.name ?? site.groupName} and a node holding this end`}>
                {junction ? 'Attach' : '+ junction & node'}
            </button>
        </span>
    )
}

function CircuitPanel({meta, record, setMode, locate}: MapPanelsProps & { record: TransmissionCircuitRecord }) {
    const ed = useNetworkEditor()
    const d = useDraft(record)
    const {templates} = useTemplates(TemplateKind.TRANSMISSION_CIRCUIT)
    const route = ed.doc.paths.find(p => p.id === record.pathId)
    const routeUsers = ed.doc.circuits.filter(c => c.pathId === record.pathId)
    const [pathName, setPathName] = useState(route?.name ?? '')
    useEffect(() => setPathName(route?.name ?? ''), [route])
    const from = endLocation(ed.doc, record.id, CIRCUIT_END_FROM)
    const to = endLocation(ed.doc, record.id, CIRCUIT_END_TO)

    /** The template picker is hidden until "Apply template…" is pressed, so a saved circuit is not re-templated by accident. */
    const [pickingTemplate, setPickingTemplate] = useState(false)
    useEffect(() => setPickingTemplate(false), [record.id])
    const applyTemplate = async (id: string | undefined) => {
        if (!id) {
            d.setDraft(x => ({...x, template: undefined}))
            return
        }
        try {
            const t = await api.templates.get(TemplateKind.TRANSMISSION_CIRCUIT, id)
            const data = t.data as TransmissionCircuitTemplateData
            d.setDraft(x => ({...x, voltage: data.voltage, bundle: data.bundle, conductorTemplateId: undefined}))
            await loadConductor(data.conductorId, c => d.setDraft(x => ({...x, conductor: c})))
        } catch (e) {
            window.alert((e as Error).message)
        }
    }

    const detach = (end: CircuitEnd) => {
        const ops = detachCircuitEndOps(ed.doc, record.id, end)
        if (ops.length) ed.apply(ops)
    }

    const commit = () => {
        const ops: NetworkOp[] = [{type: 'upsert', collection: 'circuits', record: {...d.draft, conductor: d.draft.conductor ?? genericConductor()}}]
        if (route && pathName.trim() && pathName.trim() !== route.name) ops.push({type: 'upsert', collection: 'paths', record: {...route, name: pathName.trim()}})
        ed.apply(ops)
    }
    /** Gives this circuit a path of its own: a new route without waypoints, ending where the circuit is connected. */
    const newPath = () => {
        const pathFrom = pathEndOf(ed.doc, circuitEndRef(ed.doc, record.id, CIRCUIT_END_FROM)) ?? route?.from
        const pathTo = pathEndOf(ed.doc, circuitEndRef(ed.doc, record.id, CIRCUIT_END_TO)) ?? route?.to
        const naming = pathNaming(ed.doc, pathFrom, pathTo)
        const created: TransmissionPathRecord = {id: uniqueId(ed.doc, naming.id), name: naming.name, from: pathFrom, to: pathTo, waypoints: []}
        ed.apply([{type: 'upsert', collection: 'paths', record: created}, {type: 'upsert', collection: 'circuits', record: {...d.draft, pathId: created.id}}])
    }
    const straightKm = from && to ? haversineKm(from.coords, to.coords) : undefined
    const reVolted = !!d.draft.energizedVoltage && d.draft.energizedVoltage !== d.draft.voltage
    /** Connected ends whose connection voltage differs from the energized voltage being edited. */
    const voltageMismatch = energizedMismatches(ed.doc, record.id, d.draft.energizedVoltage)
    /** Id / name the model rules give this circuit as edited (`<kV>_<site>_<site>_S<n>`). */
    const auto = draftNaming(ed.doc, 'circuits', d.draft)

    /** Swaps the FROM and TO ends: flips the end markers in every connection that holds this circuit and reverses the waypoints. */
    const swapEnds = () => {
        const flip = (t?: string) => (t === CIRCUIT_END_FROM ? CIRCUIT_END_TO : t === CIRCUIT_END_TO ? CIRCUIT_END_FROM : t)
        const ops: NetworkOp[] = []
        for (const conn of ed.doc.connections) {
            if (!conn.nodes.some(n => n.kind === NetworkNodeKind.TRANSMISSION_CIRCUIT && n.id === record.id)) continue
            ops.push({type: 'upsert', collection: 'connections', record: {...conn, nodes: conn.nodes.map(n => n.kind === NetworkNodeKind.TRANSMISSION_CIRCUIT && n.id === record.id ? {...n, terminal: flip(n.terminal)} : n)}})
        }
        // Reverse the waypoints only when no other circuit shares the path (they keep their own direction).
        if (route && route.waypoints.length > 1 && routeUsers.length === 1) ops.push({type: 'upsert', collection: 'paths', record: {...route, waypoints: [...route.waypoints].reverse()}})
        if (ops.length) ed.apply(ops)
    }

    return (
        <>
        <div className="panel">
            {route && (
                <div className="toolbar" style={{marginBottom: 8}}>
                    <button type="button" className="small" onClick={() => ed.select({collection: 'paths', id: route.id})} title="Back to the path and its circuits">‹ Path {route.name}</button>
                    {routeUsers.length > 1 && <span className="small muted">{routeUsers.length} circuits on this path</span>}
                </div>
            )}
            <Header title={record.name} rename={{collection: 'circuits', id: record.id, auto: auto?.id}} onDelete={() => {
                if (window.confirm(`Delete circuit ${record.name}?`)) {
                    ed.apply(cascadeDeleteOps(ed.doc, 'circuits', record.id))
                    ed.select(null)
                }
            }}/>
            <dl className="kv small" style={{marginBottom: 10}}>
                <dt>From</dt>
                <dd>{from ? <>{from.label} <EndNodeSelect circuit={record} end={CIRCUIT_END_FROM}/> <EndPlannedToggle circuitId={record.id} end={CIRCUIT_END_FROM}/> <button type="button" className="small" onClick={() => detach(CIRCUIT_END_FROM)}>detach</button></> : <AttachEnd circuit={record} end={CIRCUIT_END_FROM} pathEnd={route?.from}/>}</dd>
                <dt>To</dt>
                <dd>{to ? <>{to.label} <EndNodeSelect circuit={record} end={CIRCUIT_END_TO}/> <EndPlannedToggle circuitId={record.id} end={CIRCUIT_END_TO}/> <button type="button" className="small" onClick={() => detach(CIRCUIT_END_TO)}>detach</button></> : <AttachEnd circuit={record} end={CIRCUIT_END_TO} pathEnd={route?.to}/>}</dd>
                {straightKm !== undefined && <><dt>Straight</dt><dd>{straightKm.toFixed(2)} km</dd></>}
            </dl>
            <div className="toolbar" style={{marginBottom: 10}}>
                <button type="button" className="small" onClick={swapEnds} disabled={!from && !to} title="Exchange the FROM and TO ends (and reverse waypoints)">Swap from / to</button>
                <button type="button" className={`small ${pickingTemplate ? 'active' : ''}`} onClick={() => setPickingTemplate(v => !v)} title="Pick a circuit template to replace the rated voltage, bundle and conductor values">Apply template…</button>
                <button type="button" className="small" onClick={() => setMode('editWaypoints')} title="Edit the waypoints of this circuit's path on the map" disabled={!route}>Edit waypoints{route?.waypoints.length ? ` (${route.waypoints.length})` : ''}</button>
            </div>
            {voltageMismatch.length > 0 && (
                <Notice kind="warn">
                    <strong>⚠ Attention:</strong> energized at <b>{d.draft.energizedVoltage ?? 'no voltage'}</b>, but
                    {voltageMismatch.map((m, i) => <span key={m.end}>{i ? ' and' : ''} the {END_LABEL[m.end]} end joins <b>{m.connection.name ?? m.connection.id}</b> at <b>{m.expected}</b></span>)}.
                    {' '}Check the connections or{voltageMismatch.map(m => (
                    <button key={m.end} type="button" className="small" style={{marginLeft: 6}} onClick={() => d.set('energizedVoltage', m.expected)}>use {m.expected}</button>
                ))}
                </Notice>
            )}
            <div className="form-grid" style={{gridTemplateColumns: '1fr 1fr'}}>
                <TextField label="Name" value={d.draft.name} onChange={v => d.set('name', v)} className="span-all" hint={auto && auto.name !== d.draft.name ? `Rule name: ${auto.name}` : undefined}
                           action={{label: 'auto', title: auto ? `Use the rule name ${auto.name}` : 'No rule name without ends', disabled: !auto || auto.name === d.draft.name, onClick: () => auto && d.set('name', auto.name)}}/>
                {pickingTemplate && (
                    <SelectField label="Apply circuit template" value={undefined} emptyLabel="choose a template…" options={templates.map(t => ({value: t.id, label: t.name}))} className="span-all"
                                 onChange={v => {
                                     setPickingTemplate(false)
                                     if (v) void applyTemplate(v)
                                 }} hint="Replaces the rated voltage, bundle and conductor values with the template's (applied with Apply)"/>
                )}
                <SelectField label="Rated voltage" value={d.draft.voltage} options={meta.enums.transmissionVoltage} allowEmpty onChange={v => d.set('voltage', v as TransmissionVoltage | undefined)}
                             hint="Design voltage of the circuit (from the template)"/>
                <SelectField label="Energized voltage" value={d.draft.energizedVoltage} options={meta.enums.transmissionVoltage} allowEmpty onChange={v => d.set('energizedVoltage', v as TransmissionVoltage | undefined)}
                             hint={reVolted ? 'Differs from the rated voltage: drawn in this colour with a dotted overlay' : 'Set from the connection when an end is attached'}
                             error={voltageMismatch.length ? `differs from the connection at ${voltageMismatch.map(m => m.end).join(' and ')}` : undefined}/>
                <NumberField label="Bundle" value={d.draft.bundle} min={1} step={1} onChange={v => d.set('bundle', v)}/>
                <ConductorFields meta={meta} value={d.draft.conductor} onChange={v => d.set('conductor', v)}/>
                <NumberField label="Length (km)" value={d.draft.lengthKm} min={0} onChange={v => d.set('lengthKm', v)}/>
                <NumberField label="Line group (tower)" value={d.draft.lineGroup} min={1} step={1} onChange={v => d.set('lineGroup', v)}
                             hint="Towers run side by side, 1 on the left; empty = assigned when drawn, two circuits per tower"/>
                <SelectField label="Circuit on the tower" value={d.draft.groupCircuit === undefined ? undefined : String(d.draft.groupCircuit)} allowEmpty emptyLabel="auto"
                             options={Array.from({length: 6}, (_, i) => ({value: String(i + 1), label: towerNumberLabel(i + 1)}))}
                             onChange={v => d.set('groupCircuit', v ? Number(v) : undefined)} hint="Looking from the path's FROM end"/>
                <CheckboxField label="Planned (not built yet): drawn dotted in a dull voltage colour; a built connection or line using it gets a warning" checked={!!d.draft.planned} onChange={v => d.set('planned', v || undefined)} className="span-all"/>
                <SelectField label="Transmission path" value={d.draft.pathId} options={ed.doc.paths.map(p => ({value: p.id, label: `${p.name} (${p.waypoints.length} pts, ${ed.doc.circuits.filter(c => c.pathId === p.id).length} circuits)`}))}
                             allowEmpty emptyLabel="No path (dashed line between its ends)" onChange={v => d.set('pathId', v)} className="span-all"
                             error={!d.draft.pathId && !(from && to) ? 'without a path it is drawn only when both ends are attached' : undefined}
                             hint={!d.draft.pathId ? 'Drawn as a dashed straight line between its attached ends'
                                 : routeUsers.length > 1 ? `Shared with ${routeUsers.filter(c => c.id !== record.id).map(c => c.name).join(', ')}` : 'Only this circuit uses this path'}/>
                {route && <TextField label="Path name" value={pathName} onChange={setPathName} className="span-all"/>}
            </div>
            <div className="toolbar" style={{marginTop: 6}}>
                <button type="button" className="small" onClick={newPath} title="Create a separate, empty path for this circuit">New path for this circuit</button>
            </div>
            <ApplyBar dirty={d.dirty || (!!route && pathName.trim() !== route.name)} onReset={() => {
                d.reset()
                setPathName(route?.name ?? '')
            }} onApply={commit}/>
        </div>
        <LineHint circuit={record} locate={locate}/>
        </>
    )
}

/* ---------- lines ---------- */

/**
 * Lines the circuit is a section of, and "Form a line": walking from the circuit through junction nodes, every yard or
 * junction node reached on either side (`lineEndCandidates`) is offered as the line's From (the circuit's FROM side) and
 * To (its TO side). A pair that would duplicate, lie within or contain a line already using this circuit is listed
 * disabled with the reason (`formLine`; a tie that only shares part is fine). The line is named by the rules and selected.
 */
function LineHint({circuit, locate}: { circuit: TransmissionCircuitRecord; locate?: (sel: Selection) => void }) {
    const ed = useNetworkEditor()
    const doc = ed.doc
    const lines = linesOfCircuit(doc, circuit.id)
    const graph = useMemo(() => buildCircuitGraph(doc), [doc])
    const candidates = useMemo(() => lineEndCandidates(doc, circuit.id, graph), [doc, circuit.id, graph])
    /** The line every pair of candidates forms, [from][to]. */
    const pairs = useMemo(() => candidates.from.map(a => candidates.to.map(b => formLine(doc, circuit.id, a, b))), [doc, circuit.id, candidates])
    const [pick, setPick] = useState<{ from?: number; to?: number }>({})
    useEffect(() => setPick({}), [circuit.id])
    const fromOk = pairs.map(row => row.some(p => !p.problem))
    const isYard = (c: LineEndCandidate) => c.ref?.kind === ConnectionJunctionKind.SUBSTATION
    // default: the nearest yard on each side that still leaves a line to form, else the nearest place that does
    const firstOk = (list: LineEndCandidate[], ok: boolean[]) => {
        const yard = list.findIndex((c, i) => isYard(c) && ok[i])
        return yard >= 0 ? yard : ok.indexOf(true)
    }
    const fromIdx = pick.from !== undefined && fromOk[pick.from] ? pick.from : firstOk(candidates.from, fromOk)
    const toOk = candidates.to.map((_, b) => fromIdx >= 0 && !pairs[fromIdx][b].problem)
    const toIdx = pick.to !== undefined && toOk[pick.to] ? pick.to : firstOk(candidates.to, toOk)
    const chosen = fromIdx >= 0 && toIdx >= 0 ? pairs[fromIdx][toIdx] : undefined
    const naming = chosen && !chosen.problem ? lineNaming(doc, undefined, chosen.from, chosen.to, chosen.voltage) : undefined

    /** A candidate end in words: the place (yard, site junction or line junction, with the node when there are several) and how far it is. */
    const endLabel = (c: LineEndCandidate, side: 'FROM' | 'TO') => {
        const sections = c.chain.length ? ` · ${c.chain.length} section${c.chain.length === 1 ? '' : 's'} further` : ` · this circuit's ${side} end`
        if (!c.ref) return `loose ${side} end (the line's end stays unset)`
        if (c.ref.kind === ConnectionJunctionKind.SUBSTATION) return `${refLabel(doc, c.ref)} (yard)${sections}`
        const j = doc.junctions.find(x => x.id === c.ref!.id)
        const site = j?.groupId ? doc.substationGroups.find(g => g.id === j.groupId) : undefined
        const node = c.connectionId && connectionsAtJunction(doc, c.ref.id).length > 1 ? ` · node ${doc.connections.find(x => x.id === c.connectionId)?.name ?? c.connectionId}` : ''
        return `${site ? `${site.groupName} site junction` : `Junction ${j?.name ?? c.ref.id}`}${node}${sections}`
    }
    const form = () => {
        if (!chosen || chosen.problem || !naming) return
        const record: TransmissionLineRecord = {
            id: uniqueId(doc, naming.id), name: naming.name, voltage: chosen.voltage, circuitIds: chosen.circuitIds,
            ...(chosen.from ? {from: chosen.from} : {}), ...(chosen.to ? {to: chosen.to} : {}),
        }
        if (ed.apply([{type: 'upsert', collection: 'lines', record}])) {
            ed.select({collection: 'lines', id: record.id})
            locate?.({collection: 'lines', id: record.id})
        }
    }
    const removeFrom = (line: TransmissionLineRecord) => ed.apply([{type: 'upsert', collection: 'lines', record: {...line, circuitIds: line.circuitIds.filter(id => id !== circuit.id)}}])
    const circuitName = (id: string) => doc.circuits.find(c => c.id === id)?.name ?? id
    return (
        <div className="panel">
            <h3>Lines</h3>
            {lines.length === 0 ? <p className="small muted">Not a section of any line yet.</p> : lines.map(l => (
                <div key={l.id} className="toolbar small" style={{marginBottom: 4}}>
                    <span style={{color: voltageColor(l.voltage)}}>■</span>
                    <a href="#" onClick={e => {
                        e.preventDefault()
                        ed.select({collection: 'lines', id: l.id})
                        locate?.({collection: 'lines', id: l.id})
                    }}><strong>{l.name}</strong></a>
                    <span className="muted">{refLabel(doc, l.from)} → {refLabel(doc, l.to)} · section {l.circuitIds.indexOf(circuit.id) + 1} of {l.circuitIds.length}</span>
                    <span className="spacer" style={{flex: 1}}/>
                    <button type="button" className="small" title="Remove this circuit from the line" onClick={() => removeFrom(l)}>remove</button>
                </div>
            ))}
            <h4 className="muted" style={{marginTop: 10}}>Form a line</h4>
            {fromIdx < 0 ? (
                <p className="small muted" style={{marginBottom: 0}}>{lines.length
                    ? 'Every line this circuit can be part of is formed already (a new one would duplicate, lie within or contain one of its lines).'
                    : 'Nothing to form a line with: connect the circuit at a yard or a junction first.'}</p>
            ) : (
                <>
                    <div className="form-grid" style={{gridTemplateColumns: '1fr'}}>
                        <div className="field">
                            <label>From</label>
                            <select value={fromIdx} onChange={e => setPick({from: Number(e.target.value)})}>
                                {candidates.from.map((c, a) => <option key={a} value={a} disabled={!fromOk[a]}>{endLabel(c, 'FROM')}{fromOk[a] ? '' : ' – no line left to form from here'}</option>)}
                            </select>
                            <span className="hint">A yard or junction on the side of this circuit's FROM end</span>
                        </div>
                        <div className="field">
                            <label>To</label>
                            <select value={toIdx} onChange={e => setPick(p => ({...p, from: fromIdx, to: Number(e.target.value)}))}>
                                {candidates.to.map((c, b) => <option key={b} value={b} disabled={!toOk[b]}>{endLabel(c, 'TO')}{toOk[b] ? '' : ` – ${pairs[fromIdx][b].problem}`}</option>)}
                            </select>
                            <span className="hint">A yard or junction on the side of its TO end</span>
                        </div>
                    </div>
                    {chosen && naming && (
                        <p className="small" style={{margin: '6px 0'}}>
                            Line <b>{naming.name}</b>: {chosen.from ? refLabel(doc, chosen.from) : '–'} → {chosen.to ? refLabel(doc, chosen.to) : '–'}, {chosen.circuitIds.length} section{chosen.circuitIds.length === 1 ? '' : 's'}
                            <span className="muted"> ({chosen.circuitIds.map(circuitName).join(', ')})</span>
                        </p>
                    )}
                    <div className="toolbar">
                        <button type="button" className="small primary" disabled={!naming} onClick={form}>Form line</button>
                    </div>
                    <p className="small muted" style={{margin: '6px 0 0'}}>A line ends at a yard, or at a junction (a site junction or a line junction) where it stays open or ties in. Lines that only share part of their sections (a tie at a tee) can both use this circuit.</p>
                </>
            )}
        </div>
    )
}

/**
 * "New line" wizard: yard to yard, optionally through junctions in between,
 * conductor (circuit template), number of parallel circuits. Creates the
 * take-offs, one path per leg (reusing a path that already runs between two
 * consecutive stops unless a separate one is asked for), the circuit sections
 * attached at the yards and joined at the junctions, and one line per circuit,
 * as one journaled step (`buildNewLinePlan`).
 */
/** Route select value for "create a new path" (path ids never look like this). */
const NEW_PATH = '__new_path__'

function NewLineWizard({meta, locate, draft, setDraft, onDone}: { meta: MetaResponse; locate?: (sel: Selection) => void; draft: LineDraft; setDraft: Dispatch<SetStateAction<LineDraft>>; onDone: () => void }) {
    const ed = useNetworkEditor()
    const doc = ed.doc
    const {templates} = useTemplates(TemplateKind.TRANSMISSION_CIRCUIT)
    // The ends, the stops and the voltage live in the map editor (`LineDraft`), so clicking sites and junctions on the map sets them too.
    const {from, to, vias, voltage} = draft
    const setFrom = (v: string) => setDraft(d => ({...d, from: v}))
    const setTo = (v: string) => setDraft(d => ({...d, to: v}))
    const setVias = (f: (prev: string[]) => string[]) => setDraft(d => ({...d, vias: f(d.vias)}))   // stops passed in between, in order ('' = row not chosen yet)
    const setVoltage = (v: string | undefined) => setDraft(d => ({...d, voltage: v}))
    const [templateId, setTemplateId] = useState<string | undefined>()
    const [bundle, setBundle] = useState<number | undefined>()
    const [conductor, setConductor] = useState<TransmissionConductor | undefined>(genericConductor)
    const [count, setCount] = useState<number | undefined>(1)
    const [lengthKm, setLengthKm] = useState<number | undefined>()
    const [legs, setLegs] = useState<NewLineLegSpec[]>([])   // route choice per leg; an empty entry reuses an existing path when there is one
    const [lengthTouched, setLengthTouched] = useState(false)
    const [planned, setPlanned] = useState(false)
    const [reuseTakeOffs, setReuseTakeOffs] = useState(true)
    /** Energized voltage of the new sections; empty = taken from their connections. */
    const [energizedVoltage, setEnergizedVoltage] = useState<string | undefined>()

    const fromYard = lineEndYardOf(doc, from)
    const toYard = lineEndYardOf(doc, to)
    /** Stops in between: `J:<junction id>` or `G:<site id>` (the site's junction, created when missing); '' = row not chosen yet. */
    const chosenVias: NewLineVia[] = vias.filter(Boolean).map(v => v.startsWith('G:') ? {groupId: v.slice(2)} : {junctionId: v.slice(2)})
    // Default the voltage to an end yard's (the FROM one first) when nothing was picked yet.
    const endYard = fromYard ?? toYard
    useEffect(() => {
        if (endYard && !templateId && voltage === undefined) setVoltage(endYard.voltage)
    }, [endYard, templateId, voltage])

    // Reset the route choices when the stops change: every leg reuses an existing path again when there is one.
    const stopsKey = [from, ...vias.filter(Boolean), to].join('|')
    useEffect(() => setLegs([]), [stopsKey])
    const setLeg = (i: number, patch: NewLineLegSpec) => setLegs(prev => {
        const next = [...prev]
        next[i] = {...(next[i] ?? {}), ...patch}
        return next
    })
    // A stop in between is a free junction or a site (passed through its site junction); the ends' sites and junctions are not offered.
    const endPlaces = new Set([lineEndPlace(doc, from), lineEndPlace(doc, to)].filter(Boolean))
    const viaOptions = [
        ...doc.substationGroups.filter(g => !endPlaces.has(g.id)).map(g => {
            const j = siteJunctionOf(doc, g.id)
            return {value: `G:${g.id}`, label: `Site ${g.groupName} (${j ? `junction ${j.name ?? j.id}` : 'new site junction'})`}
        }),
        ...doc.junctions.filter(j => !j.groupId && !endPlaces.has(j.id)).map(j => ({value: `J:${j.id}`, label: `Junction ${j.name ?? j.id}`})),
    ].sort((a, b) => a.label.localeCompare(b.label))
    const setVia = (i: number, id: string) => setVias(prev => prev.map((v, k) => k === i ? id : v))
    const removeVia = (i: number) => setVias(prev => prev.filter((_, k) => k !== i))
    const moveVia = (i: number, to: number) => setVias(prev => {
        if (to < 0 || to >= prev.length) return prev
        const next = [...prev]
        const [x] = next.splice(i, 1)
        next.splice(to, 0, x)
        return next
    })

    const pickTemplate = async (id: string | undefined) => {
        setTemplateId(id)
        if (!id) return
        try {
            const t = await api.templates.get(TemplateKind.TRANSMISSION_CIRCUIT, id)
            const data = t.data as TransmissionCircuitTemplateData
            setVoltage(data.voltage)
            setBundle(data.bundle)
            void loadConductor(data.conductorId, setConductor)
        } catch (e) {
            window.alert((e as Error).message)
        }
    }

    const spec: NewLineSpec = {
        from, to, vias: chosenVias, circuits: count ?? 0, energizedVoltage: energizedVoltage as TransmissionVoltage | undefined,
        voltage: voltage as TransmissionVoltage | undefined, bundle, conductor, lengthKm, legs, planned, reuseTakeOffs,
    }
    const plan = useMemo(() => buildNewLinePlan(doc, spec), [doc, from, to, stopsKey, energizedVoltage, count, templateId, voltage, bundle, conductor, lengthKm, legs, planned, reuseTakeOffs])  // eslint-disable-line react-hooks/exhaustive-deps
    const freeTakeOffNote = [
        plan.freeTakeOffs.from.length ? `${fromYard?.yardName ?? 'FROM'}: ${plan.freeTakeOffs.from.map(t => t.lineName).join(', ')}` : '',
        plan.freeTakeOffs.to.length ? `${toYard?.yardName ?? 'TO'}: ${plan.freeTakeOffs.to.map(t => t.lineName).join(', ')}` : '',
    ].filter(Boolean).join(' · ')
    /** Name of a stop, from the plan (a site junction the plan creates is not in the document yet). */
    const stopLabel = (ref: ConnectionJunctionRef) => plan.stopLabels[plan.stops.findIndex(s => s.kind === ref.kind && s.id === ref.id)] ?? refLabel(doc, ref)
    const km = plan.km
    // Pre-fill the length with the straight-line distance through the stops until the user edits it.
    useEffect(() => {
        if (!lengthTouched) setLengthKm(km)
    }, [km, lengthTouched])

    const create = () => {
        if (plan.errors.length || !plan.ops.length) return
        if (ed.apply(plan.ops)) {
            const first = plan.circuits[0]?.line
            if (first) {
                ed.select({collection: 'lines', id: first.id})
                locate?.({collection: 'lines', id: first.id})
            }
            onDone()
        }
    }

    return (
        <div className="regen-box" style={{marginBottom: 10}}>
            <p className="small muted" style={{margin: '0 0 8px'}}>Pick the two ends (a site, then one of its yards or its site junction, or a line junction), any junctions the line passes in between, and the conductor (on the map: click the FROM site or junction, the TO site, then the junctions or sites in between, in order; right-click one to take it out); the wizard creates a take-off per circuit at each yard end (a node of its own per circuit at a junction end, where the line stays open), a route per leg (reusing one that already runs between two stops), the circuit sections (attached, joined at the junctions and energized) and one line per circuit, all named by the model rules.</p>
            <div className="form-grid" style={{gridTemplateColumns: '1fr 1fr'}}>
                <LineEndField label="From" value={from} other={to} onChange={setFrom}/>
                <LineEndField label="To" value={to} other={from} onChange={setTo}/>
                <div className="span-all">
                    <div className="toolbar small" style={{marginBottom: vias.length ? 4 : 0}}>
                        <span className="muted">Via junctions ({chosenVias.length}){plan.newJunctions.length ? <> · creates {plan.newJunctions.map(j => <b key={j.id}>{j.name ?? j.id}</b>).reduce<ReactNode[]>((acc, x, i) => i ? [...acc, ', ', x] : [x], [])}</> : null}</span>
                        <span className="spacer" style={{flex: 1}}/>
                        <button type="button" className="small" disabled={!viaOptions.length || vias.length >= LINE_MAX_VIAS} onClick={() => setVias(prev => [...prev, ''])}
                                title={viaOptions.length ? 'Pass a junction or a site (through its site junction) between the yards; the line gets one section per leg' : 'No other sites or junctions in this network yet'}>+ Junction in between</button>
                    </div>
                    {vias.map((id, i) => (
                        <div key={i} className="toolbar small" style={{marginBottom: 4}}>
                            <span className="muted">{i + 1}.</span>
                            <select value={id} onChange={e => setVia(i, e.target.value)} style={{flex: 1}}>
                                <option value="">choose a junction or a site…</option>
                                {viaOptions.filter(o => o.value === id || !vias.includes(o.value)).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                            </select>
                            <button type="button" className="small" disabled={i === 0} onClick={() => moveVia(i, i - 1)} title="Pass earlier">↑</button>
                            <button type="button" className="small" disabled={i === vias.length - 1} onClick={() => moveVia(i, i + 1)} title="Pass later">↓</button>
                            <button type="button" className="small" onClick={() => removeVia(i)} title="Remove this stop">✕</button>
                        </div>
                    ))}
                </div>
                <SelectField label="Conductor (circuit template)" value={templateId} options={templates.map(t => ({value: t.id, label: t.name}))} allowEmpty onChange={v => void pickTemplate(v)} className="span-all"
                             hint={templates.length ? 'Fills voltage, bundle and conductor' : 'No circuit templates yet'}/>
                <SelectField label="Voltage" value={voltage} options={meta.enums.transmissionVoltage} allowEmpty onChange={setVoltage}/>
                <NumberField label="Bundle" value={bundle} min={1} step={1} onChange={setBundle}/>
                <ConductorFields meta={meta} value={conductor} onChange={setConductor}/>
                <NumberField label="Circuits" value={count} min={1} step={1} onChange={setCount} hint="Parallel circuits on the same route"/>
                <SelectField label="Energized voltage" value={energizedVoltage} options={meta.enums.transmissionVoltage} allowEmpty emptyLabel="from the connections"
                             onChange={setEnergizedVoltage} hint="Optional: e.g. 0V (De-Energized) for a line built but not in service"/>
                <NumberField label="Length (km)" value={lengthKm} min={0} onChange={v => {
                    setLengthTouched(true)
                    setLengthKm(v)
                }} hint={km !== undefined ? `straight line ${km} km${plan.legs.length > 1 ? ', shared among the sections by distance' : ''}` : undefined}/>
                <CheckboxField label="Planned line (not built yet): take-offs, circuits, lines and new connections are created planned and drawn in grey" checked={planned} onChange={setPlanned} className="span-all"/>
                {freeTakeOffNote && <CheckboxField label={`Use the free take-offs the yards already have toward each other instead of creating new ones (${freeTakeOffNote})`} checked={reuseTakeOffs} onChange={setReuseTakeOffs} className="span-all"/>}
                {plan.legs.map((leg, i) => {
                    const choice = legs[i] ?? {}
                    const multi = plan.legs.length > 1
                    const legName = `${stopLabel(leg.from)} → ${stopLabel(leg.to)}`
                    return (
                        <div key={i} className="span-all form-grid" style={{gridTemplateColumns: '1fr 1fr', padding: multi ? '6px 8px' : 0, border: multi ? '1px solid var(--border, #d0d7de)' : 'none', borderRadius: 6}}>
                            {multi && <div className="small span-all"><strong>Leg {i + 1}</strong> · {legName}{leg.km !== undefined ? <span className="muted"> · straight line {leg.km.toFixed(2)} km</span> : null}</div>}
                            {leg.existing.length + leg.otherVoltage.length > 0 ? (
                                <SelectField label={multi ? 'Route' : `Route ${legName}`} className="span-all"
                                             value={choice.createPath ? NEW_PATH : choice.pathId ? choice.pathId : leg.needsDecision ? undefined : leg.path.created ? NEW_PATH : leg.path.id}
                                             emptyLabel="choose: share the existing path or create a new one…"
                                             options={[
                                                 {value: NEW_PATH, label: 'Create a new path'},
                                                 ...leg.existing.map(p => ({value: p.id, label: `Use existing: ${p.name} (${doc.circuits.filter(c => c.pathId === p.id).length} circuits, ${p.waypoints.length} pts)`})),
                                                 ...leg.otherVoltage.map(o => ({value: o.path.id, label: `Use existing: ${o.path.name} – carries ${o.voltages.join(' / ')} circuits (${doc.circuits.filter(c => c.pathId === o.path.id).length} circuits, ${o.path.waypoints.length} pts)`})),
                                             ]}
                                             onChange={v => setLeg(i, !v || v === NEW_PATH ? {createPath: v === NEW_PATH, pathId: undefined} : {createPath: false, pathId: v})}
                                             error={leg.needsDecision ? `the existing route carries ${[...new Set(leg.otherVoltage.flatMap(o => o.voltages))].join(' / ')} circuits while this line is ${fromYard?.voltage}: decide before creating` : undefined}
                                             hint={leg.needsDecision ? undefined : 'A route between these stops already exists: run the new sections on it, or create a separate path'}/>
                            ) : <p className="small muted span-all" style={{margin: 0}}>No route between {legName} yet: a new path is created (waypoints can be added afterwards).</p>}
                            {leg.path.created && <TextField label="New path name" value={choice.pathName ?? ''} onChange={v => setLeg(i, {pathName: v})} placeholder={leg.path.name || 'rule name'} className="span-all"/>}
                        </div>
                    )
                })}
            </div>
            {plan.legs.some(l => l.existing.length + l.otherVoltage.length > 0) && (() => {
                const withPath = plan.legs.filter(l => l.existing.length + l.otherVoltage.length > 0)
                const verdict = withPath.some(l => l.needsDecision) ? 'Choose, per leg, whether the new sections share it or get a separate path.'
                    : withPath.every(l => !l.path.created) ? 'The new sections will share it.'
                        : withPath.some(l => !l.path.created) ? 'Some sections share it, others get a new, separate path.' : 'A new, separate path will be created.'
                return <Notice kind="warn">⚠ A path already exists between {withPath.map(l => `${stopLabel(l.from)} and ${stopLabel(l.to)}`).join(', ')}. <b>{verdict}</b></Notice>
            })()}
            {plan.warnings.map(w => <p key={w} className="small warn-dot" style={{margin: '6px 0 0'}}>⚠ {w}</p>)}
            {plan.errors.length > 0 && fromYard && toYard && <p className="small muted" style={{margin: '6px 0 0'}}>{plan.errors.join('; ')}</p>}
            {plan.circuits.length > 0 && (
                <div className="small" style={{marginTop: 8}}>
                    <strong>Will create</strong> · {plan.legs.length === 1 ? 'path' : `${plan.legs.length} legs:`} {plan.legs.map((l, i) => (
                        <span key={l.path.id}>{i > 0 ? ', ' : ''}<b>{l.path.name}</b>{l.path.created ? '' : ' (existing)'}</span>
                    ))}
                    <ul style={{margin: '4px 0 0', paddingLeft: 18}}>
                        {plan.circuits.map(c => (
                            <li key={c.line.id}>
                                line <b>{c.line.name}</b>: {c.sections.length === 1 ? 'circuit' : `${c.sections.length} sections`} {c.sections.map((s, i) => (
                                    <span key={s.id}>{i > 0 ? ' → ' : ''}<b>{s.name}</b>{s.energizedVoltage ? ` (${s.energizedVoltage})` : ''}</span>
                                ))}, take-offs <span className="mono">{c.fromTakeOff?.lineName ?? 'none (junction)'}</span>{c.reused.from ? ' (existing)' : ''} → <span className="mono">{c.toTakeOff?.lineName ?? 'none (junction)'}</span>{c.reused.to ? ' (existing)' : ''}
                            </li>
                        ))}
                    </ul>
                </div>
            )}
            <div className="toolbar" style={{marginTop: 8}}>
                <button type="button" className="primary small" disabled={plan.errors.length > 0 || plan.ops.length === 0} onClick={create}>Create {plan.circuits.length || ''} line{plan.circuits.length === 1 ? '' : 's'}</button>
                <button type="button" className="small" onClick={onDone}>Cancel</button>
            </div>
        </div>
    )
}

/**
 * One end of the "+ Line" wizard: a site, then where at it (one of its yards, through take-offs, or its site junction,
 * created when missing), or a line junction. The value is the wizard's end key (`Y:` / `G:` / `J:`, see `LineDraft`).
 */
function LineEndField({label, value, other, onChange}: { label: string; value: string; other: string; onChange: (v: string) => void }) {
    const ed = useNetworkEditor()
    const doc = ed.doc
    const place = lineEndPlace(doc, value) ?? ''
    const site = doc.substationGroups.find(g => g.id === place)
    const otherPlace = lineEndPlace(doc, other)
    const placeOptions = [
        ...doc.substationGroups.filter(g => g.id !== otherPlace).map(g => ({value: `S:${g.id}`, label: `${g.groupName}${g.name && g.name !== g.groupName ? ` – ${g.name}` : ''}`})),
        ...doc.junctions.filter(j => !j.groupId && j.id !== otherPlace).map(j => ({value: `J:${j.id}`, label: `Junction ${j.name ?? j.id}`})),
    ].sort((a, b) => a.label.localeCompare(b.label))
    const yards = site ? doc.substations.filter(y => y.groupId === site.id).sort((a, b) => voltageKv(b.voltage) - voltageKv(a.voltage)) : []
    const siteJunction = site ? siteJunctionOf(doc, site.id) : undefined
    const otherYard = lineEndYardOf(doc, other)
    return (
        <div className="field">
            <label>{label}</label>
            <select value={site ? `S:${site.id}` : value.startsWith('J:') ? value : ''} onChange={e => {
                const v = e.target.value
                if (!v.startsWith('S:')) return onChange(v)
                // a site: a yard at the other end's voltage, else the highest, else its site junction
                const ys = doc.substations.filter(y => y.groupId === v.slice(2)).sort((a, b) => voltageKv(b.voltage) - voltageKv(a.voltage))
                const yard = ys.find(y => otherYard && y.voltage === otherYard.voltage) ?? ys[0]
                onChange(yard ? `Y:${yard.id}` : `G:${v.slice(2)}`)
            }}>
                <option value="">choose a site or junction…</option>
                {placeOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            {site && (
                <select value={value} onChange={e => onChange(e.target.value)} style={{marginTop: 4}}>
                    {yards.map(y => <option key={y.id} value={`Y:${y.id}`}>Yard {y.yardName} ({enumLabel(y.voltage)}): take-offs</option>)}
                    <option value={`G:${site.id}`}>Site junction {siteJunction ? siteJunction.name ?? siteJunction.id : '(created)'}: a node per circuit</option>
                </select>
            )}
        </div>
    )
}

/** Options for a line end (`encodeRef` values): every yard (`S:`), and every junction (`J:`), a site's own junction named after its site. */
function useLineEndOptions() {
    const doc = useNetworkEditor().doc
    const site = (id?: string) => id ? doc.substationGroups.find(g => g.id === id) : undefined
    const yards = doc.substations.map(y => ({value: `S:${y.id}`, label: `${site(y.groupId)?.groupName ?? '?'} ${y.yardName} (${y.voltage})`}))
    const junctions = doc.junctions.map(j => {
        const g = site(j.groupId)
        return {value: `J:${j.id}`, label: g ? `${g.groupName} site junction (${j.name ?? j.id})` : `Junction ${j.name ?? j.id}`}
    })
    return [...yards, ...junctions].sort((a, b) => a.label.localeCompare(b.label))
}

function LinePanel({meta, record, locate}: MapPanelsProps & { record: TransmissionLineRecord }) {
    const ed = useNetworkEditor()
    const doc = ed.doc
    const d = useDraft(record)
    const endOptions = useLineEndOptions()
    const graph = useMemo(() => buildCircuitGraph(doc), [doc])
    /** Id / name the model rules give this line as edited (`<kV>_<site>_<site>_L<n>`). */
    const auto = draftNaming(doc, 'lines', d.draft)
    const warnings = lineWarnings(doc, record, graph)
    /** The ends this line does not state, guessed from its sections (only those it would fill). */
    const guessed = (() => {
        if (record.from && record.to) return undefined
        const g = guessLineEnds(doc, record, graph)
        const out = {...(!record.from && g.from ? {from: g.from} : {}), ...(!record.to && g.to ? {to: g.to} : {})}
        return out.from || out.to ? out : undefined
    })()
    const candidates = lineExtensionCandidates(doc, record, graph).map(id => doc.circuits.find(c => c.id === id)).filter((c): c is TransmissionCircuitRecord => !!c)
    const [addId, setAddId] = useState('')
    const setSections = (circuitIds: string[]) => ed.apply([{type: 'upsert', collection: 'lines', record: {...record, circuitIds}}])
    const move = (i: number, to: number) => {
        if (to < 0 || to >= record.circuitIds.length) return
        const next = [...record.circuitIds]
        const [x] = next.splice(i, 1)
        next.splice(to, 0, x)
        setSections(next)
    }
    /** Exchanges the FROM and TO yards and reverses the sections; then offers to re-derive id and name (`<kV>_<from>_<to>_L<n>` reads the other way round). */
    const swapEnds = () => {
        const swapped: TransmissionLineRecord = {...record, from: record.to, to: record.from, circuitIds: [...record.circuitIds].reverse()}
        const ops: NetworkOp[] = [{type: 'upsert', collection: 'lines', record: swapped}]
        const after = applyOps(doc, ops)
        const plan = regenerateNamingOps(after, [{collection: 'lines', id: record.id}], {id: true, name: true})
        const change = plan.changes[0]
        let newId: string | undefined
        if (change && window.confirm(`Also regenerate the line's ${[change.newName !== undefined ? `name (→ ${change.newName})` : '', change.newId ? `id (→ ${change.newId})` : ''].filter(Boolean).join(' and ')} from the model rules?`)) {
            ops.push(...plan.ops)
            newId = change.newId
        }
        if (ed.apply(ops) && newId) ed.select({collection: 'lines', id: newId})
    }
    return (
        <>
            <div className="panel">
                <Header title={`Line ${record.name}`} rename={{collection: 'lines', id: record.id, auto: auto?.id}} onDelete={() => {
                    const ops = confirmDeleteLines(doc, [record.id])
                    if (ops && ed.apply(ops, {confirmedLineIds: [record.id]})) ed.select(null)
                }}/>
                {warnings.length > 0 && <Notice kind="warn">⚠ {warnings.join(', ')}</Notice>}
                {guessed && (
                    <div className="toolbar small" style={{marginBottom: 6}}>
                        <button type="button" className="small" disabled={d.dirty} title={d.dirty ? 'Apply or reset the edits first' : 'Set the ends this line does not state from its own sections'}
                                onClick={() => ed.apply([{type: 'upsert', collection: 'lines', record: {...record, ...guessed}}])}>Fill missing ends</button>
                        <span className="muted">from its sections: {[guessed.from ? `FROM ${refLabel(doc, guessed.from)}` : '', guessed.to ? `TO ${refLabel(doc, guessed.to)}` : ''].filter(Boolean).join(', ')}</span>
                    </div>
                )}
                <div className="form-grid" style={{gridTemplateColumns: '1fr 1fr'}}>
                    <TextField label="Name" value={d.draft.name} onChange={v => d.set('name', v)} className="span-all" hint={auto && auto.name !== d.draft.name ? `Rule name: ${auto.name}` : undefined}
                               action={{label: 'auto', title: auto ? `Use the rule name ${auto.name}` : 'Set the ends first', disabled: !auto || auto.name === d.draft.name, onClick: () => auto && d.set('name', auto.name)}}/>
                    <SelectField label="Voltage" value={d.draft.voltage} options={meta.enums.transmissionVoltage} allowEmpty onChange={v => d.set('voltage', v as TransmissionVoltage | undefined)} className="span-all"/>
                    <SelectField label="From" value={encodeRef(d.draft.from) || undefined} options={endOptions} allowEmpty onChange={v => d.set('from', v ? decodeRef(v) : undefined)} hint="A yard, a site junction or a line junction"/>
                    <SelectField label="To" value={encodeRef(d.draft.to) || undefined} options={endOptions} allowEmpty onChange={v => d.set('to', v ? decodeRef(v) : undefined)} hint="A junction end: the line stays open there or ties in"/>
                    <CheckboxField label="Planned (not built yet)" checked={!!d.draft.planned} onChange={v => d.set('planned', v || undefined)} className="span-all"/>
                </div>
                <ApplyBar dirty={d.dirty} onReset={d.reset} onApply={() => ed.apply([{type: 'upsert', collection: 'lines', record: d.draft}])}/>
                <div className="toolbar" style={{marginTop: 6}}>
                    <button type="button" className="small" onClick={swapEnds} disabled={d.dirty || (!record.from && !record.to && record.circuitIds.length < 2)}
                            title={d.dirty ? 'Apply or reset the edits first' : 'Exchange the FROM and TO ends and reverse the sections; asks whether to regenerate id and name'}>Swap from / to</button>
                </div>
            </div>
            <div className="panel">
                <div className="panel-header">
                    <h3 style={{margin: 0}}>Sections ({record.circuitIds.length})</h3>
                    <span className="spacer"/>
                    <button type="button" className="small" title="Order the sections by walking from the FROM yard" disabled={record.circuitIds.length < 2}
                            onClick={() => setSections(orderLineCircuits(doc, record, graph))}>Order along route</button>
                </div>
                {record.circuitIds.length === 0 && <p className="small muted">No sections yet. Add the circuits that form this line, from one yard to the other.</p>}
                {record.circuitIds.map((id, i) => {
                    const c = doc.circuits.find(x => x.id === id)
                    return (
                        <div key={id} className="toolbar small" style={{marginBottom: 4}}>
                            <span className="muted">{i + 1}.</span>
                            {c ? <>
                                <VoltageSwatch circuit={c}/>
                                <a href="#" onClick={e => {
                                    e.preventDefault()
                                    ed.select({collection: 'circuits', id: c.id})
                                    locate?.({collection: 'circuits', id: c.id})
                                }}><strong>{c.name}</strong></a>
                                <span className="muted">{refLabel(doc, circuitEndRef(doc, c.id, CIRCUIT_END_FROM))} → {refLabel(doc, circuitEndRef(doc, c.id, CIRCUIT_END_TO))} · <span title="Conductor (bundle × size unit type)">{conductorText(c)}</span></span>
                            </> : <span className="warn-dot">⚠ unknown circuit {id}</span>}
                            <span className="spacer" style={{flex: 1}}/>
                            <button type="button" className="small" disabled={i === 0} onClick={() => move(i, i - 1)} title="Move earlier">↑</button>
                            <button type="button" className="small" disabled={i === record.circuitIds.length - 1} onClick={() => move(i, i + 1)} title="Move later">↓</button>
                            <button type="button" className="small danger" onClick={() => setSections(record.circuitIds.filter(x => x !== id))} title="Remove from the line (the circuit is kept)">×</button>
                        </div>
                    )
                })}
                <div className="toolbar" style={{marginTop: 8}}>
                    <select value={addId} onChange={e => setAddId(e.target.value)}>
                        <option value="">{candidates.length ? (record.circuitIds.length ? 'circuit joined to an end…' : 'circuit…') : 'no circuit joins the ends'}</option>
                        {candidates.map(c => <option key={c.id} value={c.id}>{c.name} · {refLabel(doc, circuitEndRef(doc, c.id, CIRCUIT_END_FROM))} → {refLabel(doc, circuitEndRef(doc, c.id, CIRCUIT_END_TO))}</option>)}
                    </select>
                    <button type="button" className="small" disabled={!addId} onClick={() => {
                        // append at the end that the circuit joins; the walk from FROM puts it in place
                        setSections(orderLineCircuits(doc, {...record, circuitIds: [...record.circuitIds, addId]}, graph))
                        setAddId('')
                    }}>Add section</button>
                </div>
                <p className="small muted">Sections are circuits joined end to end through junction nodes. A circuit may be a section of several lines when they part at a tee.</p>
            </div>
        </>
    )
}

/* ---------- waypoint editing ---------- */

function WaypointPanel({tools}: { tools: WaypointTools }) {
    const ed = useNetworkEditor()
    const {state} = tools
    const route = ed.doc.paths.find(p => p.id === state.pathId)
    const path = route?.waypoints ?? []
    const users = route ? ed.doc.circuits.filter(c => c.pathId === route.id) : []
    const selected = state.selected !== null ? path[state.selected] : undefined
    const [coordsDraft, setCoordsDraft] = useState(selected ? coordsText(selected) : '')
    useEffect(() => setCoordsDraft(selected ? coordsText(selected) : ''), [selected])
    if (!route) return null
    const parsed = parseCoords(coordsDraft)
    const move = (from: number, to: number) => {
        if (to < 0 || to >= path.length) return
        const next = [...path]
        const [item] = next.splice(from, 1)
        next.splice(to, 0, item)
        if (tools.setPath(next)) tools.update({selected: to})
    }
    return (
        <>
            <div className="panel">
                <div className="panel-header">
                    <h3 style={{margin: 0}}>Path {route.name}</h3>
                    <span className="spacer"/>
                    <button type="button" className="small primary" onClick={tools.done}>Done</button>
                </div>
                <p className="small muted">{users.length ? `Route of ${users.map(c => c.name).join(', ')}${users.length > 1 ? ' (shared: edits move all of them)' : ''}. ` : 'No circuit uses this path yet. '}Drag a point on the map to move it, click a point to select it. To add a point, press one of the buttons and then click on the map.</p>
                {state.adding && (
                    <Notice kind="warn">Click on the map to place the new waypoint {state.adding === 'append' ? 'at the end of the route' : `${state.adding} point ${(state.selected ?? 0) + 1}`}.
                        {' '}<button type="button" className="small" onClick={() => tools.update({adding: null})}>Cancel</button></Notice>
                )}
                <div className="toolbar">
                    {path.length === 0 || state.selected === null ? (
                        <button type="button" className={`small ${state.adding === 'append' ? 'primary' : ''}`} onClick={() => tools.update({adding: 'append'})}>
                            {path.length === 0 ? 'New waypoint' : 'Add at end'}
                        </button>
                    ) : (
                        <>
                            <button type="button" className={`small ${state.adding === 'before' ? 'primary' : ''}`} onClick={() => tools.update({adding: 'before'})}>Add before</button>
                            <button type="button" className={`small ${state.adding === 'after' ? 'primary' : ''}`} onClick={() => tools.update({adding: 'after'})}>Add after</button>
                        </>
                    )}
                    <button type="button" className="small danger" onClick={tools.remove} disabled={state.selected === null}>Delete point</button>
                    <button type="button" className="small" onClick={() => tools.setPath([]) && tools.update({selected: null, adding: null})} disabled={path.length === 0}>Clear all</button>
                </div>
            </div>
            <div className="panel">
                <h3>Points ({path.length})</h3>
                {path.length === 0 && <p className="small muted">No waypoints: the circuit is drawn as a straight line between its ends.</p>}
                {path.length > 0 && (
                    <table>
                        <thead>
                        <tr>
                            <th>#</th>
                            <th>Latitude, longitude</th>
                            <th style={{width: 1}}/>
                        </tr>
                        </thead>
                        <tbody>
                        {path.map((p, i) => (
                            <tr key={i} onClick={() => tools.update({selected: i})} style={state.selected === i ? {outline: '2px solid var(--accent)'} : {cursor: 'pointer'}}>
                                <td>{i + 1}</td>
                                <td className="mono small">{coordsText(p)}</td>
                                <td className="toolbar" style={{flexWrap: 'nowrap'}}>
                                    <button type="button" className="small" disabled={i === 0} onClick={e => {
                                        e.stopPropagation()
                                        move(i, i - 1)
                                    }} title="Move earlier">↑</button>
                                    <button type="button" className="small" disabled={i === path.length - 1} onClick={e => {
                                        e.stopPropagation()
                                        move(i, i + 1)
                                    }} title="Move later">↓</button>
                                </td>
                            </tr>
                        ))}
                        </tbody>
                    </table>
                )}
                {selected && state.selected !== null && (
                    <div className="form-grid" style={{gridTemplateColumns: '1fr', marginTop: 10}}>
                        <TextField label={`Point ${state.selected + 1} coordinates`} value={coordsDraft} onChange={setCoordsDraft} mono error={parsed ? undefined : 'lat, lon expected'}/>
                        <div className="toolbar">
                            <button type="button" className="small primary" disabled={!parsed || coordsText(parsed) === coordsText(selected)}
                                    onClick={() => parsed && tools.setPath(path.map((p, i) => i === state.selected ? parsed : p))}>Apply coordinates</button>
                            <button type="button" className="small" onClick={() => tools.update({selected: null, adding: null})}>Deselect</button>
                        </div>
                    </div>
                )}
            </div>
        </>
    )
}

/* ---------- transmission connection (selected from elsewhere) ---------- */

/**
 * "Join" for a node at a junction holding exactly two circuit ends: merges
 * the two circuits (and their paths) into one, asking first whether to run
 * the joined circuit on a path that already exists between its ends.
 */
function JoinCircuitsButton({connection, locate}: { connection: ConnectionRecord; locate?: (sel: Selection) => void }) {
    const ed = useNetworkEditor()
    const reason = joinableReason(ed.doc, connection)
    if (connection.junction.kind !== ConnectionJunctionKind.TRANSMISSION_JUNCTION || connection.nodes.length !== 2) return null
    const join = () => {
        let plan = buildJoinCircuitsPlan(ed.doc, connection.id)
        if (plan.errors.length) return window.alert(plan.errors.join('\n'))
        if (plan.existingPaths.length) {
            const names = plan.existingPaths.map(p => `"${p.name}"`).join(', ')
            if (window.confirm(`A path already runs between the joined ends: ${names}.\n\nOK = run the joined circuit on ${plan.existingPaths.length === 1 ? 'it' : `the first one (${plan.existingPaths[0].name})`}; Cancel = keep its own route (${plan.path?.extended ? 'extended' : 'merged'} path).`)) {
                plan = buildJoinCircuitsPlan(ed.doc, connection.id, {reusePathId: plan.existingPaths[0].id})
                if (plan.errors.length) return window.alert(plan.errors.join('\n'))
            }
        }
        const summary = [
            `Join ${plan.merged?.name} and ${plan.removed?.name} into one circuit (${plan.merged?.name}) on path "${plan.path?.name}"${plan.path?.reused ? ' (existing)' : plan.path?.extended ? ' (extended)' : ' (new)'}.`,
            plan.removedPaths.length ? `Removes path(s) ${plan.removedPaths.map(p => p.name).join(', ')}.` : '',
            plan.junctionRemoved ? 'The junction has nothing left and is removed too.' : '',
            plan.lines.length ? `${plan.lines.length} line(s) re-sequenced.` : '',
            ...plan.warnings.map(w => `⚠ ${w}`),
        ].filter(Boolean).join('\n')
        if (!window.confirm(`${summary}\n\nContinue?`)) return
        const ops = [...plan.ops]
        if (plan.regenerate.changes.length && window.confirm(`Also rename the joined circuit and its path by the model rules (${plan.regenerate.changes.length} change(s))?`)) ops.push(...plan.regenerate.ops)
        if (ed.apply(ops) && plan.merged) {
            ed.select({collection: 'circuits', id: plan.merged.id})
            locate?.({collection: 'circuits', id: plan.merged.id})
        }
    }
    return <button type="button" className="small" disabled={!!reason} onClick={join} title={reason ?? 'Merge the two circuits spliced here into one circuit on one path (the reverse of a split)'}>Join</button>
}

/** The planned flag of the connection a circuit end is attached at (a yard take-off's node or a junction's), set right away. */
function EndPlannedToggle({circuitId, end}: { circuitId: string; end: CircuitEnd }) {
    const ed = useNetworkEditor()
    const conn = circuitEndConnection(ed.doc, circuitId, end)
    if (!conn) return null
    return (
        <label className="small" title={`Connection ${conn.name ?? conn.id} planned (not built yet): a built circuit joined there gets a warning`} style={{display: 'inline-flex', gap: 4, alignItems: 'center'}}>
            <input type="checkbox" checked={!!conn.planned} onChange={e => ed.apply([{type: 'upsert', collection: 'connections', record: {...conn, planned: e.target.checked || undefined}}])}/> planned
        </label>
    )
}

function TransmissionConnectionPanel({record}: { record: ConnectionRecord }) {
    const ed = useNetworkEditor()
    return (
        <div className="panel">
            <Header title="Connection" rename={{collection: 'connections', id: record.id}} onDelete={() => {
                ed.apply([{type: 'delete', collection: 'connections', id: record.id}])
                ed.select(null)
            }}/>
            {record.junction.kind === ConnectionJunctionKind.TRANSMISSION_JUNCTION && record.nodes.length === 2 && (
                <div className="toolbar" style={{marginBottom: 6}}>
                    <span className="small muted">Two circuit ends spliced here:</span>
                    <JoinCircuitsButton connection={record}/>
                </div>
            )}
            <p className="small muted">{record.scope} · at {record.junction.kind === ConnectionJunctionKind.SUBSTATION ? 'substation' : 'junction'} {record.junction.id}</p>
            <CheckboxField label="Planned (not built yet): a built circuit joined here gets a warning" checked={!!record.planned} onChange={v => ed.apply([{type: 'upsert', collection: 'connections', record: {...record, planned: v || undefined}}])}/>
            <ul className="small" style={{paddingLeft: 18}}>
                {record.nodes.map(n => <li key={`${n.kind}:${n.id}:${n.terminal}`}>{describeNode(ed.doc, n)}</li>)}
            </ul>
        </div>
    )
}

/* ---------- circuit creation wizard ---------- */

/** Per end of the new circuit: how it connects (`NewCircuitConnect`; unset = the default) and the new connection's name / id. */
interface CircuitEndChoice {
    connect?: NewCircuitConnect
    connectionName: string
    connectionId: string
}

const EMPTY_END_CHOICE: CircuitEndChoice = {connectionName: '', connectionId: ''}

/**
 * "+ Circuit" wizard (`buildNewCircuitPlan`): the two ends are picked here or by clicking sites and junctions on the map
 * (`CircuitDraft`; a right-click takes one out). Each end then connects: at a site through a free take-off of any yard,
 * a new take-off or the site junction (created when missing); at a junction by joining a node or starting one of its
 * own. The circuit fields, the path (an existing one between the places by default) and the energized voltage (the
 * connections' unless picked) follow, with warnings for ends at different voltages, open ends and energized ≠ rated.
 * One journaled step creates everything; the new circuit is selected.
 */
function NewCircuitWizard({meta, draft, setDraft, setMode, locate}: MapPanelsProps) {
    const ed = useNetworkEditor()
    const doc = ed.doc
    const {templates} = useTemplates(TemplateKind.TRANSMISSION_CIRCUIT)
    /** Choices per place (`G:` / `J:` key): they follow an end when the ends are swapped; a newly picked place starts fresh. */
    const [choices, setChoices] = useState<Record<string, CircuitEndChoice>>({})
    const choiceAt = (place: string) => choices[place] ?? EMPTY_END_CHOICE
    const setChoice = (place: string, patch: Partial<CircuitEndChoice>) => setChoices(c => ({...c, [place]: {...(c[place] ?? EMPTY_END_CHOICE), ...patch}}))
    const [name, setName] = useState('')
    const [circuitId, setCircuitId] = useState('')
    const [templateId, setTemplateId] = useState<string | undefined>()
    const [voltage, setVoltage] = useState<string | undefined>()
    const [bundle, setBundle] = useState<number | undefined>()
    const [conductor, setConductor] = useState<TransmissionConductor | undefined>(genericConductor)
    const [lengthKm, setLengthKm] = useState<number | undefined>()
    const [lengthTouched, setLengthTouched] = useState(false)
    /** An existing path's id, NEW_PATH, or unset = the best path between the places when there is one. */
    const [pathPick, setPathPick] = useState<string | undefined>()
    const [pathName, setPathName] = useState('')
    const [newPathId, setNewPathId] = useState('')
    /** Energized voltage; unset = the connections' at the ends. */
    const [energized, setEnergized] = useState<string | undefined>()

    const fromSpec = {place: draft.from, ...choiceAt(draft.from)}, toSpec = {place: draft.to, ...choiceAt(draft.to)}
    /** The rated voltage used while none is picked (from the ends' connections). */
    const suggestedVoltage = suggestedCircuitVoltage(doc, fromSpec, toSpec)
    const spec: NewCircuitSpec = {
        from: fromSpec, to: toSpec,
        name, id: circuitId, voltage: (voltage as TransmissionVoltage | undefined) ?? suggestedVoltage, bundle, conductor, lengthKm,
        pathId: pathPick && pathPick !== NEW_PATH ? pathPick : undefined, newPath: pathPick === NEW_PATH, newPathName: pathName, newPathId,
        energizedVoltage: energized as TransmissionVoltage | undefined,
    }
    const plan = buildNewCircuitPlan(doc, spec)
    const km = plan.km
    // Pre-fill the length with the straight-line distance until the user edits it.
    useEffect(() => {
        if (!lengthTouched) setLengthKm(km)
    }, [km, lengthTouched])

    const pickTemplate = async (id: string | undefined) => {
        setTemplateId(id)
        if (!id) return
        try {
            const t = await api.templates.get(TemplateKind.TRANSMISSION_CIRCUIT, id)
            const data = t.data as TransmissionCircuitTemplateData
            setVoltage(data.voltage)
            setBundle(data.bundle)
            void loadConductor(data.conductorId, setConductor)
        } catch (e) {
            window.alert((e as Error).message)
        }
    }

    const create = () => {
        if (plan.errors.length || !plan.circuit) return
        if (!ed.apply(plan.ops)) return
        const sel: Selection = {collection: 'circuits', id: plan.circuit.id}
        setMode('select')
        ed.select(sel)
        locate?.(sel)
    }

    const bothEnds = !!draft.from && !!draft.to
    const problems = plan.errors.filter(e => !e.startsWith('pick where'))
    const newPath = bothEnds && (plan.pathChoices.length === 0 || pathPick === NEW_PATH)
    /** Marks a voltage option with the ends / rating it matches, so the take-off voltage is easy to pick. */
    const voltageOptions = meta.enums.transmissionVoltage.map(v => ({
        value: v,
        label: [enumLabel(v), plan.from.voltage === v ? 'FROM end' : '', plan.to.voltage === v ? 'TO end' : '', spec.voltage === v ? 'rated' : ''].filter(Boolean).join(' · '),
    }))
    const creates = [
        ...[plan.from, plan.to].flatMap(e => [e.junctionCreated && e.junction ? `site junction ${e.junction.name ?? e.junction.id}` : '', e.takeOffCreated && e.takeOff ? `take-off ${e.takeOff.lineName} (${e.yard?.yardName ?? ''})` : '']),
        plan.pathCreated && plan.path ? `path ${plan.path.name}` : '',
    ].filter(Boolean)

    return (
        <div className="panel">
            <div className="panel-header">
                <h3 style={{margin: 0}}>New circuit</h3>
                <span className="spacer"/>
                <button type="button" className="small" onClick={() => setMode('select')}>Cancel</button>
            </div>
            <p className="small muted">Pick the two ends here, or click on the map the site or junction where the circuit starts, then the one where it ends (right-click one to take it out again). At a site the circuit leaves through a take-off (a free one of any yard, or a new one) or ends at the site junction; at a junction it joins a node or starts one of its own. Everything is created in one step.</p>
            <div className="form-grid" style={{gridTemplateColumns: '1fr'}}>
                <CircuitEndField label="From" place={draft.from} other={draft.to} end={plan.from} choice={choiceAt(draft.from)}
                                 setPlace={v => setDraft({...draft, from: v})} setChoice={p => setChoice(draft.from, p)}/>
                <CircuitEndField label="To" place={draft.to} other={draft.from} end={plan.to} choice={choiceAt(draft.to)}
                                 setPlace={v => setDraft({...draft, to: v})} setChoice={p => setChoice(draft.to, p)}/>
                <div className="toolbar small">
                    <button type="button" className="small" disabled={!draft.from && !draft.to} onClick={() => setDraft({from: draft.to, to: draft.from})} title="Exchange the FROM and TO ends (with their take-off / node choices)">Swap from / to</button>
                    {km !== undefined && <span className="muted">{km.toFixed(1)} km in a straight line</span>}
                </div>
            </div>
            <h4 className="muted" style={{marginTop: 12}}>Circuit</h4>
            <div className="form-grid" style={{gridTemplateColumns: '1fr 1fr'}}>
                <TextField label="Name" value={name} onChange={setName} placeholder={plan.autoCircuit?.name ?? 'from the voltage and the path'} hint="Left empty: the rule name (<kV>_<path>_S<n>)" className="span-all"/>
                <NewIdField value={circuitId} onChange={setCircuitId} auto={plan.autoCircuit ? uniqueId(doc, plan.autoCircuit.id) : undefined} className="span-all"/>
                <SelectField label="Template" value={templateId} options={templates.map(t => ({value: t.id, label: t.name}))} allowEmpty onChange={v => void pickTemplate(v)} className="span-all"
                             hint={templates.length ? 'Fills voltage, bundle and conductor' : 'No circuit templates yet'}/>
                <SelectField label="Voltage (rated)" value={voltage} options={meta.enums.transmissionVoltage} allowEmpty emptyLabel={`from the ends (${suggestedVoltage ? enumLabel(suggestedVoltage) : '–'})`} onChange={setVoltage}/>
                <NumberField label="Bundle" value={bundle} min={1} step={1} onChange={setBundle}/>
                <ConductorFields meta={meta} value={conductor} onChange={setConductor}/>
                <NumberField label="Length (km)" value={lengthKm} min={0} onChange={v => {
                    setLengthTouched(true)
                    setLengthKm(v)
                }} hint={km !== undefined ? `straight line ${km} km` : undefined}/>
                <SelectField label="Energized voltage" value={energized} options={voltageOptions} allowEmpty emptyLabel={`the connections' (${plan.autoEnergized ? enumLabel(plan.autoEnergized) : 'unknown'})`} onChange={setEnergized}
                             hint="Empty: the voltage of the take-off / node at the FROM end (else the TO end); pick the other end's take-off voltage, or 0V for a circuit not in service"/>
                {bothEnds && plan.pathChoices.length > 0 && (
                    <SelectField label="Transmission path" className="span-all" value={plan.pathCreated ? NEW_PATH : plan.path?.id ?? (pathPick || undefined)}
                                 options={[
                                     ...plan.pathChoices.map(p => ({value: p.id, label: `${p.name} · ${refLabel(doc, p.from)} → ${refLabel(doc, p.to)} (${doc.circuits.filter(c => c.pathId === p.id).length} circuits, ${p.waypoints.length} pts)`})),
                                     {value: NEW_PATH, label: 'New path (no reuse)'},
                                 ]}
                                 onChange={v => setPathPick(v)}
                                 hint={plan.reversed && plan.path ? `${plan.path.name} runs the other way: the circuit follows it, FROM and TO swapped` : 'A path already runs between the two places: the circuit shares it unless a new one is picked'}/>
                )}
                {newPath && <TextField label="New path name" value={pathName} onChange={setPathName} placeholder={plan.autoPath?.name} className="span-all"/>}
                {newPath && <NewIdField label="New path id" value={newPathId} onChange={setNewPathId} auto={plan.autoPath ? uniqueId(doc, plan.autoPath.id) : undefined} className="span-all"/>}
            </div>
            {problems.length > 0 && <Notice kind="error">{problems.join('. ')}.</Notice>}
            {plan.warnings.length > 0 && (
                <Notice kind="warn">
                    <ul style={{margin: 0, paddingLeft: 16}}>{plan.warnings.map(w => <li key={w}>⚠ {w}</li>)}</ul>
                </Notice>
            )}
            <div className="toolbar" style={{marginTop: 10}}>
                <button type="button" className="primary small" disabled={plan.errors.length > 0 || !plan.circuit} onClick={create}>Create circuit</button>
                {creates.length > 0 && <span className="small muted">also creates {creates.join(', ')}</span>}
            </div>
        </div>
    )
}

/**
 * One end of the new circuit: the place (a site or a line junction; × takes it out, as a right-click on the map does),
 * then at a site how it connects (a free take-off of any yard, a new take-off with its line name, or the site junction)
 * and at a junction which node it joins (or a node of its own: an open end), with the new connection's name / id.
 */
function CircuitEndField({label, place, other, end, choice, setPlace, setChoice}: {
    label: string
    place: string
    other: string
    end: NewCircuitEndPlan
    choice: CircuitEndChoice
    setPlace: (v: string) => void
    setChoice: (p: Partial<CircuitEndChoice>) => void
}) {
    const ed = useNetworkEditor()
    const doc = ed.doc
    const options = circuitPlaceOptions(doc).filter(o => o.value !== other)
    const site = place.startsWith('G:') ? doc.substationGroups.find(g => g.id === place.slice(2)) : undefined
    const yards = site ? yardsOf(doc, site.id) : []
    const siteJunction = site ? siteJunctionOf(doc, site.id) : undefined
    const connect = end.connect
    const connectValue = !connect ? '' : connect.kind === 'takeOff' ? `T:${connect.takeOffId}` : connect.kind === 'newTakeOff' ? `N:${connect.yardId}` : 'J'
    const nodes = end.junction ? connectionsAtJunction(doc, end.junction.id) : []
    return (
        <div className="field">
            <label>{label}</label>
            <div style={{display: 'flex', gap: 4}}>
                <select value={place} onChange={e => setPlace(e.target.value)} style={{flex: 1, minWidth: 0}}>
                    <option value="">Click on the map, or choose a site or junction…</option>
                    {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                {place && <button type="button" className="small" title="Take this end out again (or right-click it on the map)" onClick={() => setPlace('')}>×</button>}
            </div>
            {site && (
                <select value={connectValue} style={{marginTop: 4}} onChange={e => {
                    const v = e.target.value
                    setChoice({connect: v.startsWith('T:') ? {kind: 'takeOff', takeOffId: v.slice(2)} : v.startsWith('N:') ? {kind: 'newTakeOff', yardId: v.slice(2)} : {kind: 'junction'}})
                }}>
                    {yards.map(y => (
                        <optgroup key={y.id} label={`Yard ${y.yardName} (${enumLabel(y.voltage)})`}>
                            {freeTakeOffs(doc, y.id).map(t => <option key={t.id} value={`T:${t.id}`}>Free take-off {t.lineName}{t.voltage && t.voltage !== y.voltage ? ` (${enumLabel(t.voltage)})` : ''}</option>)}
                            <option value={`N:${y.id}`}>New take-off in yard {y.yardName}</option>
                        </optgroup>
                    ))}
                    <option value="J">Site junction {siteJunction ? siteJunction.name ?? siteJunction.id : '(created)'}: no yard</option>
                </select>
            )}
            {connect?.kind === 'newTakeOff' && (
                <input type="text" value={connect.lineName ?? ''} placeholder={`take-off line name (${end.takeOff?.lineName ?? 'rule name'})`} style={{marginTop: 4}}
                       onChange={e => setChoice({connect: {...connect, lineName: e.target.value.toUpperCase()}})}/>
            )}
            {connect?.kind === 'junction' && end.junction && (
                <select value={connect.connectionId ?? ''} style={{marginTop: 4}} onChange={e => setChoice({connect: {kind: 'junction', connectionId: e.target.value || undefined}})}>
                    <option value="">A node of its own (open end)</option>
                    {nodes.map(n => <option key={n.id} value={n.id}>Join node {n.name ?? n.id} ({n.nodes.length} end{n.nodes.length === 1 ? '' : 's'}{n.voltage ? ` · ${enumLabel(n.voltage)}` : ''})</option>)}
                </select>
            )}
            {end.ref && !end.node && (
                <div className="toolbar small" style={{marginTop: 4}}>
                    <span className="muted">{end.takeOff ? 'new connection' : 'new node'}</span>
                    <input type="text" value={choice.connectionName} placeholder="name (optional)" style={{width: 130}} onChange={e => setChoice({connectionName: e.target.value})}/>
                    <NewIdField compact value={choice.connectionId} onChange={v => setChoice({connectionId: v})}/>
                </div>
            )}
            {end.ref && <span className="hint">{end.label}{end.voltage ? ` · at ${enumLabel(end.voltage)}` : ''}</span>}
        </div>
    )
}
