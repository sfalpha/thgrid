/**
 * "New line" wizard: from one end to another, optionally through junctions
 * in between, with N parallel circuits. An end is a yard (the circuits leave
 * it through take-offs) or a junction: a line junction, or a site's own
 * junction (created when the site has none); at a junction end each circuit
 * gets a node of its own there, and the line ends at that junction (open
 * until it is extended or tied in).
 * Builds, in one journaled batch, everything the model rules would name:
 *  - a take-off per circuit at each yard (`<voltage>_<other site>_L<n>`),
 *  - one transmission path per leg (yard → junction → … → yard), shared by
 *    the circuits: a path that already runs between the two stops is reused
 *    (unless a separate one is asked for), else a new one is created,
 *  - per circuit one section per leg (`<kV>_<from>_<to>_S<n>`), attached at
 *    the yards through the take-offs, joined section to section in a node of
 *    its own at every junction, and energized,
 *  - one line per circuit (`<kV>_<site>_<site>_L<n>`), its sections FROM → TO.
 * The line runs at the energized voltage given, else at the voltage its yards bring: a yard at or below the circuits'
 * rated voltage its own (a circuit rated above the yard runs below its rating, a note), one above it the rated voltage;
 * two yards that would bring different voltages are refused. With both ends at junctions nothing reaches it: it is
 * de-energized (0 V). The line, its sections (energized) and the junction nodes it creates take that voltage. Each yard
 * end takes its take-offs into the yard at that voltage: the one picked, else the site's yard at it (a note); below the
 * picked yard's voltage, with no such yard, their circuits are set to it (a secondary / auxiliary line, a warning); a
 * yard that cannot feed it is refused. Free take-offs are reused only when their circuit is at that voltage.
 * Pure: works on a document and returns ops plus a summary for the preview.
 */
import {energizedVsRated, TransmissionVoltage} from '@shared/models/transmission.voltage'
import {genericConductor, type TransmissionConductor} from '@shared/models/transmission.conductor'
import {
    CIRCUIT_END_FROM,
    CIRCUIT_END_TO,
    CircuitEnd,
    ConnectionJunctionKind,
    ConnectionJunctionRef,
    ConnectionRecord,
    NetworkDocument,
    SubstationRecord,
    SubstationTakeOffRecord,
    TransmissionCircuitRecord,
    TransmissionJunctionRecord,
    TransmissionLineRecord,
    TransmissionPathRecord,
} from '@shared/network/records'
import {applyOps, NetworkOp, uniqueId} from '@shared/network/ops'
import {circuitNaming, lineNaming, pathNaming, takeOffLineName, takeOffNaming} from '@shared/network/naming'
import {attachCircuitEndToJunctionOps, attachCircuitEndToTakeOffOps, freeTakeOffs, refLabel, sameRef, takeOffVoltage} from './linkOps'
import {haversineKm, locationOfRef} from './mapUtil'
import {newSiteJunctionRecord, siteJunctionOf} from '@shared/network/siteJunction'
import {pathEndOf} from '@shared/network/refs'
import {SubstationTakeOff} from '@shared/models/substation.take.off'

/** Route choice for one leg of the line (between two consecutive stops). */
export interface NewLineLegSpec {
    /** Create a new path even when one already runs between the stops. */
    createPath?: boolean
    /** Existing path between the stops to reuse; the first existing one when empty. */
    pathId?: string
    /** Name of the new path (rule name when empty). */
    pathName?: string
}

/**
 * Where the line starts or ends: `Y:<yard id>` (through a take-off per circuit), `J:<junction id>` (a node per circuit
 * at that junction) or `G:<site id>` (the site's junction, created when the site has none).
 */
export type NewLineEnd = string

export interface NewLineSpec {
    /** The ends (see `NewLineEnd`); `fromYardId` / `toYardId` name a yard end directly. */
    from?: NewLineEnd
    to?: NewLineEnd
    fromYardId?: string
    toYardId?: string
    /** Junctions the line passes, in order from the FROM yard (ids of existing junctions; see `vias` for sites). */
    viaJunctionIds?: string[]
    /** Stops in between, in order from the FROM yard: a junction, or a site whose site junction is used (created, named after the site, when it has none). Appended after `viaJunctionIds`. */
    vias?: NewLineVia[]
    /** Number of parallel circuits (≥ 1). */
    circuits: number
    voltage?: TransmissionVoltage
    bundle?: number
    /** Conductor values, copied from a conductor template or typed. */
    conductor?: TransmissionConductor
    /** Total length, shared among the sections by straight-line distance. */
    lengthKm?: number
    /** Route choice per leg (`stops - 1` entries); a missing entry reuses an existing path when there is one. */
    legs?: NewLineLegSpec[]
    /** Planned (not built yet): the take-offs, circuits, lines and new connections are created with `planned: true` (drawn in grey). */
    planned?: boolean
    /** Attach the circuits to free take-offs the yards already have toward the other site (`<kV>_<other site>_L<n>`, lowest n first) instead of creating new ones; see `NewLinePlan.freeTakeOffs`. */
    reuseTakeOffs?: boolean
    /** Voltage the new sections are energized at; when empty, the one their yards bring (0 V when both ends are junctions). */
    energizedVoltage?: TransmissionVoltage
}

/** A stop between the two yards: an existing junction, or a site (passed through its site junction). */
export type NewLineVia = { junctionId: string; groupId?: undefined } | { groupId: string; junctionId?: undefined }

export interface NewLineLegPlan {
    from: ConnectionJunctionRef
    to: ConnectionJunctionRef
    /** The path used (existing or new) and whether it was created. */
    path: { id: string; name: string; created: boolean }
    /** Paths that already run between the stops with circuits at the line voltage (or none): reused by default. */
    existing: TransmissionPathRecord[]
    /** Paths between the stops whose circuits run at another voltage: offered, but only on an explicit choice. */
    otherVoltage: { path: TransmissionPathRecord; voltages: TransmissionVoltage[] }[]
    /** Only other-voltage paths exist and nothing was chosen yet: the plan has an error until the user decides (share or new path). */
    needsDecision: boolean
    /** The reused path runs TO → FROM: the sections on it follow its direction. */
    reversed: boolean
    /** Straight-line distance between the stops. */
    km?: number
}

export interface NewLinePlan {
    ops: NetworkOp[]
    /** The stops FROM → TO: the two yards with the junctions between (a site junction created by the plan included). */
    stops: ConnectionJunctionRef[]
    /** Human readable name per stop (a junction the plan creates is not in the document yet). */
    stopLabels: string[]
    /** Straight-line length through the stops; undefined when a stop has no position. */
    km?: number
    /** Site junctions the plan creates for sites passed in between. */
    newJunctions: TransmissionJunctionRecord[]
    /** Per leg, in order: the route used. Filled as far as the stops are known, even when the plan has errors. */
    legs: NewLineLegPlan[]
    /** Per circuit, in order: the records created (`sections` FROM → TO, one per leg); a take-off per yard end (none at a junction end); `reused` names the end whose take-off already existed. */
    circuits: { line: TransmissionLineRecord; sections: TransmissionCircuitRecord[]; fromTakeOff?: SubstationTakeOffRecord; toTakeOff?: SubstationTakeOffRecord; reused: { from: boolean; to: boolean } }[]
    /** Free take-offs (attached to no circuit) each yard already has toward the other site, lowest `L<n>` first; used instead of new ones with `spec.reuseTakeOffs`. */
    freeTakeOffs: { from: SubstationTakeOffRecord[]; to: SubstationTakeOffRecord[] }
    /** Problems that make the plan invalid (empty ops then). */
    errors: string[]
    /** Things worth a look that do not block. */
    warnings: string[]
    /** Worth knowing, nothing to fix (shown in blue): the voltage the line runs at and why, open ends. */
    notes: string[]
    /** The voltage the line runs at (its sections energized at it). */
    energizedVoltage?: TransmissionVoltage
}

export const yardRef = (id: string): ConnectionJunctionRef => ({kind: ConnectionJunctionKind.SUBSTATION, id})

/** A resolved line end: a yard, or a junction (a line junction or a site's junction), and the site it belongs to. */
interface LineEnd {
    ref: ConnectionJunctionRef
    yard?: SubstationRecord
    junction?: TransmissionJunctionRecord
    siteId?: string
}
export const junctionRef = (id: string): ConnectionJunctionRef => ({kind: ConnectionJunctionKind.TRANSMISSION_JUNCTION, id})

/** Paths that already run between two stops (yards or junctions), in either direction. */
export function pathsBetween(doc: NetworkDocument, a: ConnectionJunctionRef, b: ConnectionJunctionRef): TransmissionPathRecord[] {
    return doc.paths.filter(p => (sameRef(p.from, a) && sameRef(p.to, b)) || (sameRef(p.from, b) && sameRef(p.to, a)))
}

/** Voltages the circuits on a path are energized at (rated when not energized yet), distinct, unknowns left out. */
export function pathVoltages(doc: NetworkDocument, pathId: string): TransmissionVoltage[] {
    const out = new Set<TransmissionVoltage>()
    for (const c of doc.circuits) if (c.pathId === pathId) {
        const v = c.energizedVoltage ?? c.voltage
        if (v) out.add(v)
    }
    return [...out]
}

/**
 * Paths between two stops that sections at `voltage` may share: a path is
 * reusable when it carries no circuits, or only circuits of that voltage (or
 * of unknown voltage). The rest are returned in `otherVoltage`.
 */
export function reusablePathsBetween(doc: NetworkDocument, a: ConnectionJunctionRef, b: ConnectionJunctionRef, voltage: TransmissionVoltage | undefined): { existing: TransmissionPathRecord[]; otherVoltage: NewLineLegPlan['otherVoltage'] } {
    const existing: TransmissionPathRecord[] = []
    const otherVoltage: NewLineLegPlan['otherVoltage'] = []
    for (const path of pathsBetween(doc, a, b)) {
        const voltages = pathVoltages(doc, path.id)
        if (!voltage || voltages.every(v => v === voltage)) existing.push(path)
        else otherVoltage.push({path, voltages})
    }
    return {existing, otherVoltage}
}

/** The stops of a line FROM → TO: the from yard, the junctions passed, the to yard (ids are not checked here). */
export function lineStops(fromYardId: string, viaJunctionIds: string[] | undefined, toYardId: string): ConnectionJunctionRef[] {
    return [yardRef(fromYardId), ...(viaJunctionIds ?? []).map(junctionRef), yardRef(toYardId)]
}

/** Straight-line distance between two stops, undefined when one has no position. */
export function legKm(doc: NetworkDocument, a: ConnectionJunctionRef, b: ConnectionJunctionRef): number | undefined {
    const pa = locationOfRef(doc, a), pb = locationOfRef(doc, b)
    return pa && pb ? haversineKm(pa.coords, pb.coords) : undefined
}

/** Straight-line length through the stops (undefined when a stop has no position). */
export function straightKm(doc: NetworkDocument, stops: ConnectionJunctionRef[]): number | undefined {
    let total = 0
    for (let i = 0; i + 1 < stops.length; i++) {
        const km = legKm(doc, stops[i], stops[i + 1])
        if (km === undefined) return undefined
        total += km
    }
    return stops.length >= 2 ? Number(total.toFixed(2)) : undefined
}

/** Section lengths that share `total` among the legs by their straight-line distance (equally when a distance is unknown). */
function shareLength(total: number | undefined, kms: (number | undefined)[]): (number | undefined)[] {
    if (total === undefined) return kms.map(() => undefined)
    if (kms.length === 1) return [total]
    const known = kms.every((k): k is number => k !== undefined) && kms.some(k => k > 0)
    const weights = known ? (kms as number[]) : kms.map(() => 1)
    const sum = weights.reduce((s, k) => s + k, 0)
    const out = weights.map(w => Number((total * w / sum).toFixed(2)))
    // keep the sum exact: the last section takes the rounding difference
    out[out.length - 1] = Number((total - out.slice(0, -1).reduce((s, k) => s + k, 0)).toFixed(2))
    return out
}

/**
 * Free take-offs of a yard whose line name points at a site
 * (`<kV>_<site code>_L<n>` or `<site code>_L<n>`, case-insensitive), lowest
 * n first: the ones a line from that yard to that site can be attached to.
 */
export function freeTakeOffsToward(doc: NetworkDocument, substationId: string, targetGroupId: string | undefined): SubstationTakeOffRecord[] {
    const target = targetGroupId ? doc.substationGroups.find(g => g.id === targetGroupId) : undefined
    if (!target) return []
    const code = target.groupName.replace(/[^A-Za-z0-9_]/g, ch => '\\' + ch)
    const re = new RegExp('^(?:[A-Z0-9]+_)?' + code + '_L(\\d+)$', 'i')
    const seq = (t: SubstationTakeOffRecord) => Number(re.exec(t.lineName)?.[1] ?? Infinity)
    return freeTakeOffs(doc, substationId).filter(t => re.test(t.lineName)).sort((a, b) => seq(a) - seq(b) || a.lineName.localeCompare(b.lineName))
}

export function buildNewLinePlan(doc: NetworkDocument, spec: NewLineSpec): NewLinePlan {
    const errors: string[] = []
    const warnings: string[] = []
    const notes: string[] = []


    const ops: NetworkOp[] = []
    let probe = doc
    const push = (...next: NetworkOp[]) => {
        ops.push(...next)
        probe = applyOps(probe, next)
    }
    const newJunctions: TransmissionJunctionRecord[] = []

    // 0. the ends: a yard, or a junction (a site's junction is created when the site has none)
    const resolveEnd = (key: string | undefined, side: string): LineEnd | undefined => {
        const m = key ? /^([YJG]):(.+)$/.exec(key) : null
        if (!m) return void errors.push(`pick where the line ${side}`)
        if (m[1] === 'Y') {
            const yard = doc.substations.find(s => s.id === m[2])
            if (!yard) return void errors.push(`yard ${m[2]} no longer exists`)
            return {ref: yardRef(yard.id), yard, siteId: yard.groupId}
        }
        if (m[1] === 'J') {
            const junction = doc.junctions.find(j => j.id === m[2])
            if (!junction) return void errors.push(`junction ${m[2]} no longer exists`)
            return {ref: junctionRef(junction.id), junction, siteId: junction.groupId}
        }
        const group = doc.substationGroups.find(g => g.id === m[2])
        if (!group) return void errors.push(`site ${m[2]} no longer exists`)
        let junction = siteJunctionOf(probe, group.id)
        if (!junction) {
            junction = newSiteJunctionRecord(probe, group)
            newJunctions.push(junction)
            push({type: 'upsert', collection: 'junctions', record: junction})
        }
        return {ref: junctionRef(junction.id), junction, siteId: group.id}
    }
    let fromEnd = resolveEnd(spec.from ?? (spec.fromYardId ? `Y:${spec.fromYardId}` : undefined), 'starts from')
    let toEnd = resolveEnd(spec.to ?? (spec.toYardId ? `Y:${spec.toYardId}` : undefined), 'ends at')
    if (fromEnd && toEnd && sameRef(fromEnd.ref, toEnd.ref)) errors.push('the two ends must be different')

    // the stops in between: existing junctions, or sites passed through their site junction (created first when missing)
    const vias: string[] = []
    const viaSpecs: NewLineVia[] = [...(spec.viaJunctionIds ?? []).filter(Boolean).map(junctionId => ({junctionId})), ...(spec.vias ?? [])]
    for (const via of viaSpecs) {
        if (via.groupId) {
            const group = doc.substationGroups.find(g => g.id === via.groupId)
            if (!group) {
                errors.push(`site ${via.groupId} no longer exists`)
                continue
            }
            if (fromEnd?.siteId === group.id || toEnd?.siteId === group.id) errors.push(`site ${group.groupName} is an end of the line and cannot be passed in between`)
            let junction = siteJunctionOf(probe, group.id)
            if (!junction) {
                junction = newSiteJunctionRecord(probe, group)
                newJunctions.push(junction)
                push({type: 'upsert', collection: 'junctions', record: junction})
            }
            vias.push(junction.id)
        } else if (via.junctionId) {
            if (!doc.junctions.some(j => j.id === via.junctionId)) errors.push(`junction ${via.junctionId} no longer exists`)
            vias.push(via.junctionId)
        }
    }
    if (new Set(vias).size !== vias.length) errors.push('a junction can be passed only once')
    for (const end of [fromEnd, toEnd]) if (end?.junction && vias.includes(end.junction.id)) errors.push(`junction ${end.junction.name ?? end.junction.id} is an end of the line and cannot be passed in between`)
    const count = Math.max(0, Math.floor(spec.circuits || 0))
    if (count < 1) errors.push('at least one circuit')
    if (count > 8) errors.push('at most 8 circuits at a time')
    const ratedVoltage = spec.voltage ?? fromEnd?.yard?.voltage ?? toEnd?.yard?.voltage
    if (fromEnd && toEnd && !ratedVoltage) errors.push('pick the voltage: neither end is a yard to take it from')

    // the voltage the line runs at: the one asked for, else what its yards bring (a yard at or below the rated voltage its
    // own, one above it the rated voltage); nothing reaches a line between two junctions: de-energized
    const natural = (yard: SubstationRecord) => ratedVoltage && energizedVsRated(ratedVoltage, yard.voltage) === 'higher' ? ratedVoltage : yard.voltage
    const fromNatural = fromEnd?.yard && natural(fromEnd.yard), toNatural = toEnd?.yard && natural(toEnd.yard)
    if (!spec.energizedVoltage && fromEnd && toEnd && fromNatural && toNatural && fromNatural !== toNatural) {
        errors.push(`the ends are at different voltages (${refLabel(probe, fromEnd.ref)} at ${fromNatural}, ${refLabel(probe, toEnd.ref)} at ${toNatural}): a line runs at one voltage`)
    }
    /** What the yards bring. */
    const connected = fromNatural ?? toNatural
    const lineVoltage = spec.energizedVoltage ?? connected ?? TransmissionVoltage.DE_ENERGIZED   // energized: the line, its sections, the junction nodes, the paths it may share
    // each yard end takes its take-offs into the yard at that voltage: the one picked, else the site's yard at it; below the
    // picked yard's voltage, with no such yard, their circuits are set to it (a secondary / auxiliary line)
    const auxiliaryAt = new Map<string, TransmissionVoltage>()
    const place = (end: LineEnd | undefined): LineEnd | undefined => {
        if (!end?.yard || lineVoltage === TransmissionVoltage.DE_ENERGIZED || end.yard.voltage === lineVoltage) return end
        const yard = end.yard
        const site = doc.substationGroups.find(g => g.id === yard.groupId)
        const atVoltage = doc.substations.find(y => y.groupId === yard.groupId && y.voltage === lineVoltage)
        if (atVoltage) {
            notes.push(`${site?.groupName ?? ''} ${yard.yardName} is at ${yard.voltage}: the take-offs go into its ${lineVoltage} yard ${atVoltage.yardName}`)
            return {...end, yard: atVoltage, ref: yardRef(atVoltage.id)}
        }
        if (energizedVsRated(yard.voltage, lineVoltage) === 'lower') {
            auxiliaryAt.set(yard.id, lineVoltage)
            warnings.push(`${refLabel(probe, end.ref)} is at ${yard.voltage} and ${site?.groupName ?? 'the site'} has no ${lineVoltage} yard: new take-offs there carry ${lineVoltage} on their circuit (a secondary / auxiliary line)`)
            return end
        }
        errors.push(`${refLabel(probe, end.ref)} is at ${yard.voltage}: it cannot feed a line energized at ${lineVoltage}`)
        return end
    }
    if (!errors.length && ratedVoltage) {
        fromEnd = place(fromEnd)
        toEnd = place(toEnd)
    }
    const fromYard = fromEnd?.yard, toYard = toEnd?.yard
    /** The voltage of the take-offs at a yard: the line's (the yard's, or an auxiliary line's). */
    const takeOffAt = (yard: SubstationRecord) => auxiliaryAt.get(yard.id) ?? yard.voltage
    // Take-offs the yards already hold toward each other, no circuit uses, and at that voltage: offered instead of new ones.
    const free: NewLinePlan['freeTakeOffs'] = {
        from: fromYard ? freeTakeOffsToward(doc, fromYard.id, toEnd?.siteId).filter(t => takeOffVoltage(doc, t.id) === takeOffAt(fromYard)) : [],
        to: toYard ? freeTakeOffsToward(doc, toYard.id, fromEnd?.siteId).filter(t => takeOffVoltage(doc, t.id) === takeOffAt(toYard)) : [],
    }
    const stops = fromEnd && toEnd ? [fromEnd.ref, ...vias.map(junctionRef), toEnd.ref] : []
    const stopLabels = stops.map(s => refLabel(probe, s))
    const km = straightKm(probe, stops)
    const fail = (legs: NewLineLegPlan[]): NewLinePlan => ({ops: [], stops, stopLabels, km, newJunctions, legs, circuits: [], freeTakeOffs: free, errors, warnings, notes})
    if (errors.length || !fromEnd || !toEnd || !ratedVoltage) return fail([])

    const voltage = ratedVoltage   // rated: the circuits

    if (fromEnd.siteId && fromEnd.siteId === toEnd.siteId) warnings.push('both ends belong to the same site')
    for (const end of [fromEnd, toEnd]) {
        if (!end.yard || (end === toEnd && fromEnd.yard?.id === end.yard.id)) continue
        const how = energizedVsRated(ratedVoltage, end.yard.voltage)
        if (how === 'lower' && !spec.energizedVoltage) notes.push(`the circuits are rated ${ratedVoltage}, ${refLabel(probe, end.ref)} is at ${end.yard.voltage}: they run at ${end.yard.voltage}`)
        else if (how === 'typeMismatch') warnings.push(`the circuits are rated ${ratedVoltage}, but ${refLabel(probe, end.ref)} is at ${end.yard.voltage}: the current types differ (AC / DC)`)
    }
    for (const [end, side] of [[fromEnd, 'FROM'], [toEnd, 'TO']] as const) {
        if (end.junction) notes.push(`the line ${side === 'FROM' ? 'starts' : 'ends'} at ${refLabel(probe, end.ref)}: each circuit gets a node of its own there, open until the line is extended or tied in`)
    }
    if (!connected && !spec.energizedVoltage) notes.push('both ends are junctions, so no yard energizes it: the line is de-energized (0 V) until it is connected')
    if (spec.energizedVoltage) {
        const how = energizedVsRated(ratedVoltage, spec.energizedVoltage)
        if (how === 'lower') notes.push(`the sections are energized at ${spec.energizedVoltage}, below their rated ${ratedVoltage}`)
        else if (how === 'deEnergized') notes.push('the sections are de-energized (0 V)')
        else if (how === 'higher') warnings.push(`the sections are energized at ${spec.energizedVoltage}, above their rated ${ratedVoltage}`)
        else if (how === 'typeMismatch') warnings.push(`the sections are energized at ${spec.energizedVoltage}, but rated ${ratedVoltage}: the current types differ (AC / DC)`)
    }

    // 1. one path per leg: an existing one between the stops unless told otherwise, else a new one
    const legs: NewLineLegPlan[] = []
    const legPaths: TransmissionPathRecord[] = []
    for (let i = 0; i + 1 < stops.length; i++) {
        const a = stops[i], b = stops[i + 1]
        // Paths end at sites, not yards: look the route up (and create it) between the stops' sites / junctions.
        const pa = pathEndOf(probe, a) ?? a, pb = pathEndOf(probe, b) ?? b
        const choice = spec.legs?.[i] ?? {}
        const {existing, otherVoltage} = reusablePathsBetween(doc, pa, pb, lineVoltage)
        let path: TransmissionPathRecord | undefined
        let needsDecision = false
        if (!choice.createPath) {
            if (choice.pathId) {
                const chosen = doc.paths.find(p => p.id === choice.pathId)
                const other = otherVoltage.find(o => o.path.id === choice.pathId)
                if (!chosen) errors.push(`the chosen path for ${refLabel(probe, a)} → ${refLabel(probe, b)} no longer exists`)
                else if (other) warnings.push(`path "${chosen.name}" carries ${other.voltages.join(' / ')} circuits: the new ${lineVoltage} sections will share its route`)
                else if (!existing.some(p => p.id === chosen.id)) errors.push(`path "${chosen.name}" does not run between ${refLabel(probe, a)} and ${refLabel(probe, b)}`)
                path = chosen
            } else if (existing.length) path = existing[0]
            else if (otherVoltage.length) {
                // A route exists, but its circuits run at another voltage: the user decides whether to share it or to build a separate one.
                needsDecision = true
                errors.push(`${refLabel(probe, a)} → ${refLabel(probe, b)}: ${otherVoltage.length === 1 ? `path "${otherVoltage[0].path.name}" already exists but carries ${otherVoltage[0].voltages.join(' / ')} circuits` : `${otherVoltage.length} paths already exist but carry circuits of another voltage`}; choose whether the new ${lineVoltage} sections share it or get a new path`)
            }
        }
        let created = false
        if (!path) {
            const naming = pathNaming(probe, pa, pb)
            path = {id: uniqueId(probe, naming.id), name: choice.pathName?.trim() || naming.name, from: pa, to: pb, waypoints: []}
            created = true
            push({type: 'upsert', collection: 'paths', record: path})
        }
        const reversed = !created && sameRef(path.from, pb)
        if (reversed) warnings.push(`the existing path "${path.name}" runs ${refLabel(probe, b)} ← ${refLabel(probe, a)}: the sections on it follow its direction`)
        legs.push({from: a, to: b, path: {id: path.id, name: path.name, created}, existing, otherVoltage, needsDecision, reversed, km: legKm(probe, a, b)})
        legPaths.push(path)
    }
    if (errors.length) return fail(legs)
    const lengths = shareLength(spec.lengthKm, legs.map(l => l.km))

    // 2. the circuits: take-offs at the yards, one section per leg joined at the junctions, one line each
    const circuits: NewLinePlan['circuits'] = []
    const freePool = {from: [...free.from], to: [...free.to]}
    for (let i = 0; i < count; i++) {
        // take-offs: a free one the yard already has toward the other site when asked for (one per circuit, lowest n first), else a new one named toward it
        // (toward a line junction: named after the junction, there is no site to name it after)
        const makeTakeOff = (yard: SubstationRecord, other: LineEnd, pool: SubstationTakeOffRecord[]): SubstationTakeOffRecord => {
            const reuse = spec.reuseTakeOffs ? pool.shift() : undefined
            if (reuse) return reuse
            const carried = takeOffAt(yard)
            let lineName = other.siteId ? takeOffLineName(probe, yard.id, other.siteId, carried) : undefined
            if (!lineName && other.junction) {
                const code = other.junction.name ?? other.junction.id
                let n = 1
                while (probe.takeOffs.some(t => t.substationId === yard.id && t.lineName === SubstationTakeOff.defaultLineName({targetCode: code, voltage: carried, sequence: n}))) n++
                lineName = SubstationTakeOff.defaultLineName({targetCode: code, voltage: carried, sequence: n})
            }
            lineName ||= `LINE_${probe.takeOffs.filter(t => t.substationId === yard.id).length + 1}`
            const naming = takeOffNaming(probe, yard.id, lineName)
            const record: SubstationTakeOffRecord = {id: uniqueId(probe, naming.id), name: naming.name, substationId: yard.id, lineName, takeOffColumn: true, planned: spec.planned || undefined}
            push({type: 'upsert', collection: 'takeOffs', record})
            return record
        }
        const fromTakeOff = fromYard ? makeTakeOff(fromYard, toEnd, freePool.from) : undefined
        const toTakeOff = toYard ? makeTakeOff(toYard, fromEnd, freePool.to) : undefined
        const reused = {from: !!fromTakeOff && free.from.includes(fromTakeOff), to: !!toTakeOff && free.to.includes(toTakeOff)}
        /** Attaches a section end at a line end: through its take-off at a yard, in a node of its own at a junction. */
        const attachAtEnd = (circuitId: string, circuitEnd: CircuitEnd, end: LineEnd, takeOff: SubstationTakeOffRecord | undefined) =>
            takeOff ? attachCircuitEndToTakeOffOps(probe, circuitId, circuitEnd, takeOff.id, {voltage: auxiliaryAt.get(takeOff.substationId)}) : attachCircuitEndToJunctionOps(probe, circuitId, circuitEnd, end.ref.id, lineVoltage, {forceNew: true})

        // one line per circuit, FROM → TO, named first: its sections are named after it (`<line>_<path>`); at a junction end
        // the line ends at that junction
        const ln = lineNaming(probe, undefined, fromEnd.ref, toEnd.ref, lineVoltage)
        // a name another line already has (e.g. toward the same open junction): take the next free L<n>
        const bump = (s: string) => s.replace(/_L(\d+)$/, (_, n) => `_L${Number(n) + 1}`)
        while (probe.lines.some(l => l.name === ln.name) && /_L\d+$/.test(ln.name)) {
            ln.name = bump(ln.name)
            ln.id = bump(ln.id)
        }
        const sections: TransmissionCircuitRecord[] = []
        let nodeAtStop: ConnectionRecord | undefined   // the node at the junction where the previous section ended
        for (let j = 0; j < legPaths.length; j++) {
            const path = legPaths[j]
            const leg = legs[j]
            const cn = circuitNaming(probe, {pathId: path.id, lineName: ln.name, voltage})
            const circuit: TransmissionCircuitRecord = {
                id: uniqueId(probe, cn.id), name: cn.name, pathId: path.id,
                voltage: spec.voltage, energizedVoltage: lineVoltage, bundle: spec.bundle, conductor: spec.conductor ? {...spec.conductor} : genericConductor(), lengthKm: lengths[j], planned: spec.planned || undefined,
            }
            push({type: 'upsert', collection: 'circuits', record: circuit})
            // the section's FROM end sits where its path starts
            const startEnd: CircuitEnd = leg.reversed ? CIRCUIT_END_TO : CIRCUIT_END_FROM
            const finishEnd: CircuitEnd = leg.reversed ? CIRCUIT_END_FROM : CIRCUIT_END_TO
            if (j === 0) push(...attachAtEnd(circuit.id, startEnd, fromEnd, fromTakeOff))
            else if (nodeAtStop) push(...attachCircuitEndToJunctionOps(probe, circuit.id, startEnd, leg.from.id, lineVoltage, {connectionId: nodeAtStop.id}))
            if (j === legPaths.length - 1) push(...attachAtEnd(circuit.id, finishEnd, toEnd, toTakeOff))
            else {
                const atJunction = attachCircuitEndToJunctionOps(probe, circuit.id, finishEnd, leg.to.id, lineVoltage, {forceNew: true})
                push(...atJunction)
                nodeAtStop = atJunction[0]?.type === 'upsert' ? atJunction[0].record as ConnectionRecord : undefined
            }
            // the section runs at the line's voltage, whatever the attaching set
            const current = probe.circuits.find(c => c.id === circuit.id)!
            if (current.energizedVoltage !== lineVoltage) push({type: 'upsert', collection: 'circuits', record: {...current, energizedVoltage: lineVoltage}})
            sections.push(probe.circuits.find(c => c.id === circuit.id) ?? circuit)
        }

        const line: TransmissionLineRecord = {id: uniqueId(probe, ln.id), name: ln.name, voltage: lineVoltage, from: fromEnd.ref, to: toEnd.ref, circuitIds: sections.map(s => s.id), planned: spec.planned || undefined}
        push({type: 'upsert', collection: 'lines', record: line})
        circuits.push({line, sections, fromTakeOff, toTakeOff, reused})
    }
    // A planned line: the connections the attach helpers created are planned too (existing ones at a reused take-off / node are left alone).
    if (spec.planned) {
        const existing = new Set(doc.connections.map(c => c.id))
        ops.forEach((o, i) => {
            if (o.type === 'upsert' && o.collection === 'connections' && !existing.has(o.record.id)) ops[i] = {...o, record: {...o.record, planned: true}}
        })
    }
    return {ops, stops, stopLabels, km, newJunctions, legs, circuits, freeTakeOffs: free, errors, warnings, notes, energizedVoltage: lineVoltage}
}
