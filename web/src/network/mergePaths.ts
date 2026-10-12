/**
 * Duplicate paths: two or more paths between the same two places, in either
 * direction (a site, its yards and its site junction count as one place),
 * none of them with waypoints: a path with its own route (waypoints) is a
 * parallel line on another route, never a duplicate.
 * Merging keeps one of them: the circuits of the others move onto it, those
 * of a path running the other way following the kept path's direction (their
 * FROM and TO ends swap, as when a join or a route-via reuses a path), and
 * the others are deleted. The kept path keeps its route; a straight one (no
 * waypoints) takes over the route of the first merged path that has one.
 * Pure: returns ops plus a summary for the confirmation.
 */
import {CIRCUIT_END_FROM, CIRCUIT_END_TO, ConnectionJunctionKind, ConnectionJunctionRef, NetworkDocument, NetworkNodeKind, TransmissionPathRecord} from '@shared/network/records'
import {applyOps, NetworkOp} from '@shared/network/ops'
import {regenerateNamingOps, RegenerateChange} from '@shared/network/naming'
import {siteOfRef} from '@shared/network/refs'

/** The place a path end names: `G:<site>` for a site (or one of its yards, or its site junction), `J:<junction>` for a line junction. */
export function placeKey(doc: NetworkDocument, ref?: ConnectionJunctionRef): string | undefined {
    if (!ref) return undefined
    const site = siteOfRef(doc, ref)
    if (site) return `G:${site}`
    return ref.kind === ConnectionJunctionKind.TRANSMISSION_JUNCTION ? `J:${ref.id}` : `${ref.kind}:${ref.id}`
}

/** Key of a path's unordered pair of places; undefined while an end is missing. */
function pairKey(doc: NetworkDocument, p: TransmissionPathRecord): string | undefined {
    const a = placeKey(doc, p.from), b = placeKey(doc, p.to)
    return a && b ? [a, b].sort().join('|') : undefined
}

const circuitCount = (doc: NetworkDocument, pathId: string) => doc.circuits.filter(c => c.pathId === pathId).length

/** The path a merge keeps by default: the most circuits, then the most waypoints, then the first in the document. */
export function preferredPath(doc: NetworkDocument, paths: TransmissionPathRecord[]): TransmissionPathRecord {
    return [...paths].sort((a, b) => circuitCount(doc, b.id) - circuitCount(doc, a.id) || b.waypoints.length - a.waypoints.length || doc.paths.indexOf(a) - doc.paths.indexOf(b))[0]
}

/** Groups of two or more paths between the same two places, each with its preferred path first. */
export function duplicatePathGroups(doc: NetworkDocument): TransmissionPathRecord[][] {
    const groups = new Map<string, TransmissionPathRecord[]>()
    for (const p of doc.paths) {
        if (p.waypoints.length) continue
        const key = pairKey(doc, p)
        if (key) groups.set(key, [...(groups.get(key) ?? []), p])
    }
    return [...groups.values()].filter(g => g.length > 1).map(g => {
        const keep = preferredPath(doc, g)
        return [keep, ...g.filter(p => p !== keep)]
    })
}

/** The other paths between the same two places as `pathId`, when neither has waypoints (see the module comment). */
export function duplicatesOf(doc: NetworkDocument, pathId: string): TransmissionPathRecord[] {
    const p = doc.paths.find(x => x.id === pathId)
    const key = p && !p.waypoints.length && pairKey(doc, p)
    return key ? doc.paths.filter(x => x.id !== pathId && !x.waypoints.length && pairKey(doc, x) === key) : []
}

/** Whether `other` runs the other way than `keep` (its FROM end is keep's TO place). */
export function runsReversed(doc: NetworkDocument, keep: TransmissionPathRecord, other: TransmissionPathRecord): boolean {
    const keepFrom = placeKey(doc, keep.from)
    return placeKey(doc, other.from) !== keepFrom && placeKey(doc, other.to) === keepFrom
}

export interface MergePathsPlan {
    ops: NetworkOp[]
    keep?: TransmissionPathRecord
    merged: { path: TransmissionPathRecord; reversed: boolean; circuits: string[] }[]
    /** The merged path whose route a straight kept path took over. */
    routeFrom?: TransmissionPathRecord
    /** Names / ids of the kept path and the moved circuits by the model rules (optional follow-up). */
    regenerate: { ops: NetworkOp[]; changes: RegenerateChange[] }
    warnings: string[]
    errors: string[]
}

/** Ops that merge the `others` into `keepId` (see the module comment). */
export function buildMergePathsPlan(doc: NetworkDocument, keepId: string, others: string[]): MergePathsPlan {
    const plan: MergePathsPlan = {ops: [], merged: [], regenerate: {ops: [], changes: []}, warnings: [], errors: []}
    const keep = doc.paths.find(p => p.id === keepId)
    if (!keep) return {...plan, errors: ['the path no longer exists']}
    const key = pairKey(doc, keep)
    if (!key) return {...plan, errors: [`path ${keep.name} needs both ends first`]}
    let probe = doc
    const push = (...next: NetworkOp[]) => {
        plan.ops.push(...next)
        probe = applyOps(probe, next)
    }
    let kept = keep
    for (const id of others) {
        const other = doc.paths.find(p => p.id === id)
        if (!other || other.id === keep.id) continue
        if (pairKey(doc, other) !== key) {
            plan.errors.push(`path ${other.name} does not run between the same places as ${keep.name}`)
            continue
        }
        const reversed = runsReversed(doc, keep, other)
        const circuits = probe.circuits.filter(c => c.pathId === other.id)
        for (const c of circuits) push({type: 'upsert', collection: 'circuits', record: {...c, pathId: keep.id}})
        if (reversed) for (const c of circuits) {
            // the circuit follows the kept path's direction: its FROM and TO ends swap
            for (const conn of probe.connections) {
                if (!conn.nodes.some(n => n.kind === NetworkNodeKind.TRANSMISSION_CIRCUIT && n.id === c.id)) continue
                push({type: 'upsert', collection: 'connections', record: {...conn, nodes: conn.nodes.map(n => n.kind === NetworkNodeKind.TRANSMISSION_CIRCUIT && n.id === c.id
                        ? {...n, terminal: n.terminal === CIRCUIT_END_FROM ? CIRCUIT_END_TO : CIRCUIT_END_FROM} : n)}})
            }
        }
        if (kept.waypoints.length === 0 && other.waypoints.length > 0) {
            kept = {...kept, waypoints: reversed ? [...other.waypoints].reverse() : [...other.waypoints]}
            push({type: 'upsert', collection: 'paths', record: kept})
            plan.routeFrom = other
        } else if (other.waypoints.length > 0 && JSON.stringify(other.waypoints) !== JSON.stringify(kept.waypoints) && JSON.stringify([...other.waypoints].reverse()) !== JSON.stringify(kept.waypoints)) {
            plan.warnings.push(`path ${other.name} had its own route (${other.waypoints.length} waypoint(s)); the route of ${keep.name} is kept`)
        }
        if (reversed && circuits.length) plan.warnings.push(`path ${other.name} ran the other way: ${circuits.map(c => c.name).join(', ')} follow ${keep.name}'s direction (FROM and TO swap)`)
        push({type: 'delete', collection: 'paths', id: other.id})
        plan.merged.push({path: other, reversed, circuits: circuits.map(c => c.id)})
    }
    plan.keep = kept
    const targets = [{collection: 'paths' as const, id: keep.id}, ...plan.merged.flatMap(m => m.circuits.map(id => ({collection: 'circuits' as const, id})))]
    const regenerate = regenerateNamingOps(probe, targets, {id: true, name: true})
    plan.regenerate = {ops: regenerate.ops, changes: regenerate.changes}
    return plan
}

/** One plan merging every duplicate group into its preferred path. */
export function buildMergeAllDuplicatesPlan(doc: NetworkDocument): MergePathsPlan & { groups: number } {
    const all: MergePathsPlan & { groups: number } = {ops: [], merged: [], regenerate: {ops: [], changes: []}, warnings: [], errors: [], groups: 0}
    let probe = doc
    for (const group of duplicatePathGroups(doc)) {
        const plan = buildMergePathsPlan(probe, group[0].id, group.slice(1).map(p => p.id))
        all.errors.push(...plan.errors)
        if (plan.errors.length) continue
        all.ops.push(...plan.ops)
        all.merged.push(...plan.merged)
        all.warnings.push(...plan.warnings)
        all.groups++
        probe = applyOps(probe, plan.ops)
    }
    const targets = all.merged.flatMap(m => m.circuits.map(id => ({collection: 'circuits' as const, id})))
    const keptIds = duplicatePathGroups(doc).map(g => g[0].id)
    const regenerate = regenerateNamingOps(probe, [...keptIds.map(id => ({collection: 'paths' as const, id})), ...targets], {id: true, name: true})
    all.regenerate = {ops: regenerate.ops, changes: regenerate.changes}
    return all
}
