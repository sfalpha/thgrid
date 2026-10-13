/** Map helpers shared by the Leaflet editor and its side panels (no Leaflet dependency). */
import {atPathEnd, junctionRef} from '@shared/network/refs'
import type {CoordinatesProps} from '@shared/models/coordinates'
import {CircuitEnd, ConnectionJunctionKind, ConnectionJunctionRef, ConnectionScope, GenerationUnitRecord, NetworkDocument, NetworkNodeKind} from '@shared/network/records'

export type Mode = 'select' | 'addSite' | 'addJunction' | 'addPath' | 'addCircuit' | 'addLine' | 'editWaypoints' | 'splitPath'

/** Values for the next site / junction created by a map click (edited in the side panel). */
export interface CreateDraft {
    /** Split mode: split at this existing junction instead of creating one with the next click. */
    existingJunctionId?: string
    id: string
    code: string
    name: string
}

/** State of the waypoint editor (mode `editWaypoints`) shared by the map and its panel. */
export interface WaypointEdit {
    pathId: string
    /** Index into `circuit.path` of the selected waypoint. */
    selected: number | null
    /** Armed insert: the next map click adds a waypoint before/after the selected one or appends at the end. */
    adding: 'before' | 'after' | 'append' | null
}

/**
 * The "+ Circuit" wizard's ends, shared with map clicks: `G:<site id>` or `J:<junction id>` ('' = not chosen yet);
 * how each end connects there (take-off, site junction, node) is chosen in the panel.
 */
export interface CircuitDraft {
    from: string
    to: string
}

export const EMPTY_CIRCUIT_DRAFT: CircuitDraft = {from: '', to: ''}

/**
 * The stops of the "+ Line" wizard, shared by its panel and map clicks: the two ends (`Y:<yard id>`, `J:<junction id>`
 * or `G:<site id>` = the site's junction, created when missing; '' = not chosen yet), the stops in between in order
 * (`J:<junction id>`, or `G:<site id>` passed through its site junction; '' = a panel row not chosen yet) and the voltage.
 */
export interface LineDraft {
    from: string
    to: string
    vias: string[]
    voltage?: string
}

export const EMPTY_LINE_DRAFT: LineDraft = {from: '', to: '', vias: []}

/** Most stops in between the wizard takes. */
export const LINE_MAX_VIAS = 8

/** The yard of a line end (`Y:<yard id>`), if it is one. */
export const lineEndYardOf = (doc: NetworkDocument, end: string) => end.startsWith('Y:') ? doc.substations.find(s => s.id === end.slice(2)) : undefined

/** The site (`G:` or a yard's) or junction (`J:`) id a line end stands at, for highlighting and matching clicks. */
export function lineEndPlace(doc: NetworkDocument, end: string): string | undefined {
    if (!end) return undefined
    return end.startsWith('Y:') ? lineEndYardOf(doc, end)?.groupId : end.slice(2)
}

/** The yard a site click picks for a line end: at the other end's voltage, else at the line's voltage, else the highest one. */
function lineEndYard(doc: NetworkDocument, groupId: string, d: LineDraft): string | undefined {
    const yards = doc.substations.filter(s => s.groupId === groupId)
    const other = lineEndYardOf(doc, d.from) ?? lineEndYardOf(doc, d.to)
    return (yards.find(y => other && y.voltage === other.voltage) ?? yards.find(y => d.voltage && y.voltage === d.voltage)
        ?? [...yards].sort((a, b) => voltageKv(b.voltage) - voltageKv(a.voltage))[0])?.id
}

/** The sites and junctions a line draft uses, for highlighting them on the map. */
export function lineDraftPlaces(doc: NetworkDocument, d: LineDraft): string[] {
    return [lineEndPlace(doc, d.from), lineEndPlace(doc, d.to), ...d.vias.filter(Boolean).map(v => v.slice(2))].filter((x): x is string => !!x)
}

/**
 * A site clicked in "+ Line" mode: the first site sets the FROM end, the next the TO end (a yard, see `lineEndYard`; the
 * site's junction when it has no yards), any further one is passed in between (through its site junction). A site
 * already on the line is ignored.
 */
export function lineDraftSiteClick(doc: NetworkDocument, d: LineDraft, groupId: string): { draft?: LineDraft; error?: string } {
    if (lineDraftPlaces(doc, d).includes(groupId)) return {}
    if (!d.from || !d.to) {
        const yardId = lineEndYard(doc, groupId, d)
        const end = yardId ? `Y:${yardId}` : `G:${groupId}`
        return {draft: !d.from ? {...d, from: end} : {...d, to: end}}
    }
    if (d.vias.filter(Boolean).length >= LINE_MAX_VIAS) return {error: `At most ${LINE_MAX_VIAS} stops in between.`}
    return {draft: {...d, vias: [...d.vias.filter(Boolean), `G:${groupId}`]}}
}

/** A junction clicked in "+ Line" mode: like a site, the FROM end, then the TO end, then passed next after the stops chosen so far. */
export function lineDraftJunctionClick(d: LineDraft, junctionId: string): { draft?: LineDraft; error?: string } {
    const key = `J:${junctionId}`
    if (d.from === key || d.to === key || d.vias.includes(key)) return {}
    if (!d.from) return {draft: {...d, from: key}}
    if (!d.to) return {draft: {...d, to: key}}
    if (d.vias.filter(Boolean).length >= LINE_MAX_VIAS) return {error: `At most ${LINE_MAX_VIAS} stops in between.`}
    return {draft: {...d, vias: [...d.vias.filter(Boolean), key]}}
}

/** A site or junction right-clicked in "+ Line" mode: taken out of the line again (an end, or a stop in between). */
export function lineDraftRemove(doc: NetworkDocument, d: LineDraft, place: { groupId?: string; junctionId?: string }): LineDraft {
    const id = place.groupId ?? place.junctionId
    if (id && lineEndPlace(doc, d.from) === id) return {...d, from: ''}
    if (id && lineEndPlace(doc, d.to) === id) return {...d, to: ''}
    return {...d, vias: d.vias.filter(v => v !== (place.groupId ? `G:${place.groupId}` : `J:${place.junctionId}`))}
}

/**
 * The "+ Path" panel's draft, shared with map clicks: the ends (`G:<site id>` or `J:<junction id>`; '' = not chosen
 * yet) and the optional name and id (the rule ones when empty).
 */
export interface PathDraft {
    from: string
    to: string
    name: string
    id: string
}

export const EMPTY_PATH_DRAFT: PathDraft = {from: '', to: '', name: '', id: ''}

/**
 * A site (`G:<id>`) or junction (`J:<id>`) clicked in "+ Path" or "+ Circuit" mode: it fills the FROM end, else the
 * TO end; an end already picked, or a third place, is ignored.
 */
export function pickDraftEnd<D extends { from: string; to: string }>(d: D, place: string): D {
    if (d.from === place || d.to === place) return d
    if (!d.from) return {...d, from: place}
    if (!d.to) return {...d, to: place}
    return d
}

/** A site or junction right-clicked in "+ Path" or "+ Circuit" mode: taken out again when it is an end. */
export function dropDraftEnd<D extends { from: string; to: string }>(d: D, place: string): D {
    return d.from === place ? {...d, from: ''} : d.to === place ? {...d, to: ''} : d
}

/** Where a circuit end is located on the map, following its TRANSMISSION connection. */
export function endLocation(doc: NetworkDocument, circuitId: string, end: CircuitEnd): { coords: CoordinatesProps; label: string; connectionId: string } | undefined {
    const conn = doc.connections.find(c => c.scope === ConnectionScope.TRANSMISSION && c.nodes.some(n => n.kind === NetworkNodeKind.TRANSMISSION_CIRCUIT && n.id === circuitId && n.terminal === end))
    if (!conn) return undefined
    if (conn.junction.kind === ConnectionJunctionKind.SUBSTATION) {
        const yard = doc.substations.find(s => s.id === conn.junction.id)
        const group = yard && doc.substationGroups.find(g => g.id === yard.groupId)
        if (!group) return undefined
        const takeOffNode = conn.nodes.find(n => n.kind === NetworkNodeKind.SUBSTATION_TAKE_OFF)
        const takeOff = takeOffNode && doc.takeOffs.find(t => t.id === takeOffNode.id)
        return {coords: group.coords, label: `${group.groupName} ${yard!.yardName}${takeOff ? ` · ${takeOff.lineName}` : ''}`, connectionId: conn.id}
    }
    const j = doc.junctions.find(x => x.id === conn.junction.id)
    return j ? {coords: j.coords, label: j.name ?? j.id, connectionId: conn.id} : undefined
}

/** EGAT voltage colour scheme, shared by map lines, badges and the single-line diagram. */
export const VOLTAGE_COLORS: Record<string, string> = {
    AC500KV: '#8e44ad', // purple
    AC230KV: '#d62828', // red
    AC115KV: '#2e9e4f', // green
    AC69KV: '#1f6feb',  // blue
    AC33KV: '#c8651b',  // darker orange
    AC22KV: '#f39c2b',  // orange
    '0V': '#1b1b1b',    // black: de-energized
}
export const OTHER_VOLTAGE_COLOR = '#6e7781'
/** Colour of planned (not yet built) site markers and of planned yards / take-offs in the single-line diagram: grey, whatever the voltage. */
export const PLANNED_COLOR = '#9aa4ad'
/** Share of the voltage colour in `plannedVoltageColor`; the rest is `PLANNED_COLOR`. */
const PLANNED_VOLTAGE_SHARE = .55

/** Map position and label of a site, yard or junction reference (a path end). */
export function locationOfRef(doc: NetworkDocument, ref?: ConnectionJunctionRef): { coords: CoordinatesProps; label: string } | undefined {
    if (!ref) return undefined
    if (ref.kind === ConnectionJunctionKind.SUBSTATION_GROUP) {
        const group = doc.substationGroups.find(g => g.id === ref.id)
        return group ? {coords: group.coords, label: group.groupName} : undefined
    }
    if (ref.kind === ConnectionJunctionKind.SUBSTATION) {
        const yard = doc.substations.find(s => s.id === ref.id)
        const group = yard && doc.substationGroups.find(g => g.id === yard.groupId)
        return group ? {coords: group.coords, label: `${group.groupName} ${yard!.yardName}`} : undefined
    }
    const j = doc.junctions.find(x => x.id === ref.id)
    return j ? {coords: j.coords, label: j.name ?? j.id} : undefined
}

/** Size class of a site on the map, from what is inside it. */
export type SiteSize = 'small' | 'medium' | 'large' | 'xlarge'

/** Order of the size classes; a bigger site keeps its label when a smaller one is drawn too close. */
export const SITE_SIZE_RANK: Record<SiteSize, number> = {small: 0, medium: 1, large: 2, xlarge: 3}

/**
 * Marker diameter in px per size class at full detail (zoom ≥ `FULL_DETAIL_ZOOM`); scaled by `mapDetailScale` when
 * zoomed out. The map draws a site at least wide enough to cover the ends of the parallel lanes running into it.
 */
export const SITE_MARKER_PX: Record<SiteSize, number> = {small: 14, medium: 18, large: 24, xlarge: 30}

/** Smallest site marker diameter (px), whatever the zoom. */
export const SITE_MARKER_MIN_PX = 6

/** Zoom level from which sites and parallel lanes are drawn at full size. */
export const FULL_DETAIL_ZOOM = 11

/**
 * Share of the full site marker size and lane spacing drawn at a zoom level: 0.35 at the country view (zoom 6 and
 * out), growing linearly to 1 at `FULL_DETAIL_ZOOM`.
 */
export function mapDetailScale(zoom: number): number {
    return Math.min(1, Math.max(0.35, 0.35 + (zoom - 6) * (0.65 / (FULL_DETAIL_ZOOM - 6))))
}

/**
 * Classifies a site by its take-offs and bays (over all its yards):
 * more than 6 / 12 / 24 take-offs or more than 4 / 8 / 16 bays make it
 * medium / large / x-large; everything else is small.
 */
export function siteSize(doc: NetworkDocument, groupId: string): { size: SiteSize; takeOffs: number; bays: number } {
    const yardIds = new Set(doc.substations.filter(s => s.groupId === groupId).map(s => s.id))
    const takeOffs = doc.takeOffs.filter(t => yardIds.has(t.substationId)).length
    const bays = doc.bays.filter(b => yardIds.has(b.substationId)).length
    const size: SiteSize = takeOffs > 24 || bays > 16 ? 'xlarge' : takeOffs > 12 || bays > 8 ? 'large' : takeOffs > 6 || bays > 4 ? 'medium' : 'small'
    return {size, takeOffs, bays}
}

/**
 * Classifies a junction like a site, by the path ending there that carries
 * the most circuits: more than 2 circuits makes it medium, more than 4 large,
 * more than 6 x-large; everything else is small, like the site rule. Shown in the hover summary (the junction symbol has one size).
 */
export function junctionSize(doc: NetworkDocument, junctionId: string): { size: SiteSize; circuits: number } {
    const me = junctionRef(junctionId)
    const perPath = new Map<string, number>()
    for (const c of doc.circuits) if (c.pathId) perPath.set(c.pathId, (perPath.get(c.pathId) ?? 0) + 1)
    const circuits = doc.paths.filter(p => atPathEnd(doc, me, p.from) || atPathEnd(doc, me, p.to))
        .reduce((n, p) => Math.max(n, perPath.get(p.id) ?? 0), 0)
    const size: SiteSize = circuits > 6 ? 'xlarge' : circuits > 4 ? 'large' : circuits > 2 ? 'medium' : 'small'
    return {size, circuits}
}

export function voltageColor(voltage?: string): string {
    return (voltage && VOLTAGE_COLORS[voltage]) || OTHER_VOLTAGE_COLOR
}

/**
 * Dull version of the voltage colour for planned (not yet built) yard badges
 * and circuits on the map: the voltage colour mixed toward `PLANNED_COLOR`, so
 * the voltage still reads but the record looks unbuilt.
 */
export function plannedVoltageColor(voltage?: string): string {
    const rgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))
    const v = rgb(voltageColor(voltage)), g = rgb(PLANNED_COLOR)
    return '#' + v.map((c, i) => Math.round(c * PLANNED_VOLTAGE_SHARE + g[i] * (1 - PLANNED_VOLTAGE_SHARE)).toString(16).padStart(2, '0')).join('')
}

/** Nominal voltage in kV of a voltage code (`AC230KV` → 230, `AC400V` → 0.4); 0 when unknown or de-energized (`0V`). Used to list yards highest voltage first. */
export function voltageKv(voltage?: string): number {
    const m = /(\d+(?:\.\d+)?)(K?)V$/i.exec(voltage ?? '')
    return m ? Number(m[1]) / (m[2] ? 1 : 1000) : 0
}

/** One SVG element of a yard symbol, in a 12 × 12 view box. */
export interface VoltageSymbolShape {
    tag: 'polygon' | 'rect' | 'circle'
    attrs: Record<string, string | number>
}

/**
 * Shape of a yard's voltage symbol on the map and in the site / yard lists:
 * ▼ 69 kV, ▲ 115 kV, ■ 230 kV, a hexagon for 500 kV and a solid circle for
 * any other voltage. Filled with the voltage colour (`voltageSymbolSvg`).
 */
export function voltageSymbolShape(voltage?: string): VoltageSymbolShape {
    switch (voltage) {
        case 'AC69KV':
            return {tag: 'polygon', attrs: {points: '0.4,1.2 11.6,1.2 6,11.2'}}
        case 'AC115KV':
            return {tag: 'polygon', attrs: {points: '6,0.8 11.6,10.8 0.4,10.8'}}
        case 'AC230KV':
            return {tag: 'rect', attrs: {x: 1.25, y: 1.25, width: 9.5, height: 9.5}}
        case 'AC500KV':
            return {tag: 'polygon', attrs: {points: '6,0.5 10.76,3.25 10.76,8.75 6,11.5 1.24,8.75 1.24,3.25'}}
        default:
            return {tag: 'circle', attrs: {cx: 6, cy: 6, r: 5}}
    }
}

/** Fill of a yard symbol: the voltage colour, dulled when planned. */
export const voltageSymbolColor = (voltage?: string, planned?: boolean) => planned ? plannedVoltageColor(voltage) : voltageColor(voltage)

/** Colour of line junctions (tap / splice points) on the map: a see-through blue area behind the lines, its sides square to the lanes running in. */
export const JUNCTION_COLOR = '#2f80ed'
export const JUNCTION_FILL_OPACITY = 0.18
/** The legend's junction symbol: a small see-through blue area, in a 12 × 12 view box like the yard symbols. */
export const JUNCTION_SYMBOL_RECT = {x: 1, y: 2.5, width: 10, height: 7}
export const JUNCTION_SYMBOL_PX = 13

/** The yard symbol as inline SVG markup, for the HTML of map labels and popups (the panels use `VoltageSymbol`). */
export function voltageSymbolSvg(voltage?: string, planned?: boolean, size = 11): string {
    const {tag, attrs} = voltageSymbolShape(voltage)
    const a = Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(' ')
    return `<svg class="vsym" width="${size}" height="${size}" viewBox="0 0 12 12" aria-hidden="true"><${tag} ${a} fill="${voltageSymbolColor(voltage, planned)}"/></svg>`
}

export const voltageLegend: { voltage: string; label: string }[] = [
    {voltage: 'AC500KV', label: '500 kV'}, {voltage: 'AC230KV', label: '230 kV'}, {voltage: 'AC115KV', label: '115 kV'},
    {voltage: 'AC69KV', label: '69 kV'}, {voltage: 'AC33KV', label: '33 kV'}, {voltage: 'AC22KV', label: '22 kV'},
    {voltage: '0V', label: '0 V de-energized'},
]

export function haversineKm(a: CoordinatesProps, b: CoordinatesProps): number {
    const R = 6371
    const dLat = (b.latitude - a.latitude) * Math.PI / 180
    const dLon = (b.longitude - a.longitude) * Math.PI / 180
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * Math.PI / 180) * Math.cos(b.latitude * Math.PI / 180) * Math.sin(dLon / 2) ** 2
    return 2 * R * Math.asin(Math.sqrt(s))
}

/** The generating units of a site, by name (numbers compared as numbers: Block 2 before Block 10). */
export function generationUnitsOf(doc: NetworkDocument, groupId: string): GenerationUnitRecord[] {
    return (doc.generationUnits ?? []).filter(u => u.groupId === groupId).sort((a, b) => a.name.localeCompare(b.name, undefined, {numeric: true}))
}

/** Megawatts as text: `1,400 MW`, `12.5 MW`. */
export const mwText = (mw: number) => `${mw.toLocaleString('en-US', {maximumFractionDigits: 1})} MW`

/** Installed capacity of some units: `1,400 MW + 300 MW planned`, noting the units whose capacity is not known; empty without units. */
export function capacityText(units: GenerationUnitRecord[]): string {
    const sum = (list: GenerationUnitRecord[]) => list.reduce((s, u) => s + (u.capacityMw ?? 0), 0)
    const built = units.filter(u => !u.planned), planned = units.filter(u => u.planned)
    const unknown = units.filter(u => u.capacityMw === undefined).length
    return [built.length ? mwText(sum(built)) : '', planned.length ? `${built.length ? '+ ' : ''}${mwText(sum(planned))} planned` : '', unknown ? `(${unknown} without capacity)` : '']
        .filter(Boolean).join(' ')
}
