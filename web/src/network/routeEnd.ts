/**
 * Routing circuits of a path to (or from) another site or junction: the circuits no longer end at the path's TO end
 * (FROM end) but run on past it to the new place.
 *
 * Each chosen circuit is detached at that end and spliced, in a node of its own at the end's junction (the line
 * junction the path ends at, or the site's own junction, created when missing), with new sections (same make-up) that
 * run from that end out to the new place: one per path of the route taken. The route is either existing paths that
 * already lead there, directly or through line junctions (`routeEndRoutes`; consecutive sections are spliced in a node
 * of their own at each junction passed, and sections on a path running the other way follow its direction), or a new,
 * straight path. At the new place the last section enters a yard through a new take-off (only a yard at the voltage
 * every chosen circuit runs at, as for routing via a yard) or ends in a node of its own at a junction (the site's own
 * junction, created when missing). Lines through a circuit now end at the new place (the yard, or the junction): the
 * sections beyond the old end leave the line and the new sections take their place. A take-off left without a circuit
 * at the old end is reported, and removed on request (with its wiring in the yard).
 * Pure: returns ops plus a summary for the confirmation.
 */
import {genericConductor} from '@shared/models/transmission.conductor'
import {
    CIRCUIT_END_FROM,
    CIRCUIT_END_TO,
    CircuitEnd,
    ConnectionJunctionKind,
    ConnectionJunctionRef,
    ConnectionRecord,
    NetworkDocument,
    NetworkNodeKind,
    SubstationTakeOffRecord,
    TransmissionCircuitRecord,
    TransmissionJunctionRecord,
    TransmissionLineRecord,
    TransmissionPathRecord,
} from '@shared/network/records'
import {applyOps, cascadeDeleteOps, NetworkOp, uniqueId} from '@shared/network/ops'
import {circuitNaming, pathNaming, regenerateNamingOps, RegenerateChange, RegenerateTarget} from '@shared/network/naming'
import {atPathEnd, junctionRef, pathEndOf, siteOfRef, yardRef} from '@shared/network/refs'
import {newSiteJunctionRecord, siteJunctionOf} from '@shared/network/siteJunction'
import {attachCircuitEndToJunctionOps, attachCircuitEndToTakeOffOps, circuitEndConnection, detachCircuitEndOps, refLabel} from './linkOps'
import {haversineKm, locationOfRef} from './mapUtil'
import {placeKey} from './mergePaths'
import {polylineKm} from './splitPath'
import {newTakeOffToward, nodeVoltage, resolveRoutePlace, RouteVia, routePlaceLabel, runVoltage, samePlace, viaPathEnd} from './routeVia'

/** The new place the circuits run to (or come from): spliced at a junction (a line junction or a site's junction), or into a yard. */
export type RouteTarget = RouteVia

const otherEnd = (end: CircuitEnd): CircuitEnd => end === CIRCUIT_END_TO ? CIRCUIT_END_FROM : CIRCUIT_END_TO

/** One path of the way out from the path's end to the new place. */
export interface RouteEndHop {
    path: TransmissionPathRecord
    /**
     * The path runs against the way the circuits go (toward the old end for route to, away from it for route from):
     * the sections on it follow the path, their FROM and TO swapped.
     */
    reversed: boolean
}

/** A way from the path's end to the new place over existing paths. */
export interface RouteEndRoute {
    /** From the old end outward. */
    hops: RouteEndHop[]
    /** Line junctions passed between the hops, outward. */
    via: TransmissionJunctionRecord[]
    /** Length of the paths' routes. */
    km?: number
}

/** Paths in a route at most; routes offered at most. */
const MAX_HOPS = 4
const MAX_ROUTES = 6

const pathKm = (doc: NetworkDocument, p: TransmissionPathRecord) => {
    const a = locationOfRef(doc, p.from), b = locationOfRef(doc, p.to)
    return a && b ? polylineKm([a.coords, ...p.waypoints, b.coords]) : undefined
}

/** Key of a route by its paths, from the old end outward (what `RouteEndOptions.reusePathIds` carries). */
export const routeKey = (route: RouteEndRoute) => route.hops.map(h => h.path.id).join('+')

/**
 * Existing paths that lead from the path's `end` to the new place: one path between the two (either direction), or a
 * chain of paths through line junctions (never through a site, which would be entered, nor back past the path's own
 * ends). Shortest first; a chain more than three times as long as the straight distance is a detour and left out.
 */
export function routeEndRoutes(doc: NetworkDocument, pathId: string, end: CircuitEnd, target: RouteTarget): RouteEndRoute[] {
    const path = doc.paths.find(p => p.id === pathId)
    const endRef = end === CIRCUIT_END_TO ? path?.to : path?.from
    const goal = viaPathEnd(doc, target)
    const start = placeKey(doc, endRef), goalKey = placeKey(doc, goal)
    if (!path || !start || !goalKey) return []
    const avoid = placeKey(doc, end === CIRCUIT_END_TO ? path.from : path.to)
    const found: RouteEndRoute[] = []
    const walk = (at: string, hops: RouteEndHop[], via: TransmissionJunctionRecord[], seen: Set<string>) => {
        if (hops.length >= MAX_HOPS || found.length >= 50) return
        for (const p of doc.paths) {
            if (p.id === path.id || hops.some(h => h.path.id === p.id)) continue
            const fromKey = placeKey(doc, p.from), toKey = placeKey(doc, p.to)
            if (!fromKey || !toKey || fromKey === toKey || (fromKey !== at && toKey !== at)) continue
            const outward = fromKey === at
            const nextKey = outward ? toKey : fromKey
            // the circuits go outward for route to, inward for route from
            const hop: RouteEndHop = {path: p, reversed: outward !== (end === CIRCUIT_END_TO)}
            if (nextKey === goalKey) found.push({hops: [...hops, hop], via})
            else if (nextKey.startsWith('J:') && !seen.has(nextKey) && nextKey !== avoid) {
                const junction = doc.junctions.find(j => j.id === nextKey.slice(2))
                if (junction) walk(nextKey, [...hops, hop], [...via, junction], new Set([...seen, nextKey]))
            }
        }
    }
    walk(start, [], [], new Set([start]))
    const a = locationOfRef(doc, endRef), b = locationOfRef(doc, goal)
    const straight = a && b ? haversineKm(a.coords, b.coords) : undefined
    return found
        .map(r => {
            const kms = r.hops.map(h => pathKm(doc, h.path))
            return {...r, km: kms.every((k): k is number => k !== undefined) ? kms.reduce((s, k) => s + k, 0) : undefined}
        })
        .filter(r => r.hops.length === 1 || straight === undefined || r.km === undefined || r.km <= 3 * straight + 1)
        .sort((x, y) => (x.km ?? Infinity) - (y.km ?? Infinity) || x.hops.length - y.hops.length
            || doc.circuits.filter(c => c.pathId === y.hops[0].path.id).length - doc.circuits.filter(c => c.pathId === x.hops[0].path.id).length)
        .slice(0, MAX_ROUTES)
}

/**
 * Take-offs at the path's `end` that routing these circuits away would leave without a circuit: their transmission
 * connection holds nothing but those circuits' ends there.
 */
export function freedTakeOffs(doc: NetworkDocument, circuitIds: string[], end: CircuitEnd): SubstationTakeOffRecord[] {
    const out: SubstationTakeOffRecord[] = []
    for (const id of circuitIds) {
        const conn = circuitEndConnection(doc, id, end)
        if (!conn || conn.junction.kind !== ConnectionJunctionKind.SUBSTATION) continue
        const others = conn.nodes.some(n => n.kind === NetworkNodeKind.TRANSMISSION_CIRCUIT && !(circuitIds.includes(n.id) && n.terminal === end))
        const takeOff = doc.takeOffs.find(t => conn.nodes.some(n => n.kind === NetworkNodeKind.SUBSTATION_TAKE_OFF && n.id === t.id))
        if (!others && takeOff && !out.includes(takeOff)) out.push(takeOff)
    }
    return out
}

export interface RouteEndOptions {
    /**
     * Run the new sections on these existing paths, from the old end outward (the paths of a route from
     * `routeEndRoutes`, see `routeKey`); unset or empty: on a new straight path.
     */
    reusePathIds?: string[]
    /** Delete the take-offs at the old end left without a circuit (`freedTakeOffs`), with their wiring in the yard. */
    removeFreedTakeOffs?: boolean
}

export interface RouteEndPlan {
    ops: NetworkOp[]
    /** The end of the path the circuits are routed away from: TO = route to, FROM = route from. */
    end: CircuitEnd
    /** The path end left behind, and the new place, as labels. */
    endLabel: string
    targetLabel: string
    /** The junction at the old end where each circuit is spliced with its first new section. */
    passJunction?: TransmissionJunctionRecord
    /** Site junctions created on the way (at the old end, at the new place). */
    createdJunctions: TransmissionJunctionRecord[]
    /** The paths the new sections run on, from the old end outward; `created`: the new straight path. */
    hops: (RouteEndHop & { created: boolean })[]
    /** Line junctions passed between the hops. */
    via: TransmissionJunctionRecord[]
    /** Each circuit with its new sections, from the old end outward. */
    circuits: { original: TransmissionCircuitRecord; sections: TransmissionCircuitRecord[] }[]
    /** New take-offs at the new place. */
    takeOffs: SubstationTakeOffRecord[]
    /** Take-offs at the old end left without a circuit; `takeOffsRemoved`: they are deleted (else kept). */
    freedTakeOffs: SubstationTakeOffRecord[]
    takeOffsRemoved: boolean
    /** Lines that now end at the new place; `dropped`: their sections beyond the old end. */
    lines: { line: TransmissionLineRecord; dropped: TransmissionCircuitRecord[] }[]
    /** Notes for the confirmation. */
    warnings: string[]
    /** Optional follow-up: names / ids of the new path, the circuits and the lines by the model rules. */
    regenerate: { ops: NetworkOp[]; changes: RegenerateChange[] }
    errors: string[]
}

export function buildRouteEndPlan(doc: NetworkDocument, pathId: string, circuitIds: string[], end: CircuitEnd, target: RouteTarget, opts: RouteEndOptions = {}): RouteEndPlan {
    const plan: RouteEndPlan = {
        ops: [], end, endLabel: '', targetLabel: '', createdJunctions: [], hops: [], via: [], circuits: [], takeOffs: [], freedTakeOffs: [], takeOffsRemoved: false, lines: [],
        warnings: [], regenerate: {ops: [], changes: []}, errors: [],
    }
    const fail = (e: string) => ({...plan, errors: [e]})
    const path = doc.paths.find(p => p.id === pathId)
    if (!path) return fail('the path no longer exists')
    const endRef = end === CIRCUIT_END_TO ? path.to : path.from
    const otherRef = end === CIRCUIT_END_TO ? path.from : path.to
    if (!endRef || !locationOfRef(doc, endRef)) return fail(`set the path's ${end} end first`)
    const chosen = doc.circuits.filter(c => c.pathId === path.id && circuitIds.includes(c.id))
    if (!chosen.length) return fail('check at least one circuit of the path')
    const place = resolveRoutePlace(doc, target, chosen)
    if (typeof place === 'string') return fail(place)
    const targetRef = place.ref
    if (samePlace(doc, targetRef, path.from) || samePlace(doc, targetRef, path.to)) return fail(`the path already ${samePlace(doc, targetRef, endRef) ? 'ends' : 'starts'} at ${refLabel(doc, targetRef)}`)
    plan.endLabel = refLabel(doc, endRef)
    let route: RouteEndRoute | undefined
    if (opts.reusePathIds?.length) {
        route = routeEndRoutes(doc, path.id, end, target).find(r => routeKey(r) === opts.reusePathIds!.join('+'))
        if (!route) return fail(`path${opts.reusePathIds.length === 1 ? '' : 's'} ${opts.reusePathIds.join(', ')} no longer lead${opts.reusePathIds.length === 1 ? 's' : ''} from ${plan.endLabel} to ${refLabel(doc, targetRef)}`)
    }

    const ops: NetworkOp[] = []
    let probe = doc
    const push = (...next: NetworkOp[]) => {
        ops.push(...next)
        probe = applyOps(probe, next)
    }

    // 1. where the circuits pass the old end: the junction the path ends at, or the site's own junction
    let pass: TransmissionJunctionRecord | undefined
    if (endRef.kind === ConnectionJunctionKind.TRANSMISSION_JUNCTION) {
        pass = doc.junctions.find(j => j.id === endRef.id)
        if (!pass) return fail(`the junction at the path's ${end} end no longer exists`)
    } else {
        const site = doc.substationGroups.find(g => g.id === siteOfRef(doc, endRef))
        if (!site) return fail(`the site at the path's ${end} end no longer exists`)
        pass = siteJunctionOf(doc, site.id)
        if (!pass) {
            pass = newSiteJunctionRecord(probe, site)
            push({type: 'upsert', collection: 'junctions', record: pass})
            plan.createdJunctions.push(pass)
        }
    }
    plan.passJunction = pass
    const endPathRef = pathEndOf(doc, endRef) ?? endRef

    // 2. the new place: a yard, or a junction (a site's own, created when missing)
    let junction = place.junction
    if (target.kind === 'siteJunction' && !junction) {
        junction = newSiteJunctionRecord(probe, place.site!)
        push({type: 'upsert', collection: 'junctions', record: junction})
        plan.createdJunctions.push(junction)
    }
    plan.targetLabel = routePlaceLabel(place, junction)

    // 3. the paths of the new sections: the existing ones asked for, else a new straight one, running away from the
    // old end (route to) or toward it (route from)
    if (route) {
        plan.hops = route.hops.map(h => ({...h, created: false}))
        plan.via = route.via
    } else {
        const [from, to] = end === CIRCUIT_END_TO ? [endPathRef, targetRef] : [targetRef, endPathRef]
        const pn = pathNaming(probe, from, to)
        const created: TransmissionPathRecord = {id: uniqueId(probe, pn.id), name: pn.name, from, to, waypoints: []}
        push({type: 'upsert', collection: 'paths', record: created})
        plan.hops = [{path: created, reversed: false, created: true}]
    }
    const hopKms = plan.hops.map(h => pathKm(probe, h.path))
    /** A section's end at the inner side of its hop (toward the old end): sections run with their path. */
    const innerEnd = (hop: RouteEndHop): CircuitEnd => (end === CIRCUIT_END_TO) !== hop.reversed ? CIRCUIT_END_FROM : CIRCUIT_END_TO

    // 4. every chosen circuit
    const touches = (conn: ConnectionRecord | undefined, id: string | undefined) => !!conn && !!id && conn.nodes.some(n => n.kind === NetworkNodeKind.TRANSMISSION_CIRCUIT && n.id === id)
    const lineEdits = new Map<string, string[]>()   // line id → dropped section ids
    for (const c of chosen) {
        const oldConn = circuitEndConnection(probe, c.id, end)
        const voltage = nodeVoltage(c)
        const lines = probe.lines.filter(l => l.circuitIds.includes(c.id))
        /** Whether the line's sections after this circuit are on the side of the old end (else the ones before it). */
        const oldEndAfter = (line: TransmissionLineRecord) => {
            const i = line.circuitIds.indexOf(c.id)
            return touches(oldConn, line.circuitIds[i + 1]) ? true : touches(oldConn, line.circuitIds[i - 1]) ? false
                : atPathEnd(doc, line.to, endRef) ? true : atPathEnd(doc, line.from, endRef) ? false : end === CIRCUIT_END_TO
        }
        // a take-off is named after the far station the line comes from, not a line junction
        const farLineEnd = lines[0] && (oldEndAfter(lines[0]) ? lines[0].from : lines[0].to)
        const toward = pathEndOf(probe, otherRef)?.kind === ConnectionJunctionKind.SUBSTATION_GROUP ? otherRef : (farLineEnd ?? otherRef)

        // off the old end: a take-off left there without circuits is reported (and removed below when asked)
        push(...detachCircuitEndOps(probe, c.id, end))
        if (oldConn?.junction.kind === ConnectionJunctionKind.SUBSTATION && !probe.connections.some(x => x.id === oldConn.id)) {
            const t = probe.takeOffs.find(x => oldConn.nodes.some(n => n.kind === NetworkNodeKind.SUBSTATION_TAKE_OFF && n.id === x.id))
            if (t) plan.freedTakeOffs.push(t)
        }

        // spliced at the old end in a node of its own (keeping the id / name of a node there that held this end alone)
        const keepNode = !!oldConn && oldConn.junction.kind === ConnectionJunctionKind.TRANSMISSION_JUNCTION && oldConn.junction.id === pass.id && !probe.connections.some(x => x.id === oldConn.id)
        const at = attachCircuitEndToJunctionOps(probe, c.id, end, pass.id, voltage, keepNode ? {forceNew: true, newId: oldConn!.id, newName: oldConn!.name} : {forceNew: true})
        push(...at)

        // the new sections, one per hop outward (same make-up, as long as their path when the circuit's length is
        // kept), each spliced to the one before in a node of its own; the last one ends at the new place
        const lineName = lines.map(l => l.name).sort()[0]
        let node = at[0]?.type === 'upsert' ? at[0].record as ConnectionRecord : undefined
        const sections: TransmissionCircuitRecord[] = []
        plan.hops.forEach((hop, k) => {
            const cn = circuitNaming(probe, {pathId: hop.path.id, lineName, voltage: c.voltage ?? c.energizedVoltage})
            const section: TransmissionCircuitRecord = {
                id: uniqueId(probe, cn.id), name: cn.name, pathId: hop.path.id,
                voltage: c.voltage, energizedVoltage: c.energizedVoltage, bundle: c.bundle, conductor: c.conductor ? {...c.conductor} : genericConductor(),
                conductorTemplateId: c.conductorTemplateId, planned: c.planned,
                lengthKm: c.lengthKm !== undefined && hopKms[k] !== undefined ? Number(hopKms[k]!.toFixed(2)) : undefined,
            }
            push({type: 'upsert', collection: 'circuits', record: section})
            const inner = innerEnd(hop), outer = otherEnd(inner)
            if (node) push(...attachCircuitEndToJunctionOps(probe, section.id, inner, k === 0 ? pass!.id : plan.via[k - 1].id, voltage, {connectionId: node.id}))
            if (k < plan.hops.length - 1) {
                const next = attachCircuitEndToJunctionOps(probe, section.id, outer, plan.via[k].id, voltage, {forceNew: true})
                push(...next)
                node = next[0]?.type === 'upsert' ? next[0].record as ConnectionRecord : undefined
            } else if (place.yard) {
                const takeOff = newTakeOffToward(probe, place.yard.id, toward, runVoltage(c))
                push({type: 'upsert', collection: 'takeOffs', record: takeOff})
                plan.takeOffs.push(takeOff)
                push(...attachCircuitEndToTakeOffOps(probe, section.id, outer, takeOff.id))
            } else push(...attachCircuitEndToJunctionOps(probe, section.id, outer, junction!.id, voltage, {forceNew: true}))
            sections.push(section)
        })

        // lines: the new sections take the place of the sections beyond the old end, and the line ends at the new
        // place (the yard, or the junction)
        const ids = sections.map(s => s.id)
        for (const line of lines) {
            const lineIds = line.circuitIds
            const i = lineIds.indexOf(c.id)
            const after = oldEndAfter(line)
            const updated: TransmissionLineRecord = {...line, circuitIds: after ? [...lineIds.slice(0, i + 1), ...ids] : [...[...ids].reverse(), ...lineIds.slice(i)]}
            updated[after ? 'to' : 'from'] = place.yard ? yardRef(place.yard.id) : junctionRef(junction!.id)
            push({type: 'upsert', collection: 'lines', record: updated})
            lineEdits.set(line.id, [...(lineEdits.get(line.id) ?? []), ...(after ? lineIds.slice(i + 1) : lineIds.slice(0, i))])
        }
        plan.circuits.push({original: c, sections})
    }

    // 5. a take-off left without a circuit at the old end: removed when asked, with its wiring in the yard
    if (opts.removeFreedTakeOffs) for (const t of plan.freedTakeOffs) push(...cascadeDeleteOps(probe, 'takeOffs', t.id))
    plan.takeOffsRemoved = !!opts.removeFreedTakeOffs && plan.freedTakeOffs.length > 0
    plan.ops = ops
    const circuitOf = (id: string) => probe.circuits.find(c => c.id === id)
    plan.circuits = plan.circuits.map(x => ({original: circuitOf(x.original.id)!, sections: x.sections.map(s => circuitOf(s.id)!)}))

    // every section joined at both ends: never hand out a plan that leaves an end loose
    for (const x of plan.circuits) {
        if (!circuitEndConnection(probe, x.original.id, end)) plan.errors.push(`${x.original.name}: its end at ${plan.endLabel} would be left unconnected`)
        for (const s of x.sections) for (const e of [CIRCUIT_END_FROM, CIRCUIT_END_TO] as CircuitEnd[]) {
            if (!circuitEndConnection(probe, s.id, e)) plan.errors.push(`${s.name}: its ${e} end would be left unconnected`)
        }
    }

    // the summary: lines and the sections they left behind, reversed paths, freed take-offs
    plan.lines = [...lineEdits].map(([id, dropped]) => ({line: probe.lines.find(l => l.id === id)!, dropped: dropped.map(circuitOf).filter((c): c is TransmissionCircuitRecord => !!c)})).filter(x => x.line)
    const lineless = [...new Set(plan.lines.flatMap(x => x.dropped))].filter(c => !probe.lines.some(l => l.circuitIds.includes(c.id)))
    if (lineless.length) plan.warnings.push(`${lineless.map(c => c.name).join(', ')} (beyond ${plan.endLabel}) no longer belong${lineless.length === 1 ? 's' : ''} to a line`)
    // lines that shared the circuit up to a tee at the old end now run the same sections
    const sameRun = (x: TransmissionLineRecord, y: TransmissionLineRecord) => x.circuitIds.length === y.circuitIds.length && x.circuitIds.every(id => y.circuitIds.includes(id))
    const twins = plan.lines.filter((x, i) => plan.lines.some((y, k) => k !== i && sameRun(x.line, y.line))).map(x => x.line.name)
    if (twins.length) plan.warnings.push(`${twins.join(', ')} now run the same sections (they shared a circuit up to ${plan.endLabel}): delete the one not needed`)
    const reversed = plan.hops.filter(h => h.reversed)
    if (reversed.length) plan.warnings.push(`${reversed.map(h => `path ${h.path.name} runs ${refLabel(doc, h.path.from)} → ${refLabel(doc, h.path.to)}`).join('; ')}: the new sections on ${reversed.length === 1 ? 'it follow its' : 'them follow their'} direction (FROM and TO swap)`)
    if (plan.freedTakeOffs.length && !plan.takeOffsRemoved) {
        plan.warnings.push(`take-off${plan.freedTakeOffs.length === 1 ? '' : 's'} ${plan.freedTakeOffs.map(t => `${t.lineName} (${refLabel(doc, yardRef(t.substationId))})`).join(', ')} ${plan.freedTakeOffs.length === 1 ? 'is' : 'are'} left without a circuit (kept)`)
    }

    // 6. optional: names / ids by the rules (reused paths keep their names; a line without both ends has no rule name)
    const targets: RegenerateTarget[] = plan.hops.filter(h => h.created).map(h => ({collection: 'paths', id: h.path.id}))
    for (const x of plan.lines) if (x.line.from && x.line.to) targets.push({collection: 'lines', id: x.line.id})
    const renamedCircuits = new Set([...plan.circuits.flatMap(x => [x.original.id, ...x.sections.map(s => s.id)]), ...plan.lines.flatMap(x => [...x.line.circuitIds, ...x.dropped.map(c => c.id)])])
    for (const id of renamedCircuits) targets.push({collection: 'circuits', id})
    const regenerate = regenerateNamingOps(probe, targets, {id: true, name: true})
    plan.regenerate = {ops: regenerate.ops, changes: regenerate.changes}
    return plan
}
