/**
 * Splitting a transmission path with a new junction.
 *
 * The path is cut at the segment nearest to the chosen point: its waypoints
 * before the cut stay on the (shortened) path, the ones after go to a new
 * path from the junction to the old TO end. Every circuit on the path is
 * split the same way: the original keeps the first part and is re-attached
 * at the junction, a continuation circuit (same voltage, bundle and
 * conductor; length shared by distance) runs the second part, joined to the
 * original in one node at the junction and attached where the original used
 * to end. Lines keep their sections: the continuation is inserted next to
 * the original so the chain still reads end to end. Pure: returns ops.
 */
import type {CoordinatesProps} from '@shared/models/coordinates'
import {genericConductor} from '@shared/models/transmission.conductor'
import {
    CIRCUIT_END_FROM,
    CIRCUIT_END_TO,
    ConnectionJunctionKind,
    ConnectionJunctionRef,
    ConnectionRecord,
    NetworkDocument,
    NetworkNodeKind,
    TransmissionCircuitRecord,
    TransmissionJunctionRecord,
    TransmissionLineRecord,
    TransmissionPathRecord,
} from '@shared/network/records'
import {applyOps, NetworkOp, pickId, uniqueId} from '@shared/network/ops'
import {circuitNaming, junctionNaming, pathNaming, regenerateNamingOps, RegenerateChange} from '@shared/network/naming'
import {attachCircuitEndToJunctionOps, attachCircuitEndToTakeOffOps, circuitEndConnection, detachCircuitEndOps} from './linkOps'
import {atPathEnd, junctionRef, pathEndOf} from '@shared/network/refs'
import {haversineKm, locationOfRef} from './mapUtil'

export interface SplitPathOptions {
    /** Name of the new junction (when empty, the rule name after the site closest to it, `<site>_J<n>`). */
    junctionName?: string
    /** Id of the new junction (generated when empty). */
    junctionId?: string
    /** Split at this existing junction instead of creating one: the path is cut at the segment nearest to it. */
    existingJunctionId?: string
}

export interface SplitPathPlan {
    ops: NetworkOp[]
    junction?: TransmissionJunctionRecord
    /** False when an existing junction was used. */
    junctionCreated: boolean
    /** The original path, now ending at the junction, and the new path from the junction on. */
    pathA?: TransmissionPathRecord
    pathB?: TransmissionPathRecord
    circuits: { original: TransmissionCircuitRecord; continuation: TransmissionCircuitRecord }[]
    /** Lines whose sections were re-sequenced. */
    lines: TransmissionLineRecord[]
    /** Optional follow-up: re-derive names / ids of the split circuits and paths from the model rules. */
    regenerate: { ops: NetworkOp[]; changes: RegenerateChange[] }
    errors: string[]
}


/** Index of the polyline segment nearest to `p` (equirectangular, good enough at line scale). */
export function nearestSegment(points: CoordinatesProps[], p: CoordinatesProps): number {
    const k = Math.cos(p.latitude * Math.PI / 180)
    const xy = (c: CoordinatesProps) => ({x: c.longitude * k, y: c.latitude})
    const q = xy(p)
    let best = 0, bestD = Infinity
    for (let i = 0; i < points.length - 1; i++) {
        const a = xy(points[i]), b = xy(points[i + 1])
        const dx = b.x - a.x, dy = b.y - a.y
        const len2 = dx * dx + dy * dy
        const t = len2 ? Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / len2)) : 0
        const d = Math.hypot(q.x - (a.x + t * dx), q.y - (a.y + t * dy))
        if (d < bestD) {
            bestD = d
            best = i
        }
    }
    return best
}

export const polylineKm = (pts: CoordinatesProps[]) => pts.slice(1).reduce((s, c, i) => s + haversineKm(pts[i], c), 0)

/**
 * `at`: where the new junction goes (a map click); ignored when
 * `opts.existingJunctionId` names the junction to split at, whose position is
 * used instead.
 */
export function buildSplitPathPlan(doc: NetworkDocument, pathId: string, at: CoordinatesProps | undefined, opts: SplitPathOptions = {}): SplitPathPlan {
    const empty = (errors: string[]): SplitPathPlan => ({ops: [], junctionCreated: false, circuits: [], lines: [], regenerate: {ops: [], changes: []}, errors})
    const path = doc.paths.find(p => p.id === pathId)
    if (!path) return empty(['the path no longer exists'])
    const from = locationOfRef(doc, path.from), to = locationOfRef(doc, path.to)
    if (!from || !to) return empty(['set both ends of the path before splitting it'])
    const existing = opts.existingJunctionId ? doc.junctions.find(j => j.id === opts.existingJunctionId) : undefined
    if (opts.existingJunctionId && !existing) return empty(['the chosen junction no longer exists'])
    if (existing && (atPathEnd(doc, junctionRef(existing.id), path.from) || atPathEnd(doc, junctionRef(existing.id), path.to))) return empty([`the path already ends at ${existing.name ?? existing.id}`])
    const where = existing?.coords ?? at
    if (!where) return empty(['click on the path where the junction goes, or pick an existing junction'])

    const points = [from.coords, ...path.waypoints, to.coords]
    const k = nearestSegment(points, where)   // waypoints[0..k) stay, waypoints[k..] move to the new path
    const coords = {latitude: Number(where.latitude.toFixed(6)), longitude: Number(where.longitude.toFixed(6))}
    const kmA = polylineKm([from.coords, ...path.waypoints.slice(0, k), coords])
    const kmB = polylineKm([coords, ...path.waypoints.slice(k), to.coords])
    const ratio = kmA + kmB > 0 ? kmA / (kmA + kmB) : 0.5

    const ops: NetworkOp[] = []
    let probe = doc
    const push = (...next: NetworkOp[]) => {
        ops.push(...next)
        probe = applyOps(probe, next)
    }

    // 1. the junction: the chosen existing one, or a new one at the click
    let junction: TransmissionJunctionRecord
    if (existing) junction = existing
    else {
        const jn = junctionNaming(doc, opts.junctionName, coords)
        junction = {id: pickId(doc, opts.junctionId, jn.id), name: jn.name, coords}
        push({type: 'upsert', collection: 'junctions', record: junction})
    }
    // Path ends: a site junction stands for its site.
    const jRef: ConnectionJunctionRef = pathEndOf(probe, junctionRef(junction.id)) ?? junctionRef(junction.id)

    // 2. the two paths
    const pathA: TransmissionPathRecord = {...path, to: jRef, waypoints: path.waypoints.slice(0, k)}
    push({type: 'upsert', collection: 'paths', record: pathA})
    const pn = pathNaming(probe, jRef, path.to)
    const pathB: TransmissionPathRecord = {id: uniqueId(probe, pn.id), name: pn.name, from: jRef, to: path.to, waypoints: path.waypoints.slice(k)}
    push({type: 'upsert', collection: 'paths', record: pathB})

    // 3. every circuit on the path
    const circuits: SplitPathPlan['circuits'] = []
    const touchedLines = new Map<string, TransmissionLineRecord>()
    const touches = (conn: ConnectionRecord | undefined, circuitId: string | undefined) => !!conn && !!circuitId && conn.nodes.some(n => n.kind === NetworkNodeKind.TRANSMISSION_CIRCUIT && n.id === circuitId)
    for (const c of doc.circuits.filter(x => x.pathId === path.id)) {
        const oldTo = circuitEndConnection(doc, c.id, CIRCUIT_END_TO)

        // the original ends at the junction now, in a node of its own
        push(...detachCircuitEndOps(probe, c.id, CIRCUIT_END_TO))
        const atJunction = attachCircuitEndToJunctionOps(probe, c.id, CIRCUIT_END_TO, junction.id, c.voltage, {forceNew: true})
        push(...atJunction)
        const node = atJunction[0].type === 'upsert' ? atJunction[0].record as ConnectionRecord : undefined

        // the continuation: same make-up, the rest of the length
        const cn = circuitNaming(probe, {pathId: pathB.id, lineName: doc.lines.filter(l => l.circuitIds.includes(c.id)).map(l => l.name).sort()[0], voltage: c.voltage ?? c.energizedVoltage})
        const continuation: TransmissionCircuitRecord = {
            id: uniqueId(probe, cn.id), name: cn.name, pathId: pathB.id,
            voltage: c.voltage, energizedVoltage: c.energizedVoltage, bundle: c.bundle, conductor: c.conductor ? {...c.conductor} : genericConductor(), conductorTemplateId: c.conductorTemplateId,
            lengthKm: c.lengthKm !== undefined ? Number((c.lengthKm * (1 - ratio)).toFixed(2)) : undefined,
        }
        push({type: 'upsert', collection: 'circuits', record: continuation})
        if (c.lengthKm !== undefined) {
            const current = probe.circuits.find(x => x.id === c.id) ?? c
            push({type: 'upsert', collection: 'circuits', record: {...current, lengthKm: Number((c.lengthKm * ratio).toFixed(2))}})
        }
        if (node) push(...attachCircuitEndToJunctionOps(probe, continuation.id, CIRCUIT_END_FROM, junction.id, continuation.voltage, {connectionId: node.id}))
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

        // lines: the continuation goes next to the original, on the side that used to lead on from the old TO end
        for (const line of probe.lines.filter(l => l.circuitIds.includes(c.id))) {
            const ids = line.circuitIds
            const i = ids.indexOf(c.id)
            const next = ids[i + 1], prev = ids[i - 1]
            const after = touches(oldTo, next) ? true : touches(oldTo, prev) ? false
                : atPathEnd(doc, line.to, path.to) ? true : atPathEnd(doc, line.from, path.to) ? false : true
            const circuitIds = [...ids.slice(0, after ? i + 1 : i), continuation.id, ...ids.slice(after ? i + 1 : i)]
            const updated = {...line, circuitIds}
            push({type: 'upsert', collection: 'lines', record: updated})
            touchedLines.set(line.id, updated)
        }
        circuits.push({original: probe.circuits.find(x => x.id === c.id) ?? c, continuation: probe.circuits.find(x => x.id === continuation.id) ?? continuation})
    }

    // 4. optional: names / ids by the rules (the original circuit now runs to the junction, the paths changed ends)
    const regenerate = regenerateNamingOps(probe, [
        {collection: 'paths', id: pathA.id}, {collection: 'paths', id: pathB.id},
        ...circuits.flatMap(x => [{collection: 'circuits' as const, id: x.original.id}, {collection: 'circuits' as const, id: x.continuation.id}]),
    ], {id: true, name: true})

    return {ops, junction, junctionCreated: !existing, pathA, pathB, circuits, lines: [...touchedLines.values()], regenerate: {ops: regenerate.ops, changes: regenerate.changes}, errors: []}
}
