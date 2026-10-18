import {useCallback, useEffect, useRef, useState} from 'react'
import L from 'leaflet'
import type {CoordinatesProps} from '@shared/models/coordinates'
import {CIRCUIT_END_FROM, CIRCUIT_END_TO, CircuitEnd, ConnectionJunctionKind, ConnectionJunctionRef, ConnectionRecord, ConnectionScope, NetworkDocument, NetworkNodeKind, SubstationGroupRecord, TransmissionCircuitRecord, TransmissionJunctionRecord, TransmissionPathRecord} from '@shared/network/records'
import {cascadeDeleteOps, pickId} from '@shared/network/ops'
import {moveSiteOps} from '@shared/network/siteJunction'
import {siteOfRef} from '@shared/network/refs'
import {circuitsOnPath, connectionsAt, junctionsOfSite, ofYard, pathsEndingAt, recordById, yardsOfSite} from '@shared/network/lookup'
import {TransmissionVoltage} from '@shared/models/transmission.voltage'
import {extensionsOf} from '@shared/network/extensions'
import {hasTowerHints, towerLanePositions} from './towerLayout'
import {junctionNaming, siteNaming} from '@shared/network/naming'
import {buildSplitPathPlan} from './splitPath'
import {confirmDeleteLines, linesRemovedBy, linesRemovedNote} from './deleteLines'
import {GENERATION_BADGES, GENERATION_LABELS, GENERATION_SITE_COLOR} from '@shared/models/generation'
import {useNetworkEditor} from './NetworkContext'
import {useSideWidth} from '../hooks/useSideWidth'
import {MapPanels} from './MapPanels'
import {JunctionArrival, JunctionDrawing, layoutJunction, trimStartAtCircle} from './junctionLayout'
import {capacityText, CircuitDraft, CreateDraft, draftPickedPlaces, dropDraftPlace, EMPTY_CIRCUIT_DRAFT, EMPTY_LINE_DRAFT, EMPTY_PATH_DRAFT, endLocation, generationUnitsOf, LineDraft, lineDraftJunctionClick, lineDraftSiteClick, PathDraft, pickDraftEnd, JUNCTION_COLOR, JUNCTION_FILL_OPACITY, junctionSize, locationOfRef, Mode, plannedVoltageColor, mapDetailScale, SITE_MARKER_MIN_PX, SITE_MARKER_PX, SITE_SIZE_RANK, siteSize, voltageColor, voltageKv, voltageSymbolSvg, WaypointEdit} from './mapUtil'
import type {Selection} from './NetworkContext'
import type {MetaResponse} from '../api/client'
import {yardNameForVoltage} from '@shared/models/naming'

export type {Mode, CircuitDraft} from './mapUtil'

/** Polyline weight in px: 2 for a single conductor, +0.5 per extra sub-conductor in the bundle (capped at 4.5). */
export function circuitWeight(bundle?: number): number {
    return 1.5 + Math.min(Math.max(bundle ?? 1, 1), 6) * 0.5
}

/** Parallel circuits on one path are drawn side by side, at most this many distinct offsets. */
export const MAX_PARALLEL = 6
const PARALLEL_SPACING_PX = 5

/**
 * Shifts a polyline (layer pixels) sideways by `offsetPx` (positive = left of
 * the travel direction, as seen on the map), using mitred joins at interior vertices. Layer pixels
 * change with the zoom, so this is redone on every zoom.
 */
function offsetPoints(p: L.Point[], offsetPx: number): L.Point[] {
    if (!offsetPx || p.length < 2) return p
    const normals: L.Point[] = []
    for (let i = 0; i < p.length - 1; i++) {
        const dx = p[i + 1].x - p[i].x, dy = p[i + 1].y - p[i].y
        const len = Math.hypot(dx, dy) || 1
        normals.push(L.point(dy / len, -dx / len))
    }
    const out: L.Point[] = []
    for (let i = 0; i < p.length; i++) {
        let nx: number, ny: number
        if (i === 0) [nx, ny] = [normals[0].x, normals[0].y]
        else if (i === p.length - 1) [nx, ny] = [normals[normals.length - 1].x, normals[normals.length - 1].y]
        else {
            const a = normals[i - 1], b = normals[i]
            nx = a.x + b.x
            ny = a.y + b.y
            const len = Math.hypot(nx, ny)
            if (len < 1e-6) [nx, ny] = [b.x, b.y]
            else {
                // mitre: scale so the offset distance stays constant, limited at sharp angles
                const cosHalf = Math.min(1, Math.max(0.5, len / 2))
                nx = nx / len / cosHalf
                ny = ny / len / cosHalf
            }
        }
        out.push(L.point(p[i].x + nx * offsetPx, p[i].y + ny * offsetPx))
    }
    return out
}

/* ---------- junction rings ---------- */

/** Smallest radius (px) of a junction's circle at full detail (scaled down when zoomed out like the sites), for a junction with a single lane (or none) running in. */
const JUNCTION_RING_MIN_PX = 8
/** Invisible handle (px) in the middle of a junction: drags it and shows its summary on hover. */
const JUNCTION_HIT_PX = 14
/** How far (px) beside a picked site or junction marker a right-click still takes it out of a draft (small markers are hard to hit). */
const RIGHT_CLICK_SLACK_PX = 12

/** Where a circuit lane meets a junction area: the point on its edge and the unit direction pointing into the area. */
interface RingPort {
    point: L.Point
    dir: L.Point
    color: string
    weight: number
    junctionId: string
}

/** Unit direction a polyline (layer pixels) leaves its first point in; undefined when it does not move away from it. */
function leavingDir(p: L.Point[]): L.Point | undefined {
    for (let i = 1; i < p.length; i++) {
        const dx = p[i].x - p[0].x, dy = p[i].y - p[0].y, len = Math.hypot(dx, dy)
        if (len > 0.5) return L.point(dx / len, dy / len)
    }
    return undefined
}

/** Paths reaching a junction within this angle of each other run in as one corridor (laid side by side, see `layoutLanes`). */
const JUNCTION_CORRIDOR_DEG = 15

/**
 * Lane layout of the circuits on each path (lane group): the order of its
 * lanes, by increasing offset to the right of the path's direction, and a
 * sideways shift of the whole group, in lanes. By default a path's circuits
 * are spread around its line in name order (`siblings`, no shift). At each
 * junction drawn with a circle:
 * - paths reaching it from nearly the same direction (within
 *   `JUNCTION_CORRIDOR_DEG`) form a corridor and are laid side by side,
 *   each shifted off its own line, instead of overlapping;
 * - lanes are ordered after the lanes they connect to across the junction,
 *   so the connectors drawn inside it do not cross (two chords between the
 *   arcs of the circle do not cross when, going round one arc, their
 *   partners come in the opposite order).
 * Junctions are visited busiest first. At each, the corridor with a path laid
 * out already (else the one with the most circuits) anchors, the others follow
 * it; a path is laid out once, at the first junction that reaches it, so a
 * chain of junctions propagates the order. `points` gives a circuit's route in
 * layer pixels (FROM to TO), for the directions the paths reach a junction in.
 */
function layoutLanes(doc: NetworkDocument, siblings: Map<string, string[]>, junctions: Map<string, TransmissionJunctionRecord>, connByEnd: Map<string, ConnectionRecord>,
                     ringOf: (circuitId: string, end: string, route?: TransmissionPathRecord) => string | undefined, laneGroup: (c: TransmissionCircuitRecord) => string,
                     points: (c: TransmissionCircuitRecord) => L.Point[], pinned: Set<string> = new Set(),
                     position: (key: string, id: string) => number | undefined = () => undefined): { order: Map<string, string[]>; shift: Map<string, number> } {
    const order = new Map(siblings)
    const shift = new Map<string, number>()
    /** A path (lane group) ending at a junction: at which circuit end, and the direction `u` it leaves the junction in. */
    interface Arrival { key: string; end: string; u: L.Point }
    const arrivals = new Map<string, Arrival[]>()
    for (const [key, ids] of siblings) {
        if (key.startsWith('no-path:')) continue
        const route = recordById(doc.paths, key)
        const circuits = ids.map(id => recordById(doc.circuits, id)).filter((c): c is TransmissionCircuitRecord => !!c)
        for (const end of [CIRCUIT_END_FROM, CIRCUIT_END_TO]) {
            const first = circuits.find(c => ringOf(c.id, end, route))
            if (!first) continue
            const pts = points(first)
            const u = leavingDir(end === CIRCUIT_END_FROM ? pts : [...pts].reverse())
            const jid = ringOf(first.id, end, route)!
            if (u) arrivals.set(jid, [...(arrivals.get(jid) ?? []), {key, end, u}])
        }
    }

    const R = 4   // nominal circle radius, in lanes: only the angles of the ports matter
    const angleOf = (p: L.Point) => Math.atan2(p.y, p.x)
    const normal = (u: L.Point) => L.point(u.y, -u.x)   // the right of u, as in offsetPoints
    /** +1 when lane offsets on the path point the same way as the right of `u` at this end (the path leaves the junction there). */
    const sign = (a: Arrival) => a.end === CIRCUIT_END_FROM ? 1 : -1
    const lanesOf = (key: string, id: string) => {
        const pos = position(key, id)
        if (pos !== undefined) return (shift.get(key) ?? 0) + pos
        const ids = order.get(key) ?? [id]
        const lanes = Math.min(ids.length, MAX_PARALLEL)
        return (shift.get(key) ?? 0) + Math.min(ids.indexOf(id), MAX_PARALLEL - 1) - (lanes - 1) / 2
    }
    // paths whose circuits set their tower positions keep them (their lanes are never reordered)
    const fixed = new Set<string>(pinned)
    const corridor = JUNCTION_CORRIDOR_DEG * Math.PI / 180
    const between = (a: L.Point, b: L.Point) => Math.acos(Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y)))
    const busy = (jid: string) => (arrivals.get(jid) ?? []).reduce((s, a) => s + (order.get(a.key)?.length ?? 0), 0)

    for (const jid of [...arrivals.keys()].filter(j => junctions.has(j)).sort((a, b) => busy(b) - busy(a))) {
        const list = arrivals.get(jid)!
        // corridors: arrivals sorted by angle, neighbours within the corridor angle joined (also across ±180°)
        const sorted = [...list].sort((a, b) => angleOf(a.u) - angleOf(b.u))
        const units: Arrival[][] = []
        for (const a of sorted) {
            const last = units[units.length - 1]
            if (last && between(last[last.length - 1].u, a.u) < corridor) last.push(a)
            else units.push([a])
        }
        if (units.length > 1 && between(units[units.length - 1][units[units.length - 1].length - 1].u, units[0][0].u) < corridor) units[0] = [...units.pop()!, ...units[0]]
        const size = (unit: Arrival[]) => unit.reduce((s, a) => s + (order.get(a.key)?.length ?? 0), 0)
        const anchor = [...units].sort((a, b) => Number(b.some(x => fixed.has(x.key))) - Number(a.some(x => fixed.has(x.key))) || size(b) - size(a))[0]

        /** Where a circuit end's lane meets the circle (angle), for a path laid out already. */
        const portAngle = (circuitId: string, a: Arrival) => {
            const pos = sign(a) * lanesOf(a.key, circuitId)
            return angleOf(a.u.multiplyBy(R).add(normal(a.u).multiplyBy(pos)))
        }
        const layoutUnit = (unit: Arrival[]) => {
            const dir = unit.reduce((s, a) => s.add(a.u), L.point(0, 0))
            const len = Math.hypot(dir.x, dir.y) || 1
            const u = L.point(dir.x / len, dir.y / len)
            const base = angleOf(u)
            const ccw = (angle: number) => ((angle - base) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI)
            const rel = (angle: number) => ccw(angle + Math.PI) - Math.PI
            /**
             * Angle (ccw from this corridor) of the port the circuit end connects to across the junction: exact for a path laid
             * out already, else the direction that path leaves in (its lanes are not placed yet).
             */
            const partnerKey = (circuitId: string, a: Arrival): number | undefined => {
                const conn = connByEnd.get(`${circuitId}:${a.end}`)
                if (!conn || conn.junction.id !== jid) return undefined
                for (const n of conn.nodes) {
                    if (n.kind !== NetworkNodeKind.TRANSMISSION_CIRCUIT || (n.id === circuitId && n.terminal === a.end)) continue
                    const partner = recordById(doc.circuits, n.id)
                    const pa = partner && list.find(x => x.key === laneGroup(partner) && x.end === n.terminal)
                    if (!pa || unit.includes(pa)) continue
                    return ccw(fixed.has(pa.key) ? portAngle(n.id, pa) : angleOf(pa.u))
                }
                return undefined
            }
            const groups = unit.map(a => {
                const ids = order.get(a.key) ?? []
                const keys = new Map(ids.map(id => [id, partnerKey(id, a)] as const))
                const known = [...keys.values()].filter((k): k is number => k !== undefined)
                return {a, ids, keys, mean: known.length ? known.reduce((s, k) => s + k, 0) / known.length : undefined}
            })
            /** Lanes sorted for slots of increasing angle: partners in decreasing angle (non-crossing chords), unknown ones keep their place. */
            const byPartner = (ids: string[], keys: Map<string, number | undefined>) => [...ids].sort((x, y) => {
                const kx = keys.get(x), ky = keys.get(y)
                return kx !== undefined && ky !== undefined ? ky - kx : 0
            })
            /** Hands out slots (positions across `uDir`, in lanes, to the right of it) to the lanes of one path at this end. */
            const place = (g: typeof groups[number], slots: number[]) => {
                const seq = byPartner(g.ids, g.keys)
                const s = sign(g.a)
                const offsets = new Map(seq.map((id, i) => [id, s * slots[i]] as const))
                order.set(g.a.key, [...g.ids].sort((x, y) => offsets.get(x)! - offsets.get(y)!))
                const center = slots.reduce((t, v) => t + v, 0) / slots.length
                if (Math.abs(center) > 1e-9) shift.set(g.a.key, s * center)
            }
            /** Slot positions (lanes across `uDir`, to its right) sorted by increasing angle of their port. */
            const slotsByAngle = (n: number, uDir: L.Point, from = 0) => Array.from({length: n}, (_, k) => from + k - (n - 1) / 2)
                .sort((p, q) => rel(angleOf(uDir.multiplyBy(R).add(normal(uDir).multiplyBy(p)))) - rel(angleOf(uDir.multiplyBy(R).add(normal(uDir).multiplyBy(q)))))
            const free = groups.filter(g => !fixed.has(g.a.key))
            if (!free.length) return
            if (unit.length > 1 && free.length === groups.length && groups.every(g => g.ids.length <= MAX_PARALLEL)) {
                // a corridor: the paths side by side, in the order of their partners (else of their own directions), each lane on its slot
                groups.sort((g, h) => g.mean !== undefined && h.mean !== undefined ? h.mean - g.mean : rel(angleOf(g.a.u)) - rel(angleOf(h.a.u)))
                const total = groups.reduce((s, g) => s + g.ids.length, 0)
                const slots = slotsByAngle(total, u)
                let next = 0
                for (const g of groups) {
                    place(g, slots.slice(next, next + g.ids.length))
                    next += g.ids.length
                }
            } else {
                // a single path (or one next to paths laid out already): only the order of its own lanes
                for (const g of free) if (g.ids.length > 1 && g.ids.length <= MAX_PARALLEL && g.mean !== undefined) place(g, slotsByAngle(g.ids.length, g.a.u))
            }
        }
        // each corridor laid out is fixed right away, so the next ones order their lanes after its actual lanes (not only
        // after the direction its path leaves in) and the connectors between them run parallel instead of crossing
        layoutUnit(anchor)
        for (const a of anchor) fixed.add(a.key)
        for (const unit of units) {
            if (unit === anchor) continue
            layoutUnit(unit)
            for (const a of unit) fixed.add(a.key)
        }
    }
    return {order, shift}
}

/** Zoom levels above the one where parallel lanes merge on which circuits are drawn thinner (see `laneWidthFactor`). */
const THIN_ZOOM_LEVELS = 3
/** Width factor on the first level after merging; it grows evenly to full width over THIN_ZOOM_LEVELS levels. */
const THIN_MIN_FACTOR = 0.5

/**
 * Width factor of circuit lines at a zoom: 1 where lanes are merged or the zoom is THIN_ZOOM_LEVELS or more levels
 * above the last merged one (the levels where 4-conductor lines in neighbouring lanes would touch, see mergeLanes);
 * on the levels in between, from THIN_MIN_FACTOR on the first one rising evenly towards 1.
 */
function laneWidthFactor(zoom: number): number {
    const merged = (z: number) => PARALLEL_SPACING_PX * mapDetailScale(z) < circuitWeight(4)
    if (merged(zoom)) return 1
    let lastMerged = Math.floor(zoom)
    while (lastMerged > 0 && !merged(lastMerged)) lastMerged--
    if (lastMerged <= 0) return 1
    const above = zoom - lastMerged   // 1 on the first level after merging
    if (above > THIN_ZOOM_LEVELS) return 1
    return THIN_MIN_FACTOR + (1 - THIN_MIN_FACTOR) * (above - 1) / THIN_ZOOM_LEVELS
}

/** An extension site closer than this (px) to its parent's marker is drawn grouped with it. */
const EXTENSION_GROUP_PX = 24
/** A line junction whose circle would come closer than this (px) to the marker of a site it is linked to is drawn with the site. */
const JUNCTION_SITE_GAP_PX = 4

/**
 * The network as drawn with extension sites grouped into their parents
 * (`grouped`: extension id → parent id): a grouped site and its site junction
 * take the parent's position, and the circuits and paths between a grouped
 * extension and its parent (or another grouped extension of it) are left out.
 */
function groupedView(doc: NetworkDocument, grouped: Map<string, string>): NetworkDocument {
    const coordsOf = new Map(doc.substationGroups.map(g => [g.id, g.coords]))
    const root = (id: string): string => grouped.has(id) ? root(grouped.get(id)!) : id
    /** Both places are in one group, and at least one of them is grouped into the other. */
    const inside = (a?: string, b?: string) => !!a && !!b && root(a) === root(b) && (grouped.has(a) || grouped.has(b))
    const connectionAt = new Map<string, ConnectionJunctionRef>()
    for (const conn of doc.connections) for (const n of conn.nodes) if (n.kind === NetworkNodeKind.TRANSMISSION_CIRCUIT) connectionAt.set(`${n.id}:${n.terminal}`, conn.junction)
    /** A place as a group member: its site, or a line junction grouped into a site. */
    const placeOf = (ref?: ConnectionJunctionRef) => siteOfRef(doc, ref) ?? (ref && grouped.has(ref.id) ? ref.id : undefined)
    const endPlace = (c: TransmissionCircuitRecord, end: string) => {
        const path = recordById(doc.paths, c.pathId)
        return placeOf(connectionAt.get(`${c.id}:${end}`) ?? (end === CIRCUIT_END_FROM ? path?.from : path?.to))
    }
    return {
        ...doc,
        substationGroups: doc.substationGroups.map(g => grouped.has(g.id) ? {...g, coords: coordsOf.get(root(g.id))!} : g),
        junctions: doc.junctions.map(j => {
            const into = grouped.has(j.id) ? root(j.id) : j.groupId && grouped.has(j.groupId) ? root(j.groupId) : undefined
            return into ? {...j, coords: coordsOf.get(into)!} : j
        }),
        circuits: doc.circuits.filter(c => !inside(endPlace(c, CIRCUIT_END_FROM), endPlace(c, CIRCUIT_END_TO))),
        paths: doc.paths.filter(p => !inside(placeOf(p.from), placeOf(p.to))),
    }
}

const esc = (v: string) => v.replace(/[&<>"]/g, ch => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[ch] as string))

/** Stacked, semi-transparent badge coloured by voltage (same palette as circuit lines), for the nodes of a junction. */
const badge = (text: string, voltage?: string) =>
    `<div class="map-yard-badge" style="background:color-mix(in srgb, ${voltageColor(voltage)} 72%, transparent)" title="${esc(voltage ?? '')}">${esc(text)}</div>`

type YardLabel = { yardName: string; voltage: string; planned?: boolean }
const byVoltageDesc = (yards: YardLabel[]) => [...yards].sort((a, b) => voltageKv(b.voltage) - voltageKv(a.voltage) || a.yardName.localeCompare(b.yardName))

/** Compact site label: the yards' voltage symbols only, highest voltage first, on the line of the site code (dulled when planned). */
const yardSymbols = (yards: YardLabel[], sitePlanned?: boolean) =>
    yards.length === 0 ? '' : `<span class="map-yard-symbols">` + byVoltageDesc(yards).map(y => {
        const planned = y.planned || sitePlanned
        return `<span class="map-yard" title="${esc(y.yardName)} · ${esc(y.voltage)}${planned ? ' · planned' : ''}">${voltageSymbolSvg(y.voltage, planned)}</span>`
    }).join('') + `</span>`

/** Detailed site label: one line per yard, highest voltage first, its symbol and name, plus the voltage when the name does not say it. */
const yardList = (yards: YardLabel[], sitePlanned?: boolean) =>
    yards.length === 0 ? '' : `<div class="map-yard-list">` + byVoltageDesc(yards).map(y => {
        const planned = y.planned || sitePlanned
        const voltageName = yardNameForVoltage(y.voltage) ?? y.voltage
        return `<div class="map-yard ${planned ? 'planned' : ''}">${voltageSymbolSvg(y.voltage, planned)}${esc(y.yardName)}${y.yardName !== voltageName ? ` <span class="muted">${esc(voltageName)}</span>` : ''}</div>`
    }).join('') + `</div>`

/** What the map draws (the "Map features" panel); remembered by the browser when storage is available. */
interface MapFeatures {
    /** Site labels show the site name and one line per yard (off: yard symbols next to the code). */
    details: boolean
    /** Site labels are shown (off: only while hovering, or for the selected / picked site). */
    labels: boolean
    /** Site circles are shown (toggle "Sites"; off: hidden unless the site is hovered, selected or picked; the site still answers clicks there). */
    siteCircles: boolean
    /** The blue junction areas behind the lines (off: hidden unless the junction is hovered, selected or picked; an area still answers clicks). */
    junctions: boolean
    /** Paths without circuits, as grey dashed routes. */
    unusedPaths: boolean
    /** Planned sites, circuits and connections. */
    planned: boolean
    /** Sites and lines below 230 kV (off: circuits running below 230 kV and sites whose yards are all below it are left out). */
    lowVoltage: boolean
    /** Sites and lines below 500 kV (off: circuits running below 500 kV and sites whose yards are all below it are left out, the 500 kV grid alone). */
    below500: boolean
    /** The OpenStreetMap base map. */
    baseMap: boolean
    /** The panel is expanded. */
    open: boolean
}

const MAP_FEATURES_KEY = 'thgrid.mapFeatures'
/** The old key of the details toggle, read once so the setting carries over. */
const MAP_DETAILS_KEY = 'thgrid.mapDetails'
const DEFAULT_MAP_FEATURES: MapFeatures = {details: false, labels: true, siteCircles: true, junctions: true, unusedPaths: true, planned: true, lowVoltage: true, below500: true, baseMap: true, open: true}

/** A map feature toggle; `off` gives why it does nothing with the other toggles as they are (it is shown disabled then). */
const MAP_FEATURE_TOGGLES: { key: Exclude<keyof MapFeatures, 'open'>; label: string; title: string; off?: (f: MapFeatures) => string | undefined }[] = [
    {key: 'details', label: 'Site details', title: "Site labels show the site name and each yard's voltage, one line per yard (off: yard symbols next to the code)"},
    {key: 'labels', label: 'Site labels', title: 'Off: a site label shows only while hovering it, or when the site is selected'},
    {key: 'siteCircles', label: 'Sites', title: 'Off: the site circles are hidden; hovering where one is shows it again, as does selecting or picking the site, and a site still answers clicks there'},
    {key: 'junctions', label: 'Junction areas', title: 'The blue area of a line junction behind the lines (off: hidden; hovering the junction shows it again, as does selecting or picking it, and it still answers clicks)'},
    {key: 'unusedPaths', label: 'Paths without circuits', title: 'Routes no circuit uses yet, grey dashed'},
    {key: 'planned', label: 'Planned', title: 'Planned sites, circuits and connections (dotted, dull colours)'},
    {key: 'below500', label: 'Below 500 kV', title: 'Off: circuits running below 500 kV (energized, else rated voltage) and sites whose yards are all below 500 kV are hidden: the 500 kV grid alone'},
    {key: 'lowVoltage', label: 'Below 230 kV', title: 'Off: circuits running below 230 kV (energized, else rated voltage) and sites whose yards are all below 230 kV are hidden',
        off: f => f.below500 ? undefined : 'Below 500 kV is off: everything below 500 kV is hidden already'},
    {key: 'baseMap', label: 'Base map', title: 'The OpenStreetMap background'},
]

function loadMapFeatures(): MapFeatures {
    try {
        const raw = window.localStorage.getItem(MAP_FEATURES_KEY)
        if (raw) return {...DEFAULT_MAP_FEATURES, ...JSON.parse(raw)}
        return {...DEFAULT_MAP_FEATURES, details: window.localStorage.getItem(MAP_DETAILS_KEY) === '1'}
    } catch {
        return DEFAULT_MAP_FEATURES
    }
}

function saveMapFeatures(f: MapFeatures): void {
    try {
        window.localStorage.setItem(MAP_FEATURES_KEY, JSON.stringify(f))
    } catch {
        // storage unavailable: the toggles are just not remembered
    }
}

const toLatLng = (c: CoordinatesProps): L.LatLngExpression => [c.latitude, c.longitude]

/**
 * Zooms just enough to cover the sites: only the substation groups count,
 * not junctions, routes or waypoints (they lie between the sites). A lone
 * site is centred at a town-level zoom. The size is re-read first, because a
 * fit computed against a stale (smaller) container size zooms out too far.
 */
function fitSites(map: L.Map, doc: NetworkDocument): void {
    const sites = doc.substationGroups.map(g => toLatLng(g.coords))
    if (!sites.length) return
    map.invalidateSize()
    if (sites.length === 1) map.setView(sites[0], 12)
    else map.fitBounds(L.latLngBounds(sites), {padding: [48, 48]})
}

/* ---------- what the network drawing leaves for the selection overlay ---------- */

/** A site or junction marker as drawn: its label, and whether the drawing shows the label without hovering. */
interface DrawnMarker {
    marker: L.Marker
    label: string
    size: number
    permanent: boolean
}

/**
 * What the network drawing (the base layer, drawn again only when the network, the zoom or a toggle changes) leaves for
 * the selection overlay (`drawOverlay`), which follows the selection, the mode and the drafts without drawing the
 * network again.
 */
interface Drawn {
    /** Site and junction markers (`G:<site id>`, `J:<junction id>`). */
    markers: Map<string, DrawnMarker>
    /** Where a place (`G:` / `J:`) is drawn: an extension or a junction drawn as part of a site is drawn as that site. */
    drawnAs: (place: string) => string
    /** Circuit lines (merged far out: the circuits of a path at one voltage): points, width, circuits and their path. */
    units: { pts: L.LatLng[]; weight: number; circuitIds: string[]; pathId?: string }[]
    /** Paths without circuits: their points, and the ring a path with a single point is drawn as. */
    unusedPaths: Map<string, { pts: L.LatLng[]; ring?: L.CircleMarker }>
    /** Connections drawn inside junction areas: their pieces. */
    connections: Map<string, { pts: L.LatLng[]; weight: number }[]>
    /** Junction areas, by junction id. */
    areas: Map<string, L.CircleMarker>
    /** Junctions, paths and sites the toggles leave out; drawn anyway while selected or edited (`keep`). */
    hidden: Set<string>
    /** Markers can be dragged (select mode only; the overlay switches them). */
    draggable: boolean
    /** Undoes what the overlay changed on the drawing (marker classes and labels, area and ring styles). */
    restore: (() => void)[]
}

const emptyDrawn = (): Drawn => ({markers: new Map(), drawnAs: p => p, units: [], unusedPaths: new Map(), connections: new Map(), areas: new Map(), hidden: new Set(), draggable: true, restore: []})

/** Tooltip options of a site or junction label (`permanent`: shown without hovering). */
const markerLabel = (size: number, permanent: boolean): L.TooltipOptions => ({permanent, direction: 'right', offset: [size / 2 + 2, 0], className: 'map-label'})

/** Junction area outline: as drawn, selected, or picked in a draft. */
const AREA_STYLE = {color: JUNCTION_COLOR, weight: 1, opacity: .8, dashArray: undefined}
const AREA_SELECTED_STYLE = {color: '#ffd21f', weight: 3, opacity: 1, dashArray: undefined}
const AREA_PICKED_STYLE = {color: '#ffd21f', weight: 2.5, opacity: 1, dashArray: '4 3'}

/* ---------- remembered map view (centre + zoom per network) ---------- */

interface MapView {
    center: [number, number]
    zoom: number
}

const mapViewKey = (networkId: string) => `thgrid.mapView.${networkId}`

/** The view the network was last shown at, if the browser still has it (storage may be unavailable or cleared). */
function loadMapView(networkId: string): MapView | undefined {
    try {
        const raw = window.localStorage.getItem(mapViewKey(networkId))
        if (!raw) return undefined
        const v = JSON.parse(raw) as Partial<MapView>
        const [lat, lng] = Array.isArray(v.center) ? v.center : []
        if (typeof lat !== 'number' || typeof lng !== 'number' || typeof v.zoom !== 'number' || !Number.isFinite(lat + lng + v.zoom)) return undefined
        return {center: [lat, lng], zoom: v.zoom}
    } catch {
        return undefined
    }
}

function saveMapView(networkId: string, map: L.Map): void {
    try {
        const c = map.getCenter()
        const view: MapView = {center: [Number(c.lat.toFixed(6)), Number(c.lng.toFixed(6))], zoom: map.getZoom()}
        window.localStorage.setItem(mapViewKey(networkId), JSON.stringify(view))
    } catch {
        // storage unavailable: the next visit simply fits the sites again
    }
}

/** `#/network/:id/map` – OpenStreetMap based editor of sites, junctions and circuits. */
export function MapEditor({meta, navigate}: { meta: MetaResponse; navigate: (path: string) => void }) {
    const ed = useNetworkEditor()
    const [sideWidth, onResizeStart] = useSideWidth()
    const containerRef = useRef<HTMLDivElement>(null)
    const mapRef = useRef<L.Map | null>(null)
    const layerRef = useRef<L.LayerGroup | null>(null)
    /** The selection overlay (`drawOverlay`): highlights and waypoint handles, over the network drawing in `layerRef`. */
    const overlayRef = useRef<L.LayerGroup | null>(null)
    const fitted = useRef(false)   // the initial fit to the sites happened (or a remembered view was restored)
    const [mode, setModeState] = useState<Mode>('select')
    /** Mode `addCircuit`: the new circuit's ends, set in its panel or by clicking sites and junctions on the map (right-click takes an end out). */
    const [draft, setDraft] = useState<CircuitDraft>(EMPTY_CIRCUIT_DRAFT)
    const modeRef = useRef<Mode>(mode)
    const edRef = useRef(ed)
    edRef.current = ed
    const [wp, setWp] = useState<WaypointEdit | null>(null)
    const [zoomTick, setZoomTick] = useState(0)
    const [features, setFeaturesState] = useState(loadMapFeatures)
    const setFeature = useCallback((patch: Partial<MapFeatures>) => setFeaturesState(prev => {
        const next = {...prev, ...patch}
        saveMapFeatures(next)
        return next
    }), [])
    const details = features.details
    const tileRef = useRef<L.TileLayer | null>(null)
    const featuresRef = useRef(features)
    featuresRef.current = features
    const [createDraft, setCreateDraftState] = useState<CreateDraft>({id: '', code: '', name: ''})
    const createRef = useRef<CreateDraft>(createDraft)
    const setCreateDraft = useCallback((d: CreateDraft) => {
        createRef.current = d
        setCreateDraftState(d)
    }, [])
    const wpRef = useRef<WaypointEdit | null>(null)
    wpRef.current = wp

    /** Mode `addLine`: the wizard's stops, set in its panel or by clicking sites and junctions on the map (right-click takes one out). */
    const [lineDraft, setLineDraft] = useState<LineDraft>(EMPTY_LINE_DRAFT)
    const lineDraftRef = useRef(lineDraft)
    lineDraftRef.current = lineDraft
    /** Applies a map click's change to the line draft, or says why it could not. */
    const changeLineDraft = useCallback((r: { draft?: LineDraft; error?: string }) => {
        if (r.error) window.alert(r.error)
        if (r.draft) setLineDraft(r.draft)
    }, [])

    /** Mode `addPath`: the new path's ends, name and id, set in its panel or by clicking sites and junctions on the map (right-click takes an end out). */
    const [pathDraft, setPathDraft] = useState<PathDraft>(EMPTY_PATH_DRAFT)
    const pathDraftRef = useRef(pathDraft)
    pathDraftRef.current = pathDraft
    const draftRef = useRef(draft)
    draftRef.current = draft
    /** What the network drawing left for the selection overlay (see `Drawn`). */
    const drawnRef = useRef<Drawn>(emptyDrawn())
    /**
     * Selected or edited records the toggles leave out (a junction whose circuits are all hidden, a path without circuits,
     * a planned or low-voltage site), drawn anyway: their ids, space-separated. Set by `syncKeep`.
     */
    const [keep, setKeep] = useState('')
    /** The draft of the current mode ("+ Line", "+ Path", "+ Circuit"), if any. */
    const currentDraft = useCallback(() => modeRef.current === 'addLine' ? lineDraftRef.current : modeRef.current === 'addPath' ? pathDraftRef.current
        : modeRef.current === 'addCircuit' ? draftRef.current : undefined, [])
    /**
     * A right-click on what is drawn as `drawnKey`: takes the picked place drawn there out of the draft (the place itself,
     * else one drawn with it). False when nothing picked is drawn there.
     */
    const dropDrawn = useCallback((drawnKey: string): boolean => {
        const d = currentDraft()
        if (!d) return false
        const doc = edRef.current.doc
        const picked = draftPickedPlaces(doc, d)
        const place = picked.find(p => p === drawnKey) ?? picked.find(p => drawnRef.current.drawnAs(p) === drawnKey)
        if (!place) return false
        if (modeRef.current === 'addLine') setLineDraft(dropDraftPlace(doc, lineDraftRef.current, place))
        else if (modeRef.current === 'addPath') setPathDraft(x => dropDraftPlace(doc, x, place))
        else setDraft(x => dropDraftPlace(doc, x, place))
        return true
    }, [currentDraft])
    /**
     * The picked place a right-click on the map lands on, as drawn: on its marker, within RIGHT_CLICK_SLACK_PX of it (small
     * markers), or on its label. The nearest when several do.
     */
    const pickedDrawnAt = useCallback((ev: MouseEvent): string | undefined => {
        const d = currentDraft()
        if (!d) return undefined
        const keys = new Set(draftPickedPlaces(edRef.current.doc, d).map(p => drawnRef.current.drawnAs(p)))
        let best: { key: string; dist: number } | undefined
        for (const key of keys) {
            const m = drawnRef.current.markers.get(key)?.marker
            const icon = m?.getElement()
            if (!m || !icon) continue
            const r = icon.getBoundingClientRect()
            const dist = Math.hypot(ev.clientX - (r.left + r.width / 2), ev.clientY - (r.top + r.height / 2))
            const label = m.getTooltip()?.getElement()?.getBoundingClientRect()
            const onLabel = !!label && label.width > 0 && ev.clientX >= label.left && ev.clientX <= label.right && ev.clientY >= label.top && ev.clientY <= label.bottom
            if ((onLabel || dist <= Math.max(r.width, r.height) / 2 + RIGHT_CLICK_SLACK_PX) && (!best || dist < best.dist)) best = {key, dist}
        }
        return best?.key
    }, [currentDraft])
    const setMode = useCallback((m: Mode) => {
        modeRef.current = m
        setModeState(m)
        if (m !== 'addCircuit') setDraft(EMPTY_CIRCUIT_DRAFT)
        if (m !== 'addLine') setLineDraft(EMPTY_LINE_DRAFT)
        if (m !== 'addPath') setPathDraft(EMPTY_PATH_DRAFT)
        if (m !== 'editWaypoints') {
            wpRef.current = null
            setWp(null)
        }
    }, [])

    /** Path about to be split with a junction (mode `splitPath`); the next map click places the junction. */
    const splitRef = useRef<string | null>(null)
    const startSplit = useCallback(() => {
        const sel = edRef.current.selection
        const pathId = !sel ? undefined : sel.collection === 'paths' ? sel.id : sel.collection === 'circuits' ? edRef.current.doc.circuits.find(c => c.id === sel.id)?.pathId : undefined
        if (!pathId) return
        splitRef.current = pathId
        setCreateDraft({id: '', code: '', name: ''})
        modeRef.current = 'splitPath'
        setModeState('splitPath')
    }, [setCreateDraft])

    /** Enters waypoint editing for the selected circuit. */
    const startWaypoints = useCallback(() => {
        const sel = edRef.current.selection
        const pathId = !sel ? undefined : sel.collection === 'paths' ? sel.id : sel.collection === 'circuits' ? edRef.current.doc.circuits.find(c => c.id === sel.id)?.pathId : undefined
        if (!pathId) return
        const state: WaypointEdit = {pathId, selected: null, adding: null}
        wpRef.current = state
        setWp(state)
        modeRef.current = 'editWaypoints'
        setModeState('editWaypoints')
    }, [])

    /**
     * Mode changes asked for by the panels ("Edit waypoints" of a path or circuit): waypoint editing and splitting need the
     * selected path, so they start as the toolbar buttons start them; anything else is a plain mode change.
     */
    const panelSetMode = useCallback((m: Mode) => {
        if (m === 'editWaypoints') startWaypoints()
        else if (m === 'splitPath') startSplit()
        else setMode(m)
    }, [setMode, startWaypoints, startSplit])

    const updateWp = useCallback((patch: Partial<WaypointEdit>) => {
        const next = wpRef.current ? {...wpRef.current, ...patch} : null
        wpRef.current = next
        setWp(next)
    }, [])

    /** The transmission path of the circuit being edited. */
    const editedPath = useCallback((): TransmissionPathRecord | undefined => {
        const state = wpRef.current
        return state ? edRef.current.doc.paths.find(p => p.id === state.pathId) : undefined
    }, [])

    /** Writes a new waypoint list to the path of the circuit being edited (shared with parallel circuits). */
    const setPath = useCallback((waypoints: CoordinatesProps[]) => {
        const pathRecord = editedPath()
        if (!pathRecord) return false
        return edRef.current.apply([{type: 'upsert', collection: 'paths', record: {...pathRecord, waypoints}}])
    }, [editedPath])

    const insertWaypoint = useCallback((coords: CoordinatesProps, index: number) => {
        const pathRecord = editedPath()
        if (!pathRecord) return
        const current = pathRecord.waypoints
        const at = Math.max(0, Math.min(index, current.length))
        if (setPath([...current.slice(0, at), coords, ...current.slice(at)])) updateWp({selected: at, adding: null})
    }, [editedPath, setPath, updateWp])

    const deleteWaypoint = useCallback(() => {
        const state = wpRef.current
        const pathRecord = editedPath()
        if (!state || !pathRecord || state.selected === null) return
        const next = pathRecord.waypoints.filter((_, i) => i !== state.selected)
        if (setPath(next)) updateWp({selected: next.length ? Math.min(state.selected, next.length - 1) : null})
    }, [editedPath, setPath, updateWp])

    /**
     * Splits the path remembered by `startSplit` at a map click (`coords`), or
     * at the existing junction chosen in the create draft (no coords needed).
     */
    const performSplit = useCallback((coords?: CoordinatesProps) => {
        const e = edRef.current
        const pathId = splitRef.current
        if (!pathId) return
        const draft = createRef.current
        const plan = buildSplitPathPlan(e.doc, pathId, coords, {junctionName: draft.name, junctionId: draft.id, existingJunctionId: draft.existingJunctionId})
        if (plan.errors.length) {
            window.alert(plan.errors.join('\n'))
            return
        }
        const ops = [...plan.ops]
        const where = `${plan.junctionCreated ? 'new ' : ''}junction ${plan.junction?.name ?? plan.junction?.id}`
        if (plan.regenerate.changes.length && window.confirm(`Split at ${where}: ${plan.circuits.length} circuit(s) cut in two, ${plan.lines.length} line(s) re-sequenced.\n\nAlso rename the split circuits and paths by the model rules (${plan.regenerate.changes.length} change(s))?`)) ops.push(...plan.regenerate.ops)
        if (e.apply(ops) && plan.junction) e.select({collection: 'junctions', id: plan.junction.id})
        splitRef.current = null
        setCreateDraft({id: '', code: '', name: ''})
        setMode('select')
    }, [setCreateDraft, setMode])

    const onMapClick = useCallback((latlng: L.LatLng) => {
        const e = edRef.current
        const coords = {latitude: Number(latlng.lat.toFixed(6)), longitude: Number(latlng.lng.toFixed(6))}
        switch (modeRef.current) {
            case 'addSite': {
                const draft = createRef.current
                const groupName = draft.code.trim().toUpperCase() || `SITE${e.doc.substationGroups.length + 1}`
                const naming = siteNaming(groupName, draft.name)
                const record: SubstationGroupRecord = {id: pickId(e.doc, draft.id, naming.id), groupName, name: naming.name, coords}
                if (e.apply([{type: 'upsert', collection: 'substationGroups', record}])) e.select({collection: 'substationGroups', id: record.id})
                setCreateDraft({id: '', code: '', name: ''})
                setMode('select')
                break
            }
            case 'addJunction': {
                const draft = createRef.current
                const naming = junctionNaming(e.doc, draft.name, coords)
                const record: TransmissionJunctionRecord = {id: pickId(e.doc, draft.id, naming.id), name: naming.name, coords}
                if (e.apply([{type: 'upsert', collection: 'junctions', record}])) e.select({collection: 'junctions', id: record.id})
                setCreateDraft({id: '', code: '', name: ''})
                setMode('select')
                break
            }
            case 'splitPath':
                // With an existing junction chosen in the panel the click still splits there (the junction's position wins over the click).
                performSplit(coords)
                break
            case 'select':
                e.select(null)
                break
            case 'editWaypoints': {
                const state = wpRef.current
                if (!state || !state.adding) break
                const len = editedPath()?.waypoints.length ?? 0
                const index = state.adding === 'append' || state.selected === null ? len : state.adding === 'before' ? state.selected : state.selected + 1
                insertWaypoint(coords, index)
                break
            }
            default:
                break
        }
    }, [setMode, insertWaypoint, editedPath, setCreateDraft, performSplit])

    /**
     * Draws what follows the selection, the mode and the drafts over the network drawing, without drawing the network
     * again: the selected path, circuits, line or connection highlighted (in a pane under the lines), the selected and the
     * picked sites and junctions marked and labelled, the waypoint handles of the path being edited, and markers that
     * drag in select mode only. Undoes what it did last time first.
     */
    const drawOverlay = useCallback(() => {
        const map = mapRef.current, layer = overlayRef.current
        if (!map || !layer) return
        const drawn = drawnRef.current
        for (const undo of drawn.restore.splice(0)) undo()
        layer.clearLayers()
        const {doc, selection: sel} = edRef.current
        const mode = modeRef.current, wp = wpRef.current
        const draggable = mode === 'select'
        if (drawn.draggable !== draggable) {
            for (const {marker} of drawn.markers.values()) {
                if (draggable) marker.dragging?.enable()
                else marker.dragging?.disable()
            }
            drawn.draggable = draggable
        }

        // The selected site or junction, and the places picked in a draft, as drawn (a grouped extension or junction shows
        // on its site): the site marker marked, the label shown, a junction's area outlined.
        const d = currentDraft()
        const picked = new Set(d ? draftPickedPlaces(doc, d).map(p => drawn.drawnAs(p)) : [])
        const selKey = sel?.collection === 'substationGroups' ? drawn.drawnAs(`G:${sel.id}`) : sel?.collection === 'junctions' ? drawn.drawnAs(`J:${sel.id}`) : undefined
        for (const key of new Set([...picked, ...(selKey ? [selKey] : [])])) {
            const cls = key === selKey ? 'selected' : 'pick'
            const m = drawn.markers.get(key)
            if (m) {
                const el = m.marker.getElement()?.querySelector('.map-marker')
                el?.classList.add(cls)
                if (!m.permanent) m.marker.unbindTooltip().bindTooltip(m.label, markerLabel(m.size, true))
                drawn.restore.push(() => {
                    el?.classList.remove(cls)
                    if (!m.permanent) m.marker.unbindTooltip().bindTooltip(m.label, markerLabel(m.size, false))
                })
            }
            const area = key.startsWith('J:') ? drawn.areas.get(key.slice(2)) : undefined
            if (area) {
                area.setStyle(key === selKey ? AREA_SELECTED_STYLE : AREA_PICKED_STYLE)
                area.getElement()?.classList.add('area-on')
                drawn.restore.push(() => {
                    area.setStyle(AREA_STYLE)
                    area.getElement()?.classList.remove('area-on')
                })
            }
        }

        // Highlights under the lines: the selected circuit, every circuit on the selected path (a circuit's path when a
        // circuit is selected), every section of the selected line, the selected connection inside its junction.
        const highlight = (pts: L.LatLng[], color: string, weight: number) => L.polyline(pts, {pane: 'highlights', color, weight, opacity: .9, interactive: false}).addTo(layer)
        if (sel?.collection === 'circuits' || sel?.collection === 'paths' || sel?.collection === 'lines') {
            const pathId = sel.collection === 'paths' ? sel.id : sel.collection === 'circuits' ? recordById(doc.circuits, sel.id)?.pathId : undefined
            const lineCircuits = new Set(sel.collection === 'lines' ? recordById(doc.lines, sel.id)?.circuitIds ?? [] : [])
            for (const u of drawn.units) {
                const selected = sel.collection === 'circuits' && u.circuitIds.includes(sel.id)
                if (selected || (pathId !== undefined && u.pathId === pathId) || u.circuitIds.some(id => lineCircuits.has(id))) highlight(u.pts, selected ? '#ffd21f' : '#ffe680', u.weight + (selected ? 7 : 4))
            }
        }
        const unused = sel?.collection === 'paths' ? drawn.unusedPaths.get(sel.id) : undefined
        if (unused?.ring) {
            const ring = unused.ring
            ring.setStyle({color: '#ffd21f', weight: 3})
            drawn.restore.push(() => ring.setStyle({color: '#8b949e', weight: 2}))
        } else if (unused) highlight(unused.pts, '#ffd21f', 9)
        if (sel?.collection === 'connections') for (const piece of drawn.connections.get(sel.id) ?? []) highlight(piece.pts, '#ffd21f', piece.weight + 6)

        // Waypoint handles of the path being edited: click one to select it, drag it to move it.
        if (mode === 'editWaypoints' && wp) recordById(doc.paths, wp.pathId)?.waypoints.forEach((w, i) => {
            const icon = L.divIcon({className: '', html: `<div class="map-vertex ${wp.selected === i ? 'selected' : ''}" title="waypoint ${i + 1}"></div>`, iconSize: [14, 14], iconAnchor: [7, 7]})
            const m = L.marker(toLatLng(w), {icon, draggable: true, zIndexOffset: 1000})
            m.on('click', ev => {
                L.DomEvent.stopPropagation(ev)
                updateWp({selected: i})
            })
            m.on('dragend', () => {
                const ll = m.getLatLng()
                const current = editedPath()
                if (!current) return
                if (setPath(current.waypoints.map((q, k) => k === i ? {latitude: Number(ll.lat.toFixed(6)), longitude: Number(ll.lng.toFixed(6))} : q))) updateWp({selected: i})
            })
            m.addTo(layer)
        })
    }, [currentDraft, updateWp, editedPath, setPath])

    /** Keeps the selected record and the path being edited drawn when the toggles would leave them out (`keep`). */
    const syncKeep = useCallback(() => {
        const hidden = drawnRef.current.hidden
        const next = [...new Set([edRef.current.selection?.id, wpRef.current?.pathId])].filter((id): id is string => !!id && hidden.has(id)).join(' ')
        setKeep(prev => prev === next ? prev : next)
    }, [])

    // Create the map once. The view (centre + zoom) the network was last shown at is restored; otherwise the first draw fits the sites.
    useEffect(() => {
        if (!containerRef.current || mapRef.current) return
        const networkId = edRef.current.doc.id
        const saved = loadMapView(networkId)
        const map = L.map(containerRef.current, {zoomControl: true}).setView(saved?.center ?? [13.75, 100.5], saved?.zoom ?? 6)
        if (saved) fitted.current = true
        map.on('moveend', () => saveMapView(networkId, map))
        tileRef.current = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        })
        if (featuresRef.current.baseMap) tileRef.current.addTo(map)
        // Junction areas sit under the lines (overlayPane is 400) and above the tiles.
        map.createPane('junctionAreas').style.zIndex = '390'
        // The selection highlights too, above the areas.
        map.createPane('highlights').style.zIndex = '395'
        layerRef.current = L.layerGroup().addTo(map)
        overlayRef.current = L.layerGroup().addTo(map)
        map.on('click', e => onMapClick(e.latlng))
        // Drafting a path, circuit or line: a right-click on (or next to) a picked site or junction, or on its label, takes it out.
        map.on('contextmenu', e => {
            const key = pickedDrawnAt(e.originalEvent)
            if (key && dropDrawn(key)) L.DomEvent.preventDefault(e.originalEvent)
        })
        map.on('zoomend', () => setZoomTick(t => t + 1))
        mapRef.current = map
        setTimeout(() => map.invalidateSize(), 0)
        return () => {
            map.remove()
            mapRef.current = null
            layerRef.current = null
            overlayRef.current = null
            tileRef.current = null
        }
    }, [onMapClick])

    // Site circles and junction areas follow their toggles: classes on the map container, nothing drawn again.
    useEffect(() => {
        containerRef.current?.classList.toggle('no-site-circles', !features.siteCircles)
        containerRef.current?.classList.toggle('no-junction-areas', !features.junctions)
    }, [features.siteCircles, features.junctions])

    // The base map follows its toggle.
    useEffect(() => {
        const map = mapRef.current, tiles = tileRef.current
        if (!map || !tiles) return
        if (features.baseMap && !map.hasLayer(tiles)) tiles.addTo(map)
        if (!features.baseMap && map.hasLayer(tiles)) tiles.remove()
    }, [features.baseMap])

    // The network drawing: drawn again when the network, the zoom or a toggle changes (or a record left out is kept, see
    // `keep`); the selection, the mode and the drafts only change the overlay drawn over it (`drawOverlay`).
    useEffect(() => {
        const map = mapRef.current
        const layer = layerRef.current
        if (!map || !layer) return
        layer.clearLayers()
        const kept = new Set(keep.split(' ').filter(Boolean))
        /** What the toggles leave out, kept or not (`Drawn.hidden`). */
        const hidden = new Set<string>()
        // "Planned" off: planned circuits are left out of the drawing (and of the lane spread); planned sites and connections are skipped below.
        // "Below 500 kV" / "Below 230 kV" off: circuits running below that voltage (energized, else rated; unknown voltages stay)
        // are left out, and so are sites without a yard at that voltage or higher (sites without yards too), unless a circuit
        // still drawn ends there ("Below 500 kV" off hides below 230 kV too); "Planned" off: planned circuits.
        const floorKv = !features.below500 ? 500 : !features.lowVoltage ? 230 : 0
        const lowCircuit = (c: TransmissionCircuitRecord) => {
            // a de-energized circuit (0 V) counts by its rated voltage
            const v = c.energizedVoltage === TransmissionVoltage.DE_ENERGIZED ? c.voltage : c.energizedVoltage ?? c.voltage
            return floorKv > 0 && !!v && v !== TransmissionVoltage.DE_ENERGIZED && voltageKv(v) < floorKv
        }
        const shown = features.planned && !floorKv ? ed.doc : {...ed.doc, circuits: ed.doc.circuits.filter(c => (features.planned || !c.planned) && !lowCircuit(c))}
        const shownCircuits = new Set(shown.circuits.map(c => c.id))
        // the sites a circuit still drawn ends at (one of their yards, or their site junction): drawn, so no line ends in nothing
        const sitesWithCircuits = new Set<string>()
        if (floorKv) for (const conn of ed.doc.connections) {
            if (conn.scope !== ConnectionScope.TRANSMISSION || !conn.nodes.some(n => n.kind === NetworkNodeKind.TRANSMISSION_CIRCUIT && shownCircuits.has(n.id))) continue
            const site = siteOfRef(ed.doc, conn.junction)
            if (site) sitesWithCircuits.add(site)
        }
        const lowSite = (groupId: string) => floorKv > 0 && !sitesWithCircuits.has(groupId)
            && !yardsOfSite(ed.doc, groupId).some(y => voltageKv(y.voltage) >= floorKv)
        // a line junction whose circuits are all left out goes too (unless kept)
        for (const j of ed.doc.junctions) {
            const ends = connectionsAt(ed.doc, j.id).flatMap(c => c.nodes.filter(n => n.kind === NetworkNodeKind.TRANSMISSION_CIRCUIT).map(n => n.id))
            if (ends.length > 0 && ends.every(id => !shownCircuits.has(id))) hidden.add(j.id)
        }
        const hiddenJunctions = new Set([...hidden].filter(id => !kept.has(id)))
        // Site extensions (`extensionOf`): an extension whose marker would sit within EXTENSION_GROUP_PX of its parent's (zoomed
        // out) is drawn with it: it takes the parent's position, so its other lines run to the parent; its own marker is left out
        // and the parent's label lists it; circuits and paths between the two are left out.
        const groupedInto = new Map<string, string>()
        for (const g of shown.substationGroups) {
            const parent = recordById(shown.substationGroups, g.extensionOf)
            if (parent && map.latLngToContainerPoint(toLatLng(g.coords)).distanceTo(map.latLngToContainerPoint(toLatLng(parent.coords))) < EXTENSION_GROUP_PX) groupedInto.set(g.id, parent.id)
        }
        // A line junction whose circle would run into the marker of a site it is linked to by a straight path (zoomed out, e.g.
        // BKI_JT1 1.4 km from BKI) is drawn as part of that site too: at its position, without circle and connectors, the path
        // between them left out. Sizes are estimated here: the circle's radius is the width of the widest bundle running in
        // (as drawn below), the site's marker its size class at this zoom.
        {
            const detailNow = mapDetailScale(map.getZoom())
            const spacing = PARALLEL_SPACING_PX * detailNow
            const pathsAt = (id: string) => pathsEndingAt(shown, id)
            const lanes = (pathId: string) => circuitsOnPath(shown, pathId).length
            for (const j of shown.junctions) {
                if (j.groupId || hiddenJunctions.has(j.id)) continue
                const at = pathsAt(j.id)
                const widest = Math.max(0, ...at.map(p => lanes(p.id)))
                const radius = Math.max(JUNCTION_RING_MIN_PX * detailNow, widest ? (Math.min(widest, MAX_PARALLEL) - 1) * spacing + circuitWeight(4) : 0)
                const jPx = map.latLngToContainerPoint(toLatLng(j.coords))
                let best: { site: string; gap: number } | undefined
                for (const p of at) {
                    if (p.waypoints.length) continue
                    const other = p.from?.id === j.id ? p.to : p.from
                    const site = siteOfRef(shown, other)
                    const g = site ? recordById(shown.substationGroups, groupedInto.get(site) ?? site) : undefined
                    if (!g) continue
                    const siteRadius = Math.max(SITE_MARKER_MIN_PX, SITE_MARKER_PX[siteSize(ed.doc, g.id).size] * detailNow) / 2
                    const gap = jPx.distanceTo(map.latLngToContainerPoint(toLatLng(g.coords))) - radius - siteRadius
                    if (gap < JUNCTION_SITE_GAP_PX && (!best || gap < best.gap)) best = {site: g.id, gap}
                }
                if (best) groupedInto.set(j.id, best.site)
            }
        }
        /** The site a site (or a line junction drawn with a site) is drawn as. */
        const siteRoot = (id: string) => groupedInto.get(id) ?? id
        const doc = groupedInto.size ? groupedView(shown, groupedInto) : shown
        const draggable = modeRef.current === 'select'
        const drawn: Drawn = {
            ...emptyDrawn(),
            drawnAs: (place: string) => place.startsWith('G:') ? `G:${siteRoot(place.slice(2))}` : groupedInto.has(place.slice(2)) ? `G:${groupedInto.get(place.slice(2))}` : place,
            hidden,
            draggable,
        }
        drawnRef.current = drawn
        const lineNamesByCircuit = new Map<string, string[]>()
        for (const l of doc.lines) for (const id of l.circuitIds) lineNamesByCircuit.set(id, [...(lineNamesByCircuit.get(id) ?? []), l.name])
        // Circuits sharing a path are spread sideways: index within the (name-sorted) group decides the offset. Circuits
        // without a path are grouped by the places their two ends are attached at.
        const placeKey = (c: TransmissionCircuitRecord, end: string) => {
            const at = endLocation(doc, c.id, end as CircuitEnd)
            return at ? `${at.coords.latitude.toFixed(5)},${at.coords.longitude.toFixed(5)}` : undefined
        }
        const laneGroup = (c: TransmissionCircuitRecord) => {
            if (c.pathId) return c.pathId
            const a = placeKey(c, CIRCUIT_END_FROM), b = placeKey(c, CIRCUIT_END_TO)
            return a && b ? `no-path:${[a, b].sort().join('|')}` : `no-path:${c.id}`
        }
        const siblingsByPath = new Map<string, string[]>()
        for (const c of [...doc.circuits].sort((a, b) => a.name.localeCompare(b.name))) {
            const key = laneGroup(c)
            siblingsByPath.set(key, [...(siblingsByPath.get(key) ?? []), c.id])
        }
        // Lanes follow the tower (towerLayout.ts): group 1 in the middle, the next groups outwards, circuit 1 left of the path's
        // direction. A path whose circuits set tower positions keeps them; the others are only a starting order that
        // layoutLanes may change so connectors do not cross.
        const towerPos = new Map<string, Map<string, number>>()
        const pinnedPaths = new Set<string>()
        for (const [key, ids] of siblingsByPath) {
            const circuits = ids.map(id => recordById(doc.circuits, id)!).filter(Boolean)
            const pos = towerLanePositions(circuits)
            siblingsByPath.set(key, [...ids].sort((a, b) => (pos.get(a) ?? 0) - (pos.get(b) ?? 0)))
            if (!key.startsWith('no-path:') && hasTowerHints(circuits)) {
                towerPos.set(key, pos)
                pinnedPaths.add(key)
            }
        }
        // paths without circuits: dashed grey route so they stay visible and selectable (toggle "Paths without circuits"; the selected
        // or edited one is always drawn, see `keep`)
        for (const p of doc.paths) {
            if (circuitsOnPath(ed.doc, p.id).length) continue
            if (!features.unusedPaths || [p.from, p.to].some(r => { const site = siteOfRef(ed.doc, r); return !!site && lowSite(site) })) {
                hidden.add(p.id)
                if (!kept.has(p.id)) continue
            }
            const pf = locationOfRef(doc, p.from), pt = locationOfRef(doc, p.to)
            const pts: L.LatLngExpression[] = []
            if (pf) pts.push(toLatLng(pf.coords))
            for (const w of p.waypoints) pts.push(toLatLng(w))
            if (pt) pts.push(toLatLng(pt.coords))
            if (pts.length === 0) continue
            // A path with a single point (one end, no waypoints) is a small dashed ring there, still selectable.
            if (pts.length === 1) {
                const ring = L.circleMarker(pts[0], {radius: 7, color: '#8b949e', weight: 2, dashArray: '3 3', fill: true, fillOpacity: 0})
                ring.bindTooltip(`${p.name} · no circuits · only one end`, {sticky: true, className: 'map-label'})
                ring.on('click', e => {
                    L.DomEvent.stopPropagation(e)
                    if (modeRef.current === 'select') edRef.current.select({collection: 'paths', id: p.id})
                })
                ring.addTo(layer)
                drawn.unusedPaths.set(p.id, {pts: [ring.getLatLng()], ring})
                continue
            }
            const line = L.polyline(pts, {color: '#8b949e', weight: 2.5, opacity: .9, dashArray: '8 6'})
            line.bindTooltip(`${p.name} · no circuits`, {sticky: true, className: 'map-label'})
            line.on('click', e => {
                L.DomEvent.stopPropagation(e)
                if (modeRef.current === 'select') edRef.current.select({collection: 'paths', id: p.id})
                else if (modeRef.current === 'editWaypoints' && wpRef.current?.pathId === p.id && wpRef.current.adding) onMapClick(e.latlng)
                else if (modeRef.current === 'splitPath') onMapClick(e.latlng)
            })
            line.addTo(layer)
            drawn.unusedPaths.set(p.id, {pts: line.getLatLngs() as L.LatLng[]})
        }

        // Junctions that are not part of a site: circuit lanes stop at the edge of the junction's area, their "ports", and the
        // connections there are drawn inside it, so it shows which circuit ends are joined.
        const ringJunctions = new Map(doc.junctions.filter(j => !j.groupId && !hiddenJunctions.has(j.id) && !groupedInto.has(j.id)).map(j => [j.id, j]))
        const connByEnd = new Map<string, ConnectionRecord>()
        for (const conn of doc.connections) {
            if (conn.scope !== ConnectionScope.TRANSMISSION) continue
            for (const n of conn.nodes) if (n.kind === NetworkNodeKind.TRANSMISSION_CIRCUIT) connByEnd.set(`${n.id}:${n.terminal}`, conn)
        }
        /** The ring a circuit end runs into: the junction it is connected at, else (a loose end) the junction its path ends at. */
        const ringOf = (circuitId: string, end: string, route?: TransmissionPathRecord): string | undefined => {
            const conn = connByEnd.get(`${circuitId}:${end}`)
            const ref = conn ? conn.junction : end === CIRCUIT_END_FROM ? route?.from : route?.to
            return ref?.kind === ConnectionJunctionKind.TRANSMISSION_JUNCTION && ringJunctions.has(ref.id) ? ref.id : undefined
        }
        // Zoomed out, sites and the spacing of parallel lanes shrink together, so a smaller site still covers its lanes.
        const detail = mapDetailScale(map.getZoom())
        /**
         * A circuit's route: its attached ends (a loose end falls back to its path's end, so detached circuits stay visible)
         * and the path's waypoints. Worked out once per drawing.
         */
        const routes = new Map<string, { route?: TransmissionPathRecord; pts: L.LatLngExpression[]; looseEnd: boolean }>()
        const circuitRoute = (c: TransmissionCircuitRecord) => {
            const known = routes.get(c.id)
            if (known) return known
            const route = recordById(doc.paths, c.pathId)
            const fromEnd = endLocation(doc, c.id, CIRCUIT_END_FROM), toEnd = endLocation(doc, c.id, CIRCUIT_END_TO)
            const from = fromEnd ?? locationOfRef(doc, route?.from)
            const to = toEnd ?? locationOfRef(doc, route?.to)
            const pts: L.LatLngExpression[] = []
            if (from) pts.push(toLatLng(from.coords))
            for (const p of route?.waypoints ?? []) pts.push(toLatLng(p))
            if (to) pts.push(toLatLng(to.coords))
            const out = {route, pts, looseEnd: !fromEnd || !toEnd}
            routes.set(c.id, out)
            return out
        }
        const {order: laneOrder, shift: laneShift} = layoutLanes(doc, siblingsByPath, ringJunctions, connByEnd, ringOf, laneGroup,
            c => circuitRoute(c).pts.map(ll => map.latLngToLayerPoint(L.latLng(ll))), pinnedPaths, (key, id) => towerPos.get(key)?.get(id))
        /** Sideways offset of a circuit's lane on its path (px; positive = left of the path's direction), see `layoutLanes`. */
        const laneOffset = (c: TransmissionCircuitRecord) => {
            const key = laneGroup(c)
            const pinnedPos = towerPos.get(key)?.get(c.id)
            if (pinnedPos !== undefined) return ((laneShift.get(key) ?? 0) + pinnedPos) * PARALLEL_SPACING_PX * detail
            const order = laneOrder.get(key) ?? [c.id]
            const lanes = Math.min(order.length, MAX_PARALLEL)
            const lane = Math.min(order.indexOf(c.id), MAX_PARALLEL - 1)
            return ((laneShift.get(key) ?? 0) + lane - (lanes - 1) / 2) * PARALLEL_SPACING_PX * detail
        }
        // Zoomed far out the lanes of a path run into each other (from where the widest lines, 4-conductor bundles, would
        // touch): the circuits of a path are then drawn as one line per voltage (planned ones apart), side by side, as wide as
        // their own widths added up divided by 4, at least 1 px and at most a 4-bundle line.
        const mergeLanes = PARALLEL_SPACING_PX * detail < circuitWeight(4)
        // The few zoom levels just above that, lanes are drawn but still close: circuits are drawn thinner there, from half
        // their width on the first level after merging up to full width (THIN_ZOOM_LEVELS levels in all).
        const thin = laneWidthFactor(map.getZoom())
        /** What one polyline draws: a circuit, or (merged) the circuits of a path at one voltage. */
        interface DrawUnit { circuits: TransmissionCircuitRecord[]; weight: number; offset: number }
        const units: DrawUnit[] = []
        const unitOf = new Map<string, DrawUnit>()
        if (mergeLanes) {
            const perPath = new Map<string, Map<string, TransmissionCircuitRecord[]>>()
            for (const c of doc.circuits) {
                const groups = perPath.get(laneGroup(c)) ?? perPath.set(laneGroup(c), new Map()).get(laneGroup(c))!
                const key = `${c.energizedVoltage ?? c.voltage ?? ''}|${c.planned ? 'planned' : ''}`
                groups.set(key, [...(groups.get(key) ?? []), c])
            }
            for (const groups of perPath.values()) {
                const list = [...groups.values()].sort((a, b) => voltageKv(b[0].energizedVoltage ?? b[0].voltage) - voltageKv(a[0].energizedVoltage ?? a[0].voltage) || Number(!!a[0].planned) - Number(!!b[0].planned))
                const widths = list.map(cs => Math.min(circuitWeight(4), Math.max(1, cs.reduce((s, c) => s + circuitWeight(c.bundle), 0) / 4)))
                let at = -widths.reduce((s, w) => s + w, 0) / 2
                list.forEach((cs, i) => {
                    const unit = {circuits: cs, weight: widths[i], offset: at + widths[i] / 2}
                    at += widths[i]
                    units.push(unit)
                    for (const c of cs) unitOf.set(c.id, unit)
                })
            }
        } else for (const c of doc.circuits) {
            const unit = {circuits: [c], weight: circuitWeight(c.bundle) * thin, offset: laneOffset(c)}
            units.push(unit)
            unitOf.set(c.id, unit)
        }
        /** Sideways offset (px) and width (px) a circuit is drawn with, merged or not. */
        const offsetOf = (c: TransmissionCircuitRecord) => unitOf.get(c.id)?.offset ?? laneOffset(c)
        const weightOf = (c: TransmissionCircuitRecord) => unitOf.get(c.id)?.weight ?? circuitWeight(c.bundle)
        // Site cover: how far the lanes running into a site reach from its centre (outermost lane edge, px); the site
        // marker is drawn at least that wide so the lane ends sit under it.
        const siteCover = new Map<string, number>()
        for (const c of doc.circuits) {
            const route = recordById(doc.paths, c.pathId)
            const reach = Math.abs(offsetOf(c)) + weightOf(c) / 2
            for (const end of [CIRCUIT_END_FROM, CIRCUIT_END_TO]) {
                const conn = connByEnd.get(`${c.id}:${end}`)
                const ref = conn ? conn.junction : end === CIRCUIT_END_FROM ? route?.from : route?.to
                const siteId = !ref ? undefined
                    : ref.kind === ConnectionJunctionKind.SUBSTATION_GROUP ? ref.id
                        : ref.kind === ConnectionJunctionKind.SUBSTATION ? recordById(doc.substations, ref.id)?.groupId
                            : groupedInto.get(ref.id) ?? recordById(doc.junctions, ref.id)?.groupId
                if (siteId) siteCover.set(siteRoot(siteId), Math.max(siteCover.get(siteRoot(siteId)) ?? 0, reach))
            }
        }
        // Junction areas: a circle around the junction, just wide enough for every lane running in to reach it (the outer edge
        // of the outermost lane, plus a pixel); the lanes stop on it and the connections are drawn inside, the circle growing
        // where they need more room (layoutJunction).
        const areaRadius = new Map<string, number>()
        for (const j of ringJunctions.values()) areaRadius.set(j.id, JUNCTION_RING_MIN_PX * detail)
        for (const c of doc.circuits) {
            const route = recordById(doc.paths, c.pathId)
            const reach = Math.abs(offsetOf(c)) + weightOf(c) / 2 + 1
            for (const end of [CIRCUIT_END_FROM, CIRCUIT_END_TO]) {
                const jid = ringOf(c.id, end, route)
                if (jid) areaRadius.set(jid, Math.max(areaRadius.get(jid)!, reach))
            }
        }
        // Connections drawn inside the junction circles (toggle "Planned" hides planned ones), each with its circuit ends.
        const drawnConnections = doc.connections.filter(conn => conn.scope === ConnectionScope.TRANSMISSION && conn.junction.kind === ConnectionJunctionKind.TRANSMISSION_JUNCTION
            && ringJunctions.has(conn.junction.id) && (features.planned || !conn.planned))
        const drawnConnectionsAt = new Map<string, ConnectionRecord[]>()
        for (const conn of drawnConnections) {
            const at = drawnConnectionsAt.get(conn.junction.id)
            if (at) at.push(conn)
            else drawnConnectionsAt.set(conn.junction.id, [conn])
        }
        const endKeys = (conn: ConnectionRecord) => conn.nodes.filter(n => n.kind === NetworkNodeKind.TRANSMISSION_CIRCUIT).map(n => `${n.id}:${n.terminal}`)
        // Each junction's circle and connectors (layoutJunction): parallel connectors keep the lane spacing, and the circle
        // grows where they, or the lanes of different paths, would otherwise touch. Merged far out there are no connectors.
        const junctionDrawings = new Map<string, JunctionDrawing>()
        if (!mergeLanes) {
            const arrivalsAt = new Map<string, JunctionArrival[]>()
            for (const unit of units) {
                const c = unit.circuits[0]
                const {route, pts} = circuitRoute(c)
                if (pts.length < 2) continue
                const px = offsetPoints(pts.map(ll => map.latLngToLayerPoint(L.latLng(ll))), unit.offset)
                for (const end of [CIRCUIT_END_FROM, CIRCUIT_END_TO]) {
                    const jid = ringOf(c.id, end, route)
                    if (jid) arrivalsAt.set(jid, [...(arrivalsAt.get(jid) ?? []), {key: `${c.id}:${end}`, group: laneGroup(c), px: end === CIRCUIT_END_FROM ? px : [...px].reverse(), weight: unit.weight}])
                }
            }
            for (const [jid, arrivals] of arrivalsAt) {
                const center = map.latLngToLayerPoint(toLatLng(ringJunctions.get(jid)!.coords))
                const conns = (drawnConnectionsAt.get(jid) ?? []).map(c => ({id: c.id, keys: endKeys(c)}))
                // zoomed out (lanes not at full spacing) the circle keeps its size: connectors may overlap there
                const fit = layoutJunction(center, areaRadius.get(jid)!, arrivals, conns, PARALLEL_SPACING_PX * detail, detail >= 1)
                areaRadius.set(jid, fit.radius)
                for (const [id, d] of fit.drawings) junctionDrawings.set(id, d)
            }
        }
        const ports = new Map<string, RingPort>()

        // circuits (merged far out: one line per path and voltage, see mergeLanes)
        for (const unit of units) {
            const c = unit.circuits[0]
            const merged = unit.circuits.length > 1
            const {route, pts} = circuitRoute(c)
            const looseEnd = unit.circuits.some(x => circuitRoute(x).looseEnd)
            const weight = unit.weight
            // A planned circuit is dotted (round dots, spaced by the line weight) in a dull version of its voltage colour.
            const color = c.planned ? plannedVoltageColor(c.energizedVoltage ?? c.voltage) : voltageColor(c.energizedVoltage ?? c.voltage)
            if (pts.length < 2) {
                // Without a path a circuit attached at one end only cannot be drawn: a ⚠ at that end points it out.
                if (!route && pts.length === 1) {
                    const icon = L.divIcon({className: '', html: `<div class="map-circuit-alert" style="border-color:${color}">⚠</div>`, iconSize: [18, 18], iconAnchor: [9, 22]})
                    const alert = L.marker(pts[0], {icon, zIndexOffset: 500})
                    alert.bindTooltip(`${c.name} · no path and only one end attached`, {className: 'map-label'})
                    alert.on('click', e => {
                        L.DomEvent.stopPropagation(e)
                        if (modeRef.current === 'select') edRef.current.select({collection: 'circuits', id: c.id})
                    })
                    alert.addTo(layer)
                }
                continue
            }
            let px = offsetPoints(pts.map(ll => map.latLngToLayerPoint(L.latLng(ll))), unit.offset)
            // Ends at a junction stop on its circle; the crossing is the port its connection is drawn from. Merged lines run
            // into the junction's centre instead (no connectors that far out).
            if (!mergeLanes) for (const end of [CIRCUIT_END_FROM, CIRCUIT_END_TO]) {
                const jid = ringOf(c.id, end, route)
                if (!jid) continue
                const center = map.latLngToLayerPoint(toLatLng(ringJunctions.get(jid)!.coords))
                const cut = trimStartAtCircle(end === CIRCUIT_END_FROM ? px : [...px].reverse(), center, areaRadius.get(jid)!)
                if (!cut) continue
                px = end === CIRCUIT_END_FROM ? cut.points : [...cut.points].reverse()
                ports.set(`${c.id}:${end}`, {point: cut.port, dir: cut.dir, color, weight, junctionId: jid})
            }
            const drawPts = px.map(pt => map.layerPointToLatLng(pt))
            drawn.units.push({pts: drawPts, weight, circuitIds: unit.circuits.map(x => x.id), pathId: c.pathId})
            const lineNames = merged ? undefined : lineNamesByCircuit.get(c.id)
            // Drawn in the colour of the voltage the circuit is energized at; when that differs from its rated voltage a dotted overlay in the rated colour shows the difference.
            const reVolted = !merged && !!c.energizedVoltage && !!c.voltage && c.energizedVoltage !== c.voltage && !c.planned
            // Dashes: a circuit without a path runs straight between its attached ends (long dashes); a loose end falls back
            // to its path's end (short dashes); planned stays dotted.
            const line = L.polyline(drawPts, {
                color, weight, opacity: .9,
                dashArray: c.planned ? `1 ${weight * 2 + 3}` : !route ? '12 7' : looseEnd ? '6 6' : undefined, lineCap: c.planned ? 'round' : undefined,
            })
            if (merged) line.bindTooltip(`${unit.circuits.length} circuits · ${esc(c.energizedVoltage ?? c.voltage ?? 'no voltage')}${c.planned ? ' · planned' : ''}${route ? ` · ${esc(route.name)}` : ' · no path'}<br>${unit.circuits.map(x => esc(x.name)).join('<br>')}`, {sticky: true, className: 'map-label'})
            else line.bindTooltip(`${c.name}${c.planned ? ' · planned' : ''}${c.voltage ? ` · ${c.voltage}` : ''}${reVolted ? ` · energized ${c.energizedVoltage}` : ''}${c.bundle ? ` · ${c.bundle}x` : ''}${route ? ` · ${route.name}` : ' · no path'}${lineNames ? ` · line ${lineNames.join(', ')}` : ' · ⚠ no line'}`, {sticky: true, className: 'map-label'})
            line.on('click', e => {
                L.DomEvent.stopPropagation(e)
                if (modeRef.current === 'select') edRef.current.select(route ? {collection: 'paths', id: route.id} : {collection: 'circuits', id: c.id})
                else if (route && modeRef.current === 'editWaypoints' && wpRef.current?.pathId === route.id && wpRef.current.adding) {
                    onMapClick(e.latlng)
                } else if (route && modeRef.current === 'splitPath') onMapClick(e.latlng)
            })
            line.addTo(layer)
            if (reVolted) L.polyline(drawPts, {color: voltageColor(c.voltage), weight, opacity: .95, dashArray: '1 9', lineCap: 'round', interactive: false}).addTo(layer)
        }

        /** A click on a junction (its area, a connector inside it or its handle): picks it as an end, or selects it. */
        const clickJunction = (jid: string) => {
            if (modeRef.current === 'addLine') changeLineDraft(lineDraftJunctionClick(lineDraftRef.current, jid))
            else if (modeRef.current === 'addCircuit') setDraft(d => pickDraftEnd(d, `J:${jid}`))
            else if (modeRef.current === 'addPath') setPathDraft(d => pickDraftEnd(d, `J:${jid}`))
            else if (modeRef.current === 'select') edRef.current.select({collection: 'junctions', id: jid})
        }
        /** A right-click on a junction: in "+ Line" mode takes it out of the line again, in "+ Path" / "+ Circuit" mode out of the ends. */
        const rightClickJunction = (jid: string) => dropDrawn(`J:${jid}`)
        /** Hovering a layer drawn for a junction (area, connector, stub, handle) shows its area, also while the areas are off. */
        const hoverShowsArea = (l: L.Layer, jid: string) => {
            l.on('mouseover', () => drawn.areas.get(jid)?.getElement()?.classList.add('hovered'))
            l.on('mouseout', () => drawn.areas.get(jid)?.getElement()?.classList.remove('hovered'))
        }
        /** Binds the junction's click, right-click and hover to a layer drawn for it (area, connector, stub). */
        const onJunction = (l: L.Layer, jid: string) => {
            l.on('click', e => {
                L.DomEvent.stopPropagation(e)
                clickJunction(jid)
            })
            l.on('contextmenu', e => {
                L.DomEvent.stop(e)
                rightClickJunction(jid)
            })
            hoverShowsArea(l, jid)
        }
        const toLL = (pts: L.Point[]) => pts.map(pt => map.layerPointToLatLng(pt))

        // The junction areas: the circle the lanes stop on, in a pane under the lines (toggle "Junction areas" off: hidden by
        // the class no-junction-areas, unless hovered, selected or picked).
        for (const j of ringJunctions.values()) {
            const area = L.circleMarker(toLatLng(j.coords), {radius: areaRadius.get(j.id)!, pane: 'junctionAreas', className: 'junction-area', ...AREA_STYLE, fillColor: JUNCTION_COLOR, fillOpacity: JUNCTION_FILL_OPACITY})
            area.bindTooltip(esc(j.name ?? j.id), {sticky: true, className: 'map-label'})
            onJunction(area, j.id)
            area.addTo(layer)
            drawn.areas.set(j.id, area)
        }

        // Inside the junctions (layoutJunction): a connection joining two circuit ends is one connector between their ports,
        // straight or with two bends of at most 90° each, parallel connectors keeping the lane spacing; one joining three or
        // more is a spoke from each port to a dot (lines crossing without a dot are not joined); a circuit end with no
        // connection is a short stub ending in an open circle. Clicking any of them selects the junction (its panel lists the
        // connections), also while the areas are hidden; a connection selected in the panel is highlighted here.
        const circuitName = (id: string) => recordById(doc.circuits, id)?.name ?? id
        const joined = new Set<string>()
        for (const conn of drawnConnections) {
            const keys = endKeys(conn)
            keys.forEach(k => joined.add(k))
            const drawing = junctionDrawings.get(conn.id)
            const pieces = (drawing?.lines ?? []).map(l => ({pts: l.pts, port: ports.get(l.key)})).filter((p): p is { pts: L.Point[]; port: RingPort } => !!p.port)
            if (!pieces.length) continue
            const tip = `${esc(conn.name ?? conn.id)}${conn.planned ? ' · planned' : ''} · ${keys.map(k => esc(circuitName(k.slice(0, k.lastIndexOf(':'))))).join(' + ')}`

            const drawnPieces: { pts: L.LatLng[]; weight: number }[] = []
            for (const piece of pieces) {
                const ll = toLL(piece.pts)
                drawnPieces.push({pts: ll, weight: piece.port.weight})
                const line = L.polyline(ll, {color: piece.port.color, weight: piece.port.weight, opacity: .95, lineCap: 'round', dashArray: conn.planned ? `1 ${piece.port.weight * 2 + 3}` : undefined})
                line.bindTooltip(tip, {sticky: true, className: 'map-label'})
                onJunction(line, conn.junction.id)
                line.addTo(layer)
            }
            drawn.connections.set(conn.id, drawnPieces)
            if (drawing?.dot) {
                const node = L.circleMarker(map.layerPointToLatLng(drawing.dot), {radius: Math.max(3, pieces[0].port.weight / 2 + 1.5), stroke: false, fillColor: pieces[0].port.color, fillOpacity: 1})
                node.bindTooltip(tip, {sticky: true, className: 'map-label'})
                onJunction(node, conn.junction.id)
                node.addTo(layer)
            }
        }
        for (const [key, p] of ports) {
            if (joined.has(key)) continue
            const tip = L.point(p.point.x + p.dir.x * 6, p.point.y + p.dir.y * 6)
            const stub = L.polyline(toLL([p.point, tip]), {color: p.color, weight: p.weight, opacity: .95})
            onJunction(stub, p.junctionId)
            stub.addTo(layer)
            L.circleMarker(map.layerPointToLatLng(tip), {radius: 2.5, color: p.color, weight: 1.5, fill: false, interactive: false}).addTo(layer)
        }

        /**
         * A site / junction marker. `label` is shown permanently when `showLabel` is set, otherwise only `hoverHtml` (on
         * mouseover, put together then) reveals what is there. `iconHtml` replaces the round marker (junction rings).
         */
        const marker = (coords: CoordinatesProps, cls: string, text: string, size: number, label: string, onClick: () => void, onDrag: (c: CoordinatesProps) => void, hoverHtml?: () => string, showLabel = true,
                        iconHtml?: { html: string; className: string }, onRightClick?: () => void) => {
            const icon = L.divIcon({className: iconHtml?.className ?? '', html: iconHtml?.html ?? `<div class="map-marker ${cls}">${text}</div>`, iconSize: [size, size], iconAnchor: [size / 2, size / 2]})
            const m = L.marker(toLatLng(coords), {icon, draggable})
            // A hidden label still appears while hovering.
            m.bindTooltip(label, markerLabel(size, showLabel))
            if (hoverHtml) {
                let popup: L.Popup | undefined
                const close = () => {
                    if (popup) map.closePopup(popup)
                }
                m.on('mouseover', () => {
                    if (!popup) popup = L.popup({closeButton: false, autoPan: false, offset: [0, -size / 2], className: 'map-popup'})
                    popup.setContent(hoverHtml()).setLatLng(m.getLatLng()).openOn(map)
                })
                m.on('mouseout', close)
                m.on('dragstart', close)
            }
            m.on('click', e => {
                L.DomEvent.stopPropagation(e)
                onClick()
            })
            if (onRightClick) m.on('contextmenu', e => {
                L.DomEvent.stop(e)
                onRightClick()
            })
            m.on('dragend', () => {
                const ll = m.getLatLng()
                onDrag({latitude: Number(ll.lat.toFixed(6)), longitude: Number(ll.lng.toFixed(6))})
            })
            m.addTo(layer)
            const drawnMarker: DrawnMarker = {marker: m, label, size, permanent: showLabel}
            return drawnMarker
        }

        // Sites are sized by what is inside them; when two are drawn too close, the smaller one's label gives way (it still shows on hover).
        // a site's size comes from the whole network, whatever the toggles leave out of the drawing
        const sized = doc.substationGroups.filter(g => !groupedInto.has(g.id)).map(g => ({g, ...siteSize(ed.doc, g.id), px: map.latLngToContainerPoint(toLatLng(g.coords))}))
        const LABEL_CLEARANCE_PX = 48
        const outranked = new Set<string>()
        // each site against those in its cell of a LABEL_CLEARANCE_PX grid and the cells around it (no others are that close)
        const cellOf = (px: L.Point) => [Math.floor(px.x / LABEL_CLEARANCE_PX), Math.floor(px.y / LABEL_CLEARANCE_PX)]
        const cells = new Map<string, typeof sized>()
        for (const s of sized) {
            const [cx, cy] = cellOf(s.px)
            const at = cells.get(`${cx},${cy}`)
            if (at) at.push(s)
            else cells.set(`${cx},${cy}`, [s])
        }
        for (const a of sized) {
            const [cx, cy] = cellOf(a.px)
            for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const b of cells.get(`${cx + dx},${cy + dy}`) ?? []) {
                if (a === b) continue
                if (Math.hypot(a.px.x - b.px.x, a.px.y - b.px.y) > LABEL_CLEARANCE_PX) continue
                const rankA = SITE_SIZE_RANK[a.size], rankB = SITE_SIZE_RANK[b.size]
                const bWins = rankB > rankA || (rankB === rankA && (b.points > a.points || (b.points === a.points && b.g.id < a.g.id)))
                if (bWins) outranked.add(a.g.id)
            }
        }
        // the extensions drawn with each site
        const groupedSites = new Map<string, SubstationGroupRecord[]>()
        for (const x of doc.substationGroups) {
            const into = groupedInto.get(x.id)
            if (into) groupedSites.set(into, [...(groupedSites.get(into) ?? []), x])
        }
        for (const {g, size, circuits, points} of sized) {
            if ((g.planned && !features.planned) || lowSite(g.id)) {
                hidden.add(g.id)
                if (!kept.has(g.id)) continue
            }
            // selected or picked (the overlay): a grouped extension shows on its parent's marker
            const cls = `site size-${size} ${g.planned ? 'planned' : ''}`
            const yards = [...yardsOfSite(doc, g.id)]
            // Generation site: an icon-sized "G", then (details only) one lettered badge per generation type.
            const genIcons = (site: SubstationGroupRecord) => site.generation
                ? `<span class="map-gen-row"><span class="map-gen-badge" style="background:${GENERATION_SITE_COLOR}" title="Generation site (power plant / producer)">G</span>`
                + (details ? (site.generationTypes ?? []).map(t => {
                    const b = GENERATION_BADGES[t]
                    return b ? `<span class="map-gen-badge" style="background:${b.color}" title="${esc(GENERATION_LABELS[t])}">${esc(b.letter)}</span>` : ''
                }).join('') : '') + `</span>`
                : ''
            // Extensions drawn with this site (zoomed out): one line each below its own, code, yard symbols and generation icons
            // (details: its name too).
            const grouped = [...(groupedSites.get(g.id) ?? [])].sort((a, b) => a.groupName.localeCompare(b.groupName))
            const extensionLines = grouped.map(x => {
                const planned = x.planned || g.planned
                return `<div class="map-site-name map-site-ext"><span>${esc(x.groupName)}</span>${yardSymbols([...yardsOfSite(doc, x.id)], planned)}${genIcons(x)}`
                    + `${details && x.name && x.name !== x.groupName ? `<span class="map-site-title">${esc(x.name)}</span>` : ''}${x.planned ? '<span class="muted">(planned)</span>' : ''}</div>`
            }).join('')
            // One centred line: code, the yards' symbols (compact only), the generation icons. Details add the site name and one line per yard below.
            const label = `<div class="map-site-name"><span>${esc(g.groupName)}</span>${details ? '' : yardSymbols(yards, g.planned)}${genIcons(g)}${g.planned ? '<span class="muted">(planned)</span>' : ''}</div>`
                + (details && g.name && g.name !== g.groupName ? `<div class="map-site-title">${esc(g.name)}</div>` : '')
                + (details ? yardList(yards, g.planned) : '')
                + extensionLines
            // the size class scaled for the zoom, but never narrower than the lanes running in (plus the white rim)
            const cover = siteCover.get(g.id)
            const markerPx = Math.round(Math.max(SITE_MARKER_MIN_PX, SITE_MARKER_PX[size] * detail, cover !== undefined ? 2 * cover + 5 : 0))
            const showSiteLabel = features.labels && !outranked.has(g.id)
            /** The hover summary, put together when the pointer gets there. */
            const summary = () => {
                const sizeNote = `<div class="muted">${size} site · ${circuits} circuit${circuits === 1 ? '' : 's'}, ${points} point${points === 1 ? '' : 's'} (4 per 500 kV, 2 per 230 kV, 1 below)</div>`
                const siteJunction = junctionsOfSite(doc, g.id)[0]
                const junctionNodes = siteJunction ? connectionsAt(doc, siteJunction.id).filter(c => c.junction.kind === 'TRANSMISSION_JUNCTION').length : 0
                const junctionNote = siteJunction ? `<div class="muted">junction <b>${esc(siteJunction.name ?? siteJunction.id)}</b> · ${junctionNodes} node${junctionNodes === 1 ? '' : 's'}</div>` : ''
                const genUnits = generationUnitsOf(doc, g.id)
                const genNote = g.generation ? `<div><span style="color:${GENERATION_SITE_COLOR};font-weight:700">G</span> generation site${(g.generationTypes ?? []).length ? `: ${(g.generationTypes ?? []).map(t => esc(GENERATION_LABELS[t] ?? t)).join(', ')}` : ''}</div>`
                    + (genUnits.length ? `<div class="muted">${genUnits.length} unit${genUnits.length === 1 ? '' : 's'} · <b>${esc(capacityText(genUnits))}</b></div>` : '') : ''
                const parentSite = recordById(doc.substationGroups, g.extensionOf)
                const extensions = extensionsOf(doc, g.id)
                const extensionNote = (parentSite ? `<div class="muted">extension of <b>${esc(parentSite.groupName)}</b></div>` : '')
                    + (extensions.length ? `<div class="muted">extensions: ${extensions.map(x => `<b>${esc(x.groupName)}</b>${x.name && x.name !== x.groupName ? ` ${esc(x.name)}` : ''}`).join(', ')}${grouped.length ? ' (drawn here at this zoom)' : ''}</div>` : '')
                return `<strong>${esc(g.groupName)}${g.name && g.name !== g.groupName ? ` · ${esc(g.name)}` : ''}</strong>` + genNote + extensionNote + (yards.length
                    ? `<table class="map-summary"><tr><th>Yard</th><th>Arrangement</th><th>Buses</th><th>Bays</th><th>Take-offs</th></tr>` + yards.map(y =>
                        `<tr><td>${voltageSymbolSvg(y.voltage, y.planned || g.planned)} <b>${esc(y.yardName)}</b> <span class="muted">${esc(y.voltage)}</span></td><td>${esc(y.arrangement ?? '–')}</td>` +
                        `<td>${ofYard(doc.buses, y.id).length}</td><td>${ofYard(doc.bays, y.id).length}</td>` +
                        `<td>${ofYard(doc.takeOffs, y.id).length}</td></tr>`).join('') + `</table>`
                    : '<div class="muted">No yards yet</div>') + sizeNote + junctionNote
            }
            drawn.markers.set(`G:${g.id}`, marker(g.coords, markerPx < 12 ? `${cls} tiny` : cls, '', markerPx, label, () => {
                if (modeRef.current === 'addLine') changeLineDraft(lineDraftSiteClick(edRef.current.doc, lineDraftRef.current, g.id))
                else if (modeRef.current === 'addCircuit') setDraft(d => pickDraftEnd(d, `G:${g.id}`))
                else if (modeRef.current === 'addPath') setPathDraft(d => pickDraftEnd(d, `G:${g.id}`))
                else if (modeRef.current === 'select') edRef.current.select({collection: 'substationGroups', id: g.id})
            // a right-click takes the site out of the draft, or what is drawn with it (an extension, a junction next to it)
            }, coords => edRef.current.apply(moveSiteOps(edRef.current.doc, g, coords)), summary, showSiteLabel, undefined, () => dropDrawn(`G:${g.id}`)))
        }
        for (const j of doc.junctions) {
            // A site junction is part of its site: the site marker stands for it (the site panel and "+ Circuit" reach it).
            if (j.groupId || hiddenJunctions.has(j.id) || groupedInto.has(j.id)) continue
            const conns = connectionsAt(doc, j.id).filter(c => c.junction.kind === 'TRANSMISSION_JUNCTION')
            const label = `<div class="map-site-name">${esc(j.name ?? j.id)}</div>` + conns.map(c => badge(c.name ?? c.id, c.voltage ?? recordById(doc.circuits, c.nodes[0]?.id)?.voltage)).join('')
            /** The hover summary, put together when the pointer gets there. */
            const summary = () => {
                // Size tier from the busiest path ending here (see junctionSize in mapUtil.ts), named in the hover summary; the symbol has one size.
                const {size: jSize, circuits: jCircuits} = junctionSize(doc, j.id)
                const ends = conns.reduce((n, c) => n + c.nodes.length, 0)
                return `<strong>${esc(j.name ?? j.id)}</strong> <span class="muted">${j.coords.latitude.toFixed(5)}, ${j.coords.longitude.toFixed(5)}</span>` + (conns.length
                    ? `<table class="map-summary"><tr><th>Connection</th><th>Circuit ends</th></tr>` + conns.map(c =>
                        `<tr><td><b>${esc(c.name ?? c.id)}</b>${c.voltage ? `<br><span style="color:${voltageColor(c.voltage)}">${esc(c.voltage)}</span>` : ''}</td><td>${c.nodes.map(n => {
                            const circ = recordById(doc.circuits, n.id)
                            return `<span style="color:${voltageColor(circ?.energizedVoltage ?? circ?.voltage)}">■</span> ${esc(circ?.name ?? n.id)} <span class="muted">${esc(n.terminal ?? '')}</span>`
                        }).join('<br>')}</td></tr>`).join('') + `</table><div class="muted">${conns.length} electrical node${conns.length === 1 ? '' : 's'}, ${ends} circuit end${ends === 1 ? '' : 's'}</div>` + `<div class="muted">${jSize} junction · busiest path ${jCircuits} circuit${jCircuits === 1 ? '' : 's'}</div>`
                    : '<div class="muted">No connections here yet</div>')
            }
            // Junctions stay quiet: the label is shown only while the junction is selected or picked as a circuit end (the
            // overlay); hovering reveals the summary.
            // No symbol: the area (behind the lines) shows the junction; an invisible handle in its middle drags it and shows the summary.
            const handle = marker(j.coords, 'junction', '', JUNCTION_HIT_PX, label, () => clickJunction(j.id),
                coords => edRef.current.apply([{type: 'upsert', collection: 'junctions', record: {...j, coords}}]), summary, false, {html: '<div class="junction-hit"></div>', className: ''}, () => rightClickJunction(j.id))
            hoverShowsArea(handle.marker, j.id)
            drawn.markers.set(`J:${j.id}`, handle)
        }

        // First draw: zoom just enough to cover the sites. Deferred like the invalidateSize above: the container has
        // no reliable size yet, and fitBounds on a too-small map picks a zoom that is far too low.
        if (!fitted.current && doc.substationGroups.length) {
            fitted.current = true
            setTimeout(() => fitSites(map, edRef.current.doc), 0)
        }
        // the overlay on the new drawing; a selected record left out may have to be kept
        drawOverlay()
        syncKeep()
    }, [ed.doc, keep, zoomTick, features.details, features.labels, features.unusedPaths, features.planned, features.lowVoltage, features.below500, changeLineDraft, onMapClick, drawOverlay, syncKeep])

    // The selection, the mode and the drafts change the overlay only; the network drawing stays.
    useEffect(() => {
        drawOverlay()
        syncKeep()
    }, [ed.selection, mode, draft, pathDraft, lineDraft, wp, drawOverlay, syncKeep])

    /** Pans / zooms the map to a selected record. */
    const locate = useCallback((s: Selection) => {
        const map = mapRef.current
        const doc = edRef.current.doc
        if (!map) return
        const pts: L.LatLngExpression[] = []
        const pathPoints = (pathId?: string) => {
            const p = pathId ? doc.paths.find(x => x.id === pathId) : undefined
            if (!p) return
            const pf = locationOfRef(doc, p.from), pt = locationOfRef(doc, p.to)
            if (pf) pts.push(toLatLng(pf.coords))
            for (const w of p.waypoints) pts.push(toLatLng(w))
            if (pt) pts.push(toLatLng(pt.coords))
        }
        switch (s.collection) {
            case 'substationGroups': {
                const g = doc.substationGroups.find(x => x.id === s.id)
                if (g) pts.push(toLatLng(g.coords))
                break
            }
            case 'substations': {
                const y = doc.substations.find(x => x.id === s.id)
                const g = y && doc.substationGroups.find(x => x.id === y.groupId)
                if (g) pts.push(toLatLng(g.coords))
                break
            }
            case 'junctions': {
                const j = doc.junctions.find(x => x.id === s.id)
                if (j) pts.push(toLatLng(j.coords))
                break
            }
            case 'paths':
                pathPoints(s.id)
                break
            case 'circuits': {
                const c = doc.circuits.find(x => x.id === s.id)
                if (!c) break
                const f = endLocation(doc, c.id, CIRCUIT_END_FROM), t = endLocation(doc, c.id, CIRCUIT_END_TO)
                if (f) pts.push(toLatLng(f.coords))
                if (t) pts.push(toLatLng(t.coords))
                pathPoints(c.pathId)
                break
            }
            case 'lines': {
                const l = doc.lines.find(x => x.id === s.id)
                for (const id of l?.circuitIds ?? []) {
                    const c = doc.circuits.find(x => x.id === id)
                    if (!c) continue
                    const f = endLocation(doc, c.id, CIRCUIT_END_FROM), t = endLocation(doc, c.id, CIRCUIT_END_TO)
                    if (f) pts.push(toLatLng(f.coords))
                    if (t) pts.push(toLatLng(t.coords))
                    pathPoints(c.pathId)
                }
                break
            }
            default:
                break
        }
        if (pts.length === 1) map.flyTo(pts[0], Math.max(map.getZoom(), 11))
        else if (pts.length > 1) map.fitBounds(L.latLngBounds(pts).pad(0.25), {maxZoom: 13})
    }, [])

    const fit = () => {
        if (mapRef.current) fitSites(mapRef.current, ed.doc)
    }

    const deleteSelection = () => {
        const sel = ed.selection
        if (!sel || !['substationGroups', 'junctions', 'paths', 'circuits', 'connections', 'lines'].includes(sel.collection)) return
        if (sel.collection === 'lines') {
            // asks whether the circuits, take-offs and connections only this line uses go too
            const ops = confirmDeleteLines(ed.doc, [sel.id])
            if (ops && ed.apply(ops, {confirmedLineIds: [sel.id]})) ed.select(null)
            return
        }
        const label = sel.collection === 'substationGroups' ? 'this site with all its yards and equipment' : sel.collection === 'junctions' ? 'this junction and its connections'
            : sel.collection === 'paths' ? `this path (its ${ed.doc.circuits.filter(c => c.pathId === sel.id).length} circuit(s) stay, drawn dashed without it)` : `this ${sel.collection.slice(0, -1)}`
        // the confirmation names the lines the delete leaves without circuits (removed with it)
        const ops = cascadeDeleteOps(ed.doc, sel.collection, sel.id)
        const lost = linesRemovedBy(ed.doc, ops)
        if (!window.confirm(`Delete ${label}?${linesRemovedNote(lost)}`)) return
        if (ed.apply(ops, {confirmedLineIds: lost.map(l => l.id)})) ed.select(null)
    }

    // Leave waypoint mode when the path disappears or the selection moves to something else.
    useEffect(() => {
        if (mode !== 'editWaypoints' || !wp) return
        const sel = ed.selection
        const stillOnPath = !!sel && ((sel.collection === 'paths' && sel.id === wp.pathId) || (sel.collection === 'circuits' && ed.doc.circuits.find(c => c.id === sel.id)?.pathId === wp.pathId))
        if (!stillOnPath || !ed.doc.paths.some(p => p.id === wp.pathId)) setMode('select')
    }, [mode, wp, ed.selection, ed.doc.circuits, ed.doc.paths, setMode])

    const hint = mode === 'editWaypoints' ? (wp?.adding
            ? `Click on the map where the new waypoint goes (${wp.adding === 'append' ? 'at the end of the route' : wp.adding + ' point ' + ((wp.selected ?? 0) + 1)}). Esc cancels.`
            : wp?.selected === null || wp?.selected === undefined
                ? 'Waypoints: drag a point to move it, click a point to select it, or use "New waypoint" in the panel. Esc finishes.'
                : `Waypoint ${wp.selected + 1} selected: drag to move, Del deletes, "Add before" / "Add after" in the panel arms a map click. Esc finishes.`)
        : mode === 'splitPath' ? 'Pick an existing junction in the panel, or click on the path (or the map) where the new junction goes: the path and every circuit on it are cut there and re-joined at the junction; lines keep their sections. Esc cancels.'
        : mode === 'addLine' ? 'New line: click the FROM site, the TO site and the junctions (or sites) it passes in between, in order; right-click one to take it out again. The yards, conductor and circuits are set in the panel. Esc cancels.'
        : mode === 'addSite' ? 'Click on the map where the substation site is.'
        : mode === 'addJunction' ? 'Click on the map where the line junction (tap / splice point) is.'
        : mode === 'addPath' ? (!pathDraft.from ? 'New path: click the site or junction where the route starts (or pick it in the panel); right-click an end to take it out again. Esc cancels.'
            : !pathDraft.to ? 'New path: now click the site or junction where it ends; right-click an end to take it out again. Esc cancels.'
                : 'New path: check the name in the panel and create it (then add waypoints with "Edit waypoints"); right-click an end to take it out again. Esc cancels.')
            : mode === 'addCircuit' ? (!draft.from ? 'New circuit: click the site or junction where the circuit starts (or pick it in the panel); right-click an end to take it out again. Esc cancels.'
                : !draft.to ? 'New circuit: now click the site or junction where it ends; right-click an end to take it out again. Esc cancels.'
                    : 'New circuit: choose the take-offs / junctions and the details in the panel, then create it; right-click an end to take it out again. Esc cancels.')
                : 'Select mode: click a site, junction or line (selects its path; pick a circuit in the panel). Drag markers to move them.'

    return (
        <div className="editor-layout" style={{'--side-w': `${sideWidth}px`} as React.CSSProperties}>
            <div className="editor-canvas" onKeyDown={e => {
                if (e.key === 'Escape') {
                    if (mode === 'editWaypoints' && wp?.adding) updateWp({adding: null})
                    else setMode('select')
                }
                if ((e.key === 'Delete') && mode === 'select') deleteSelection()
                if ((e.key === 'Delete' || e.key === 'Backspace') && mode === 'editWaypoints') deleteWaypoint()
            }} tabIndex={0}>
                <div className="editor-tools map-tools">
                    <button type="button" className={mode === 'select' ? 'active' : ''} onClick={() => setMode('select')}>Select</button>
                    <button type="button" className={mode === 'addSite' ? 'active' : ''} onClick={() => setMode('addSite')}>+ Site</button>
                    <button type="button" className={mode === 'addJunction' ? 'active' : ''} onClick={() => setMode('addJunction')}>+ Junction</button>
                    <button type="button" className={mode === 'addPath' ? 'active' : ''} onClick={() => setMode('addPath')} title="New path (route) between two sites / junctions, without circuits">+ Path</button>
                    <button type="button" className={mode === 'addCircuit' ? 'active' : ''} onClick={() => setMode('addCircuit')}>+ Circuit</button>
                    <button type="button" className={mode === 'addLine' ? 'active' : ''} onClick={() => setMode('addLine')} title="New line wizard: yard to yard, with take-offs, path, circuits and lines in one step">+ Line</button>
                    <button type="button" className={mode === 'editWaypoints' ? 'active' : ''} onClick={() => mode === 'editWaypoints' ? setMode('select') : startWaypoints()}
                            disabled={mode !== 'editWaypoints' && ed.selection?.collection !== 'circuits' && ed.selection?.collection !== 'paths'} title="Edit the waypoints of the selected path">Waypoints</button>
                    <button type="button" className={mode === 'splitPath' ? 'active' : ''} onClick={() => mode === 'splitPath' ? setMode('select') : startSplit()}
                            disabled={mode !== 'splitPath' && ed.selection?.collection !== 'circuits' && ed.selection?.collection !== 'paths'} title="Cut the selected path at an existing junction or at a new one placed by the next map click; circuits are split and re-joined there, lines stay connected">Split</button>
                    <button type="button" onClick={fit}>Fit</button>
                    <button type="button" onClick={() => {
                        setMode('select')
                        edRef.current.select(null)
                    }} title="Search sites, junctions, paths and circuits by name">Find</button>
                    <button type="button" className="danger" onClick={deleteSelection} disabled={!ed.selection || mode !== 'select'}>Delete</button>
                </div>
                <div className="map-features">
                    <button type="button" className="small" aria-expanded={features.open} onClick={() => setFeature({open: !features.open})}
                            title="Choose what the map shows">Map features {features.open ? '▾' : '▸'}</button>
                    {features.open && (
                        <ul>
                            {MAP_FEATURE_TOGGLES.map(t => {
                                // a toggle that does nothing with the others as they are is disabled; it keeps its own setting for later
                                const off = t.off?.(features)
                                return (
                                    <li key={t.key}>
                                        <label title={off ?? t.title} style={off ? {opacity: .5, cursor: 'not-allowed'} : undefined}>
                                            <input type="checkbox" checked={features[t.key]} disabled={!!off} onChange={e => setFeature({[t.key]: e.target.checked})}/> {t.label}
                                        </label>
                                    </li>
                                )
                            })}
                        </ul>
                    )}
                </div>
                <div ref={containerRef} className="leaflet-map"/>
                <div className="editor-hint">{hint}</div>
            </div>
            <div className="side-resizer" onMouseDown={onResizeStart} title="Drag to resize the panel"/>
            <aside className="editor-side">
                <MapPanels meta={meta} mode={mode} draft={draft} setDraft={setDraft} lineDraft={lineDraft} setLineDraft={setLineDraft} pathDraft={pathDraft} setPathDraft={setPathDraft} setMode={panelSetMode} navigate={navigate} locate={locate} createDraft={createDraft} setCreateDraft={setCreateDraft} splitNow={() => performSplit()}
                           waypoints={wp ? {state: wp, update: updateWp, remove: deleteWaypoint, setPath, done: () => setMode('select')} : undefined}/>
            </aside>
        </div>
    )
}
