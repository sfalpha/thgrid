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
 *   used, and each line through them is split there into two lines (a line
 *   runs yard to yard).
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
import type {TransmissionVoltage} from '@shared/models/transmission.voltage'
import {
    CIRCUIT_END_FROM,
    CIRCUIT_END_TO,
    ConnectionJunctionKind,
    ConnectionJunctionRef,
    ConnectionRecord,
    NetworkDocument,
    NetworkNodeKind,
    SubstationRecord,
    SubstationTakeOffRecord,
    TransmissionCircuitRecord,
    TransmissionJunctionRecord,
    TransmissionLineRecord,
    TransmissionPathRecord,
} from '@shared/network/records'
import {applyOps, NetworkOp, uniqueId} from '@shared/network/ops'
import {circuitNaming, lineNaming, pathNaming, regenerateNamingOps, RegenerateChange, takeOffLineName, takeOffNaming} from '@shared/network/naming'
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

/** The yards of a site and whether the chosen circuits may enter them: the yard must be at the voltage every one of them runs at. */
export function yardChoices(doc: NetworkDocument, groupId: string, circuits: TransmissionCircuitRecord[]): { yard: SubstationRecord; reason?: string }[] {
    const voltages = [...new Set(circuits.map(runVoltage))]
    return doc.substations.filter(y => y.groupId === groupId).sort((a, b) => a.yardName.localeCompare(b.yardName)).map(yard => ({
        yard,
        reason: circuits.length === 0 ? 'check circuits first'
            : voltages.length > 1 ? `the checked circuits run at different voltages (${voltages.map(v => v ?? 'unknown').join(', ')})`
                : voltages[0] === undefined ? 'the checked circuits have no voltage'
                    : voltages[0] !== yard.voltage ? `not at ${voltages[0]} (the voltage the circuits are energized at)` : undefined,
    }))
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
const samePlace = (doc: NetworkDocument, a?: ConnectionJunctionRef, b?: ConnectionJunctionRef) => !!a && !!b && (atPathEnd(doc, a, b) || atPathEnd(doc, b, a))

/**
 * Existing paths the two parts could run on instead of new ones: `before` between the path's FROM end and the via
 * point, `after` between the via point and its TO end (either direction; the path itself excluded).
 */
export function routeViaPathChoices(doc: NetworkDocument, pathId: string, via: RouteVia): { before: TransmissionPathRecord[]; after: TransmissionPathRecord[] } {
    const path = doc.paths.find(p => p.id === pathId)
    const viaRef = viaPathEnd(doc, via)
    if (!path || !viaRef) return {before: [], after: []}
    const between = (a?: ConnectionJunctionRef, b?: ConnectionJunctionRef) => doc.paths.filter(p => p.id !== path.id
        && ((samePlace(doc, p.from, a) && samePlace(doc, p.to, b)) || (samePlace(doc, p.from, b) && samePlace(doc, p.to, a))))
    // best first (the default pick): the most circuits, then the most waypoints
    const best = (list: TransmissionPathRecord[]) => list.sort((a, b) => doc.circuits.filter(c => c.pathId === b.id).length - doc.circuits.filter(c => c.pathId === a.id).length || b.waypoints.length - a.waypoints.length)
    return {before: best(between(path.from, viaRef)), after: best(between(viaRef, path.to))}
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
    let viaRef: ConnectionJunctionRef, coords: { latitude: number; longitude: number }
    let junction: TransmissionJunctionRecord | undefined, yard: SubstationRecord | undefined
    if (via.kind === 'junction') {
        junction = doc.junctions.find(j => j.id === via.junctionId)
        if (!junction) return fail('the junction no longer exists')
        viaRef = pathEndOf(doc, junctionRef(junction.id)) ?? junctionRef(junction.id)
        coords = junction.coords
        plan.viaLabel = `junction ${junction.name ?? junction.id}`
    } else {
        const groupId = via.kind === 'siteJunction' ? via.groupId : doc.substations.find(y => y.id === via.yardId)?.groupId
        const site = doc.substationGroups.find(g => g.id === groupId)
        if (!site) return fail('the site no longer exists')
        viaRef = siteRef(site.id)
        coords = site.coords
        if (via.kind === 'yard') {
            yard = doc.substations.find(y => y.id === via.yardId)!
            const reason = yardChoices(doc, site.id, chosen).find(x => x.yard.id === yard!.id)?.reason
            if (reason) return fail(`yard ${site.groupName} ${yard.yardName}: ${reason}`)
            plan.viaLabel = `yard ${site.groupName} ${yard.yardName} (${yard.voltage})`
        } else {
            junction = siteJunctionOf(doc, site.id)
            if (!junction) {
                junction = newSiteJunctionRecord(doc, site)
                push({type: 'upsert', collection: 'junctions', record: junction})
                plan.createdJunction = junction
            }
            plan.viaLabel = `site ${site.groupName}, through its junction ${junction.name ?? junction.id}`
        }
    }
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

    /** A new take-off in the yard, named toward `toward` (`<voltage>_<site>_L<n>`, numbered per target). */
    const newTakeOff = (target: ConnectionJunctionRef | undefined, voltage: TransmissionVoltage | undefined): SubstationTakeOffRecord => {
        const y = yard!
        const targetSite = target && pathEndOf(probe, target)?.kind === ConnectionJunctionKind.SUBSTATION_GROUP ? pathEndOf(probe, target)!.id : undefined
        let lineName = targetSite ? takeOffLineName(probe, y.id, targetSite, voltage) : undefined
        if (!lineName) {
            const code = target ? (probe.junctions.find(j => j.id === target.id)?.name ?? target.id) : 'OPEN'
            let n = 1
            while (probe.takeOffs.some(t => t.substationId === y.id && t.lineName === SubstationTakeOff.defaultLineName({targetCode: code, voltage, sequence: n}))) n++
            lineName = SubstationTakeOff.defaultLineName({targetCode: code, voltage, sequence: n})!
        }
        const naming = takeOffNaming(probe, y.id, lineName)
        const rec: SubstationTakeOffRecord = {id: uniqueId(probe, naming.id), name: naming.name, substationId: y.id, lineName, takeOffColumn: true}
        push({type: 'upsert', collection: 'takeOffs', record: rec})
        plan.takeOffs.push(rec)
        return rec
    }

    // 4. every chosen circuit
    const touches = (conn: ConnectionRecord | undefined, id: string | undefined) => !!conn && !!id && conn.nodes.some(n => n.kind === NetworkNodeKind.TRANSMISSION_CIRCUIT && n.id === id)
    const touchedLines = new Map<string, TransmissionLineRecord>()
    for (const c of chosen) {
        const oldTo = circuitEndConnection(doc, c.id, CIRCUIT_END_TO)
        const voltage = runVoltage(c)
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
            const at = attachCircuitEndToJunctionOps(probe, c.id, CIRCUIT_END_TO, junction.id, c.voltage, {forceNew: true})
            push(...at)
            const node = at[0]?.type === 'upsert' ? at[0].record as ConnectionRecord : undefined
            if (node) push(...attachCircuitEndToJunctionOps(probe, continuation.id, CIRCUIT_END_FROM, junction.id, continuation.voltage, {connectionId: node.id}))
        } else {
            // looped into the yard: a take-off toward each far end (created first: the attach must see it in `probe`)
            const back = newTakeOff(toward(path.from, false), voltage)
            push(...attachCircuitEndToTakeOffOps(probe, c.id, CIRCUIT_END_TO, back.id))
            const onward = newTakeOff(toward(path.to, true), voltage)
            push(...attachCircuitEndToTakeOffOps(probe, continuation.id, CIRCUIT_END_FROM, onward.id))
        }

        // the continuation ends where the original used to
        if (oldTo) {
            if (oldTo.junction.kind === ConnectionJunctionKind.SUBSTATION) {
                const takeOff = oldTo.nodes.find(n => n.kind === NetworkNodeKind.SUBSTATION_TAKE_OFF)
                if (takeOff) push(...attachCircuitEndToTakeOffOps(probe, continuation.id, CIRCUIT_END_TO, takeOff.id, {newId: oldTo.id, newName: oldTo.name}))
            } else {
                const still = probe.connections.some(x => x.id === oldTo.id)
                push(...attachCircuitEndToJunctionOps(probe, continuation.id, CIRCUIT_END_TO, oldTo.junction.id, continuation.voltage,
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
            const ln = lineNaming(probe, undefined, yardEnd, line.to, line.voltage)
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
