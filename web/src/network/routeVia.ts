/**
 * Routing circuits of a path via a station (site) or a junction.
 *
 * The chosen circuits are cut where the route passes the via point (the path
 * segment nearest to it): each original keeps the first part (path FROM end →
 * via) and a continuation circuit (same make-up, the rest of the length) runs
 * from the via point to where the original used to end. At the via point
 * either
 * - the two parts are spliced in one node of a junction (a line junction, or
 *   the site's own junction, created when missing): electrically they stay one
 *   circuit run, and lines keep it as consecutive sections; or
 * - both enter a yard of the site through a new take-off each ("loop in"):
 *   only a yard at the voltage every chosen circuit is energized at can be
 *   used (a de-energized circuit: a yard within its rating, warned; it stays
 *   de-energized, its take-offs at the yard's voltage), and each line through
 *   them is split there into two lines (a line runs yard to yard).
 * Paths: either part can run on an existing path between the same places
 * (`routeViaPathChoices`, `RouteViaOptions`; one running the other way makes
 * the circuits on it follow its direction, FROM and TO swapped). Parts not
 * reused: when every circuit of the path is chosen, the path itself is cut
 * and carries the first of them (and is removed when both parts are reused);
 * otherwise they get new paths, the route's waypoints shared out at the cut.
 * Pure: returns ops plus a summary for the confirmation.
 */
import {genericConductor} from '@shared/models/transmission.conductor'
import {SubstationTakeOff} from '@shared/models/substation.take.off'
import {TransmissionVoltage, withinRating} from '@shared/models/transmission.voltage'
import type {CoordinatesProps} from '@shared/models/coordinates'
import {
    CIRCUIT_END_FROM,
    CIRCUIT_END_TO,
    ConnectionJunctionKind,
    ConnectionJunctionRef,
    ConnectionRecord,
    NetworkDocument,
    NetworkNodeKind,
    SubstationGroupRecord,
    SubstationRecord,
    SubstationTakeOffRecord,
    TransmissionCircuitRecord,
    TransmissionJunctionRecord,
    TransmissionLineRecord,
    TransmissionPathRecord,
} from '@shared/network/records'
import {applyOps, NetworkOp, uniqueId} from '@shared/network/ops'
import {circuitNaming, lineNameVoltage, lineNaming, pathNaming, regenerateNamingOps, RegenerateChange, takeOffLineName, takeOffNaming} from '@shared/network/naming'
import {atPathEnd, junctionRef, pathEndOf, siteRef} from '@shared/network/refs'
import {newSiteJunctionRecord, siteJunctionOf} from '@shared/network/siteJunction'
import {attachCircuitEndToJunctionOps, attachCircuitEndToTakeOffOps, circuitEndConnection, detachCircuitEndOps, refLabel} from './linkOps'
import {locationOfRef} from './mapUtil'
import {nearestSegment, polylineKm} from './splitPath'

/** Where the circuits go via: spliced at a junction (a line junction or a site's junction), or into a yard. */
export type RouteVia =
    | { kind: 'junction'; junctionId: string }
    | { kind: 'siteJunction'; groupId: string }
    | { kind: 'yard'; yardId: string }

/** Voltage a circuit runs at: energized, else rated. */
export const runVoltage = (c: TransmissionCircuitRecord): TransmissionVoltage | undefined => c.energizedVoltage ?? c.voltage

/** Voltage of a junction node a circuit is spliced in: the one it is energized at (0 V when de-energized; its rated one when unknown), as the line wizard and Form a line set it. */
export const nodeVoltage = (c: TransmissionCircuitRecord): TransmissionVoltage | undefined => c.energizedVoltage ?? c.voltage

const deEnergized = (c: TransmissionCircuitRecord) => c.energizedVoltage === TransmissionVoltage.DE_ENERGIZED

/**
 * The yards of a site and whether the chosen circuits may enter them. The energized ones fix the voltage: the yard must
 * be at the voltage every one of them runs at. A de-energized circuit (0 V) may enter a yard within its rating (the
 * same current type, not above it): it stays de-energized there (`deEnergizedEntryWarning`).
 */
export function yardChoices(doc: NetworkDocument, groupId: string, circuits: TransmissionCircuitRecord[]): { yard: SubstationRecord; reason?: string }[] {
    const live = circuits.filter(c => !deEnergized(c))
    const voltages = [...new Set(live.map(runVoltage))]
    return doc.substations.filter(y => y.groupId === groupId).sort((a, b) => a.yardName.localeCompare(b.yardName)).map(yard => {
        const beyond = circuits.find(c => deEnergized(c) && !withinRating(c.voltage, yard.voltage))
        return {
            yard,
            reason: circuits.length === 0 ? 'check circuits first'
                : voltages.length > 1 ? `the checked circuits run at different voltages (${voltages.map(v => v ?? 'unknown').join(', ')})`
                    : live.length && voltages[0] === undefined ? 'the checked circuits have no voltage'
                        : live.length && voltages[0] !== yard.voltage ? `not at ${voltages[0]} (the voltage the circuits are energized at)`
                            : beyond ? `beyond the rating of the de-energized ${beyond.name} (${beyond.voltage})` : undefined,
        }
    })
}

/** The warning for de-energized circuits entering a yard: allowed, they stay de-energized; their take-offs are at the yard's voltage. */
export function deEnergizedEntryWarning(circuits: TransmissionCircuitRecord[], yardLabel: string, yardVoltage?: TransmissionVoltage): string | undefined {
    const off = circuits.filter(deEnergized)
    if (!off.length) return undefined
    return `${off.map(c => c.name).join(', ')} ${off.length === 1 ? 'is' : 'are'} de-energized (0 V): entering ${yardLabel} at ${yardVoltage ?? '?'}, ${off.length === 1 ? 'it stays' : 'they stay'} de-energized; the take-offs are at the yard's voltage`
}

export interface RouteViaPlan {
    ops: NetworkOp[]
    /** What the circuits now pass, as a label. */
    viaLabel: string
    /** A junction created on the way (the site's junction when it had none). */
    createdJunction?: TransmissionJunctionRecord
    pathA?: TransmissionPathRecord
    pathB?: TransmissionPathRecord
    /** True when every circuit of the path goes via (the path itself is cut, reused for a part or removed). */
    pathCut: boolean
    /** Parts run on an existing path (`RouteViaOptions`). */
    reused: { before?: boolean; after?: boolean }
    /** The original path, removed because both parts run on existing paths and no circuit is left on it. */
    removedPath?: TransmissionPathRecord
    /** Notes for the confirmation (circuits following a reused path's direction). */
    warnings: string[]
    circuits: { original: TransmissionCircuitRecord; continuation: TransmissionCircuitRecord }[]
    takeOffs: SubstationTakeOffRecord[]
    /** Lines that keep running through (splice): re-sequenced. */
    lines: TransmissionLineRecord[]
    /** Lines split at the yard: the first part keeps the line, the second is a new line. */
    splitLines: { line: TransmissionLineRecord; added: TransmissionLineRecord }[]
    /** Optional follow-up: names / ids of the changed circuits, paths and lines by the model rules. */
    regenerate: { ops: NetworkOp[]; changes: RegenerateChange[] }
    errors: string[]
}

/** The via point as a path end: a junction (or the site it belongs to), or the site of a yard / site junction. */
export function viaPathEnd(doc: NetworkDocument, via: RouteVia): ConnectionJunctionRef | undefined {
    if (via.kind === 'junction') return doc.junctions.some(j => j.id === via.junctionId) ? pathEndOf(doc, junctionRef(via.junctionId)) ?? junctionRef(via.junctionId) : undefined
    const groupId = via.kind === 'siteJunction' ? via.groupId : doc.substations.find(y => y.id === via.yardId)?.groupId
    return groupId && doc.substationGroups.some(g => g.id === groupId) ? siteRef(groupId) : undefined
}

/** Two path ends name the same place (a site and its junction or yards count as that site). */
export const samePlace = (doc: NetworkDocument, a?: ConnectionJunctionRef, b?: ConnectionJunctionRef) => !!a && !!b && (atPathEnd(doc, a, b) || atPathEnd(doc, b, a))

/** Paths between two places, in either direction (`excludeId` left out), best first: the most circuits, then the most waypoints. */
export function pathsBetween(doc: NetworkDocument, a: ConnectionJunctionRef | undefined, b: ConnectionJunctionRef | undefined, excludeId?: string): TransmissionPathRecord[] {
    return doc.paths.filter(p => p.id !== excludeId
        && ((samePlace(doc, p.from, a) && samePlace(doc, p.to, b)) || (samePlace(doc, p.from, b) && samePlace(doc, p.to, a))))
        .sort((x, y) => doc.circuits.filter(c => c.pathId === y.id).length - doc.circuits.filter(c => c.pathId === x.id).length || y.waypoints.length - x.waypoints.length)
}

/**
 * Existing paths the two parts could run on instead of new ones: `before` between the path's FROM end and the via
 * point, `after` between the via point and its TO end (either direction; the path itself excluded).
 */
export function routeViaPathChoices(doc: NetworkDocument, pathId: string, via: RouteVia): { before: TransmissionPathRecord[]; after: TransmissionPathRecord[] } {
    const path = doc.paths.find(p => p.id === pathId)
    const viaRef = viaPathEnd(doc, via)
    if (!path || !viaRef) return {before: [], after: []}
    return {before: pathsBetween(doc, path.from, viaRef, path.id), after: pathsBetween(doc, viaRef, path.to, path.id)}
}

/** A place circuits are routed to (`RouteVia`), resolved: see `resolveRoutePlace`. */
export interface RoutePlace {
    /** The place as a path end: the junction (a site junction stands for its site), or the site. */
    ref: ConnectionJunctionRef
    coords: CoordinatesProps
    /** The junction the circuits meet at; undefined for a yard, or for a site whose junction is still to be created. */
    junction?: TransmissionJunctionRecord
    yard?: SubstationRecord
    /** The site of a yard or of a site junction choice. */
    site?: SubstationGroupRecord
}

/** Resolves where the circuits go; an error message when the place is gone or a yard is not at their voltage. */
export function resolveRoutePlace(doc: NetworkDocument, via: RouteVia, circuits: TransmissionCircuitRecord[]): RoutePlace | string {
    if (via.kind === 'junction') {
        const junction = doc.junctions.find(j => j.id === via.junctionId)
        if (!junction) return 'the junction no longer exists'
        return {ref: pathEndOf(doc, junctionRef(junction.id)) ?? junctionRef(junction.id), coords: junction.coords, junction}
    }
    const groupId = via.kind === 'siteJunction' ? via.groupId : doc.substations.find(y => y.id === via.yardId)?.groupId
    const site = doc.substationGroups.find(g => g.id === groupId)
    if (!site) return 'the site no longer exists'
    const place: RoutePlace = {ref: siteRef(site.id), coords: site.coords, site}
    if (via.kind === 'siteJunction') return {...place, junction: siteJunctionOf(doc, site.id)}
    const yard = doc.substations.find(y => y.id === via.yardId)!
    const reason = yardChoices(doc, site.id, circuits).find(x => x.yard.id === yard.id)?.reason
    return reason ? `yard ${site.groupName} ${yard.yardName}: ${reason}` : {...place, yard}
}

/** The place as the summaries name it; `junction` is the one the circuits meet at (a site junction created on the way). */
export function routePlaceLabel(place: RoutePlace, junction = place.junction): string {
    if (place.yard) return `yard ${place.site!.groupName} ${place.yard.yardName} (${place.yard.voltage})`
    const jName = junction ? junction.name ?? junction.id : '?'
    return place.site ? `site ${place.site.groupName}, through its junction ${jName}` : `junction ${jName}`
}

/**
 * A new take-off in the yard, named toward `target` (a site, yard or junction; `<yard voltage>_<site>_L<n>`, numbered
 * per target: a junction goes by its name, nothing by OPEN).
 */
export function newTakeOffToward(doc: NetworkDocument, yardId: string, target: ConnectionJunctionRef | undefined): SubstationTakeOffRecord {
    const voltage = doc.substations.find(y => y.id === yardId)?.voltage
    const targetSite = target && pathEndOf(doc, target)?.kind === ConnectionJunctionKind.SUBSTATION_GROUP ? pathEndOf(doc, target)!.id : undefined
    let lineName = targetSite ? takeOffLineName(doc, yardId, targetSite) : undefined
    if (!lineName) {
        const code = target ? (doc.junctions.find(j => j.id === target.id)?.name ?? target.id) : 'OPEN'
        let n = 1
        while (doc.takeOffs.some(t => t.substationId === yardId && t.lineName === SubstationTakeOff.defaultLineName({targetCode: code, voltage, sequence: n}))) n++
        lineName = SubstationTakeOff.defaultLineName({targetCode: code, voltage, sequence: n})!
    }
    const naming = takeOffNaming(doc, yardId, lineName)
    return {id: uniqueId(doc, naming.id), name: naming.name, substationId: yardId, lineName, takeOffColumn: true}
}

export interface RouteViaOptions {
    /** Run the first part (FROM end → via) on this existing path (from `routeViaPathChoices().before`) instead of a new / the cut path. */
    reuseBeforeId?: string
    /** Run the second part (via → TO end) on this existing path (from `routeViaPathChoices().after`). */
    reuseAfterId?: string
}

export function buildRouteViaPlan(doc: NetworkDocument, pathId: string, circuitIds: string[], via: RouteVia, opts: RouteViaOptions = {}): RouteViaPlan {
    const plan: RouteViaPlan = {ops: [], viaLabel: '', pathCut: false, reused: {}, circuits: [], takeOffs: [], lines: [], splitLines: [], regenerate: {ops: [], changes: []}, warnings: [], errors: []}
    const fail = (e: string) => ({...plan, errors: [e]})
    const path = doc.paths.find(p => p.id === pathId)
    if (!path) return fail('the path no longer exists')
    const from = locationOfRef(doc, path.from), to = locationOfRef(doc, path.to)
    if (!from || !to) return fail('set both ends of the path first')
    const onPath = doc.circuits.filter(c => c.pathId === path.id)
    const chosen = onPath.filter(c => circuitIds.includes(c.id))
    if (!chosen.length) return fail('check at least one circuit of the path')

    const ops: NetworkOp[] = []
    let probe = doc
    const push = (...next: NetworkOp[]) => {
        ops.push(...next)
        probe = applyOps(probe, next)
    }

    // 1. the via point: its path-end form, its position, and the junction or yard the circuits meet at
    const place = resolveRoutePlace(doc, via, chosen)
    if (typeof place === 'string') return fail(place)
    const {ref: viaRef, coords, yard} = place
    let junction = place.junction
    if (via.kind === 'siteJunction' && !junction) {
        junction = newSiteJunctionRecord(probe, place.site!)
        push({type: 'upsert', collection: 'junctions', record: junction})
        plan.createdJunction = junction
    }
    plan.viaLabel = routePlaceLabel(place, junction)
    if (atPathEnd(doc, viaRef, path.from) || atPathEnd(doc, viaRef, path.to)) return fail(`the path already ends at ${plan.viaLabel.replace(/,.*$/, '')}`)

    // 2. the cut: the route's waypoints before the segment nearest to the via point stay on the first part
    const points = [from.coords, ...path.waypoints, to.coords]
    const k = nearestSegment(points, coords)
    const kmA = polylineKm([from.coords, ...path.waypoints.slice(0, k), coords])
    const kmB = polylineKm([coords, ...path.waypoints.slice(k), to.coords])
    const ratio = kmA + kmB > 0 ? kmA / (kmA + kmB) : 0.5

    // 3. the paths: a part runs on an existing path when asked; otherwise, when every circuit goes via, the path itself
    // carries the first part not reused (cut at the via point), and anything else gets a new path
    plan.pathCut = chosen.length === onPath.length
    const choices = routeViaPathChoices(doc, path.id, via)
    const reuseA = opts.reuseBeforeId ? choices.before.find(p => p.id === opts.reuseBeforeId) : undefined
    const reuseB = opts.reuseAfterId ? choices.after.find(p => p.id === opts.reuseAfterId) : undefined
    if (opts.reuseBeforeId && !reuseA) return fail(`path ${opts.reuseBeforeId} does not run between ${refLabel(doc, path.from)} and the via point`)
    if (opts.reuseAfterId && !reuseB) return fail(`path ${opts.reuseAfterId} does not run between the via point and ${refLabel(doc, path.to)}`)
    plan.reused = {before: !!reuseA, after: !!reuseB}
    let pathA: TransmissionPathRecord, pathB: TransmissionPathRecord
    if (reuseA) pathA = reuseA
    else if (plan.pathCut) {
        pathA = {...path, to: viaRef, waypoints: path.waypoints.slice(0, k)}
        push({type: 'upsert', collection: 'paths', record: pathA})
    } else {
        const pn = pathNaming(probe, path.from, viaRef)
        pathA = {id: uniqueId(probe, pn.id), name: pn.name, from: path.from, to: viaRef, waypoints: path.waypoints.slice(0, k)}
        push({type: 'upsert', collection: 'paths', record: pathA})
    }
    if (reuseB) pathB = reuseB
    else if (plan.pathCut && reuseA) {
        // the first part went elsewhere: the path itself carries the second
        pathB = {...path, from: viaRef, waypoints: path.waypoints.slice(k)}
        push({type: 'upsert', collection: 'paths', record: pathB})
    } else {
        const pnB = pathNaming(probe, viaRef, path.to)
        pathB = {id: uniqueId(probe, pnB.id), name: pnB.name, from: viaRef, to: path.to, waypoints: path.waypoints.slice(k)}
        push({type: 'upsert', collection: 'paths', record: pathB})
    }
    plan.pathA = pathA
    plan.pathB = pathB
    /** A reused path running the other way (towards the FROM end / from the TO end): the circuits on it follow its direction. */
    const reversedA = !!reuseA && samePlace(doc, reuseA.from, viaRef)
    const reversedB = !!reuseB && samePlace(doc, reuseB.to, viaRef)

    /** A new take-off in the yard, named toward `target`. */
    const newTakeOff = (target: ConnectionJunctionRef | undefined): SubstationTakeOffRecord => {
        const rec = newTakeOffToward(probe, yard!.id, target)
        push({type: 'upsert', collection: 'takeOffs', record: rec})
        plan.takeOffs.push(rec)
        return rec
    }

    // 4. every chosen circuit
    const touches = (conn: ConnectionRecord | undefined, id: string | undefined) => !!conn && !!id && conn.nodes.some(n => n.kind === NetworkNodeKind.TRANSMISSION_CIRCUIT && n.id === id)
    const touchedLines = new Map<string, TransmissionLineRecord>()
    for (const c of chosen) {
        const oldTo = circuitEndConnection(doc, c.id, CIRCUIT_END_TO)
        /** Whether the line's sections after this circuit are the ones that led on from its old TO end. */
        const leadsOnAfter = (line: TransmissionLineRecord) => {
            const i = line.circuitIds.indexOf(c.id)
            return touches(oldTo, line.circuitIds[i + 1]) ? true : touches(oldTo, line.circuitIds[i - 1]) ? false
                : atPathEnd(doc, line.to, path.to) ? true : atPathEnd(doc, line.from, path.to) ? false : true
        }
        // where the circuit's line really goes each way: a take-off is named after the far station, not a line junction
        const throughLine = doc.lines.find(l => l.circuitIds.includes(c.id))
        const lineEnd = (onward: boolean) => throughLine && (leadsOnAfter(throughLine) === onward ? throughLine.to : throughLine.from)
        const toward = (pathEnd: ConnectionJunctionRef | undefined, onward: boolean) =>
            pathEndOf(probe, pathEnd)?.kind === ConnectionJunctionKind.SUBSTATION_GROUP ? pathEnd : (lineEnd(onward) ?? pathEnd)

        // the original: first part, its TO end at the via point
        const current = probe.circuits.find(x => x.id === c.id) ?? c
        push({type: 'upsert', collection: 'circuits', record: {...current, pathId: pathA.id, lengthKm: c.lengthKm !== undefined ? Number((c.lengthKm * ratio).toFixed(2)) : c.lengthKm}})
        push(...detachCircuitEndOps(probe, c.id, CIRCUIT_END_TO))

        // the continuation: same make-up, the rest of the length
        // named after the line the original runs in (a yard loop-in gives it a new line: the rename by the rules offered below fixes that)
        const cn = circuitNaming(probe, {pathId: pathB.id, lineName: doc.lines.filter(l => l.circuitIds.includes(c.id)).map(l => l.name).sort()[0], voltage: c.voltage ?? c.energizedVoltage})
        const continuation: TransmissionCircuitRecord = {
            id: uniqueId(probe, cn.id), name: cn.name, pathId: pathB.id,
            voltage: c.voltage, energizedVoltage: c.energizedVoltage, bundle: c.bundle, conductor: c.conductor ? {...c.conductor} : genericConductor(),
            conductorTemplateId: c.conductorTemplateId, planned: c.planned,
            lengthKm: c.lengthKm !== undefined ? Number((c.lengthKm * (1 - ratio)).toFixed(2)) : undefined,
        }
        push({type: 'upsert', collection: 'circuits', record: continuation})

        if (junction) {
            // spliced: both parts in one new node at the junction
            const at = attachCircuitEndToJunctionOps(probe, c.id, CIRCUIT_END_TO, junction.id, nodeVoltage(c), {forceNew: true})
            push(...at)
            const node = at[0]?.type === 'upsert' ? at[0].record as ConnectionRecord : undefined
            if (node) push(...attachCircuitEndToJunctionOps(probe, continuation.id, CIRCUIT_END_FROM, junction.id, nodeVoltage(c), {connectionId: node.id}))
        } else {
            // looped into the yard: a take-off toward each far end (created first: the attach must see it in `probe`)
            const back = newTakeOff(toward(path.from, false))
            push(...attachCircuitEndToTakeOffOps(probe, c.id, CIRCUIT_END_TO, back.id))
            const onward = newTakeOff(toward(path.to, true))
            push(...attachCircuitEndToTakeOffOps(probe, continuation.id, CIRCUIT_END_FROM, onward.id))
        }

        // the continuation ends where the original used to
        if (oldTo) {
            if (oldTo.junction.kind === ConnectionJunctionKind.SUBSTATION) {
                const takeOff = oldTo.nodes.find(n => n.kind === NetworkNodeKind.SUBSTATION_TAKE_OFF)
                if (takeOff) push(...attachCircuitEndToTakeOffOps(probe, continuation.id, CIRCUIT_END_TO, takeOff.id, {newId: oldTo.id, newName: oldTo.name}))
            } else {
                const still = probe.connections.some(x => x.id === oldTo.id)
                push(...attachCircuitEndToJunctionOps(probe, continuation.id, CIRCUIT_END_TO, oldTo.junction.id, nodeVoltage(c),
                    still ? {connectionId: oldTo.id} : {forceNew: true, newId: oldTo.id, newName: oldTo.name}))
            }
        }

        // lines: the continuation goes next to the original, on the side that used to lead on from the old TO end;
        // looped into a yard, the line is split there instead (a line runs yard to yard)
        for (const line of probe.lines.filter(l => l.circuitIds.includes(c.id))) {
            const ids = line.circuitIds
            const i = ids.indexOf(c.id)
            const after = leadsOnAfter(line)
            if (!yard) {
                const updated = {...line, circuitIds: [...ids.slice(0, after ? i + 1 : i), continuation.id, ...ids.slice(after ? i + 1 : i)]}
                push({type: 'upsert', collection: 'lines', record: updated})
                touchedLines.set(line.id, updated)
                continue
            }
            const yardEnd: ConnectionJunctionRef = {kind: ConnectionJunctionKind.SUBSTATION, id: yard.id}
            const first = after ? ids.slice(0, i + 1) : [...ids.slice(0, i), continuation.id]
            const second = after ? [continuation.id, ...ids.slice(i + 1)] : [c.id, ...ids.slice(i + 1)]
            const kept: TransmissionLineRecord = {...line, to: yardEnd, circuitIds: first}
            push({type: 'upsert', collection: 'lines', record: kept})
            const ln = lineNaming(probe, undefined, yardEnd, line.to, lineNameVoltage(probe, second, line.voltage))
            const added: TransmissionLineRecord = {id: uniqueId(probe, ln.id), name: ln.name, voltage: line.voltage, planned: line.planned, from: yardEnd, to: line.to, circuitIds: second}
            push({type: 'upsert', collection: 'lines', record: added})
            plan.splitLines.push({line: kept, added})
        }
        plan.circuits.push({original: probe.circuits.find(x => x.id === c.id)!, continuation: probe.circuits.find(x => x.id === continuation.id)!})
    }
    plan.lines = [...touchedLines.values()]
    plan.ops = ops

    // both parts must meet at the via point: never hand out a plan that leaves a cut end loose
    for (const x of plan.circuits) {
        if (!circuitEndConnection(probe, x.original.id, CIRCUIT_END_TO)) plan.errors.push(`${x.original.name}: its end at ${plan.viaLabel} would be left unconnected`)
        if (!circuitEndConnection(probe, x.continuation.id, CIRCUIT_END_FROM)) plan.errors.push(`${x.continuation.name}: its end at ${plan.viaLabel} would be left unconnected`)
    }

    // circuits on a reused path that runs the other way follow its direction: their FROM and TO ends swap
    const reverse = (circuitId: string) => {
        for (const conn of probe.connections) {
            if (!conn.nodes.some(n => n.kind === NetworkNodeKind.TRANSMISSION_CIRCUIT && n.id === circuitId)) continue
            push({type: 'upsert', collection: 'connections', record: {...conn, nodes: conn.nodes.map(n => n.kind === NetworkNodeKind.TRANSMISSION_CIRCUIT && n.id === circuitId
                    ? {...n, terminal: n.terminal === CIRCUIT_END_FROM ? CIRCUIT_END_TO : CIRCUIT_END_FROM} : n)}})
        }
    }
    if (yard) {
        const w = deEnergizedEntryWarning(chosen, `yard ${place.site?.groupName ?? ''} ${yard.yardName}`, yard.voltage)
        if (w) plan.warnings.push(w)
    }
    if (reversedA) {
        for (const x of plan.circuits) reverse(x.original.id)
        plan.warnings.push(`path ${pathA.name} runs ${refLabel(doc, pathA.from)} → ${refLabel(doc, pathA.to)}: ${plan.circuits.map(x => x.original.name).join(', ')} follow its direction (FROM and TO swap)`)
    }
    if (reversedB) {
        for (const x of plan.circuits) reverse(x.continuation.id)
        plan.warnings.push(`path ${pathB.name} runs ${refLabel(doc, pathB.from)} → ${refLabel(doc, pathB.to)}: ${plan.circuits.map(x => x.continuation.name).join(', ')} follow its direction (FROM and TO swap)`)
    }
    // both parts went to existing paths: the original is left without circuits
    if (plan.pathCut && reuseA && reuseB) {
        push({type: 'delete', collection: 'paths', id: path.id})
        plan.removedPath = path
    }

    // 5. optional: names / ids by the rules (circuits, paths and lines changed their ends; reused paths keep theirs)
    const targets = [
        ...(reuseA ? [] : [{collection: 'paths' as const, id: pathA.id}]), ...(reuseB ? [] : [{collection: 'paths' as const, id: pathB.id}]),
        ...plan.circuits.flatMap(x => [{collection: 'circuits' as const, id: x.original.id}, {collection: 'circuits' as const, id: x.continuation.id}]),
        ...plan.splitLines.flatMap(x => [{collection: 'lines' as const, id: x.line.id}, {collection: 'lines' as const, id: x.added.id}]),
    ]
    const regenerate = regenerateNamingOps(probe, targets, {id: true, name: true})
    plan.regenerate = {ops: regenerate.ops, changes: regenerate.changes}
    return plan
}
