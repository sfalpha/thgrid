/**
 * Sectionalizing lines at a junction into a site or another junction ("loop in, loop out"), or, at a site's own
 * junction, into the site's yard right there.
 *
 * A line passing through a junction (a node holding just its two circuit ends, `passThroughs`) is cut there and each
 * side is taken to the chosen place by a new circuit, both on one path between the junction and the place. At the
 * junction the two sides are kept apart: the first stays in its node with its new circuit, the second goes into a new
 * node with the other. At the place either
 * - (a site) both new circuits enter the yard at the voltage the line is energized at (a de-energized line: the yard
 *   at its rated voltage, where it stays de-energized), through a take-off each, and the line is split there in two
 *   (a line runs yard to yard); a site without such a yard takes them at its site junction instead (created when
 *   missing), spliced, with a warning; or
 * - (the site junction asked for, or a line junction) both are spliced in one new node there, and the line keeps
 *   running, two sections longer.
 * The new circuits copy the make-up of the side they continue. The path is an existing one between the junction and the
 * place when asked (`sectionalizePathChoices`; one running the other way: the new circuits follow its direction) or a
 * new straight one. A line that ends at the junction (spliced there to another line) gets its new circuit on that end,
 * and its end moves to the place.
 *
 * At a site junction, into its own site: the line's two circuit ends leave the junction and enter the site's yard at
 * the line's voltage through a take-off each, no new circuit or path; the line is split there. A site junction left
 * with nothing at it goes. A site without a yard at that voltage cannot take the line in (it stays spliced).
 *
 * Into a yard, a free take-off of the yard already named toward a side's far station (at the yard's voltage) is used
 * before a new one is made. Pure: returns ops plus a summary for the confirmation.
 */
import {TransmissionVoltage} from '@shared/models/transmission.voltage'
import {
    CIRCUIT_END_FROM,
    CIRCUIT_END_TO,
    CircuitEnd,
    ConnectionJunctionKind,
    ConnectionJunctionRef,
    ConnectionRecord,
    NetworkDocument,
    NetworkNodeRef,
    SubstationGroupRecord,
    SubstationRecord,
    SubstationTakeOffRecord,
    TransmissionCircuitRecord,
    TransmissionJunctionRecord,
    TransmissionLineRecord,
    TransmissionPathRecord,
} from '@shared/network/records'
import {applyOps, NetworkOp, uniqueId} from '@shared/network/ops'
import {circuitNaming, lineNameVoltage, lineNaming, pathNaming, regenerateNamingOps, RegenerateChange} from '@shared/network/naming'
import {junctionRef, pathEndOf, siteRef} from '@shared/network/refs'
import {recordById} from '@shared/network/lookup'
import {newSiteJunctionRecord, siteJunctionOf} from '@shared/network/siteJunction'
import {genericConductor} from '@shared/models/transmission.conductor'
import {joinName} from '@shared/models/naming'
import {attachCircuitEndToJunctionOps, attachCircuitEndToTakeOffOps, circuitEndConnection, detachCircuitEndOps, refLabel, takeOffVoltage} from './linkOps'
import {PassThrough, passThroughs} from './bypassJunction'
import {deEnergizedEntryWarning, newTakeOffToward, nodeVoltage, pathsBetween, runVoltage, samePlace, yardChoices} from './routeVia'
import {freeTakeOffsTowardCode} from './lineWizard'
import {polylineKm} from './splitPath'

/**
 * Where the lines are taken: a site (into the yard at each line's voltage, else its site junction; `siteJunction`: its
 * site junction in any case; the junction's own site: into its yard right there), or a line junction.
 */
export type SectionTarget =
    | { kind: 'site'; groupId: string; siteJunction?: boolean }
    | { kind: 'junction'; junctionId: string }

export interface SectionalizedLine {
    key: string
    /** The line(s) through it, or its two circuits, as the summaries name it. */
    label: string
    circuits: [TransmissionCircuitRecord, TransmissionCircuitRecord]
    /** The new circuit of each side, in the same order (none into the junction's own site). */
    added: TransmissionCircuitRecord[]
    /** Entered through take-offs; otherwise spliced at `junction`. */
    yard?: SubstationRecord
    junction?: TransmissionJunctionRecord
    /** A site without a yard at the line's voltage: spliced at its site junction instead. */
    fellBack: boolean
    /** The take-offs entered through, one per side; `reusedTakeOffs` the ones that were there already (free). */
    takeOffs: SubstationTakeOffRecord[]
    reusedTakeOffs: SubstationTakeOffRecord[]
    /** Lines that keep running (two sections longer) or whose end at the junction moved to the place. */
    lines: TransmissionLineRecord[]
    /** Lines split at the yard: the first part keeps the line, the second is a new line. */
    splitLines: { line: TransmissionLineRecord; added: TransmissionLineRecord }[]
}

export interface SectionalizePlan {
    ops: NetworkOp[]
    /** The place, as the summaries name it. */
    targetLabel: string
    /** Into the site the junction belongs to: its yard right there, no new circuit or path. */
    intoOwnSite: boolean
    /** The site junction created on the way. */
    createdJunction?: TransmissionJunctionRecord
    /** The junction, removed: nothing is left at it. */
    removedJunction?: TransmissionJunctionRecord
    path?: TransmissionPathRecord
    pathCreated: boolean
    lines: SectionalizedLine[]
    warnings: string[]
    errors: string[]
    /** Optional follow-up: names / ids of the new circuits, the path and the changed lines by the model rules. */
    regenerate: { ops: NetworkOp[]; changes: RegenerateChange[] }
}

/** The junction as a path end: itself, or its site for a site junction. */
const junctionPlace = (doc: NetworkDocument, junctionId: string) => pathEndOf(doc, junctionRef(junctionId)) ?? junctionRef(junctionId)

/** The target is the site the junction belongs to. */
export const isOwnSite = (doc: NetworkDocument, junctionId: string, target: SectionTarget) =>
    target.kind === 'site' && !!recordById(doc.junctions, junctionId)?.groupId && recordById(doc.junctions, junctionId)?.groupId === target.groupId

/** The target as a path end. */
export function sectionTargetRef(doc: NetworkDocument, target: SectionTarget): ConnectionJunctionRef | undefined {
    if (target.kind === 'site') return recordById(doc.substationGroups, target.groupId) ? siteRef(target.groupId) : undefined
    return recordById(doc.junctions, target.junctionId) ? junctionPlace(doc, target.junctionId) : undefined
}

/** Existing paths between the junction and the target, best first (either direction); none into the junction's own site. */
export function sectionalizePathChoices(doc: NetworkDocument, junctionId: string, target: SectionTarget): TransmissionPathRecord[] {
    const there = sectionTargetRef(doc, target)
    return there && !isOwnSite(doc, junctionId, target) ? pathsBetween(doc, junctionPlace(doc, junctionId), there) : []
}

/** Why a pass-through cannot be sectionalized: its node holds more than its two circuit ends (a tee). */
export function sectionalizeReason(item: PassThrough): string | undefined {
    return item.connection.nodes.length !== 2 ? 'its node holds more than these two circuit ends (a tee)' : undefined
}

/**
 * The yard of the site a line enters: the one at the voltage it is energized at (a de-energized line: at its rated
 * voltage, where it stays de-energized); undefined when the site has none.
 */
export function sectionYard(doc: NetworkDocument, groupId: string, circuits: TransmissionCircuitRecord[]): SubstationRecord | undefined {
    const allowed = yardChoices(doc, groupId, circuits).filter(y => !y.reason).map(y => y.yard)
    const live = circuits.find(c => c.energizedVoltage !== TransmissionVoltage.DE_ENERGIZED)
    const wanted = live ? runVoltage(live) : circuits[0]?.voltage
    return allowed.find(y => y.voltage === wanted)
}

/** Where the circuit's path ends away from the junction (its end at the junction is `end`). */
function farEnd(doc: NetworkDocument, circuit: TransmissionCircuitRecord, end: string | undefined): ConnectionJunctionRef | undefined {
    const path = recordById(doc.paths, circuit.pathId)
    return end === CIRCUIT_END_FROM ? path?.to : path?.from
}

/** One side of a pass-through: its circuit and that circuit's end at the junction. */
interface Side {
    circuit: TransmissionCircuitRecord
    end: NetworkNodeRef
}

/**
 * Where side `k`'s line goes, away from the junction: the far station its take-off is named after, the end of its line
 * on that side (past any site junction it is only spliced at on the way); without a line, the circuit's path end.
 */
function towardFar(doc: NetworkDocument, junctionId: string, sides: Side[], lines: TransmissionLineRecord[], k: number): ConnectionJunctionRef | undefined {
    const far = farEnd(doc, sides[k].circuit, sides[k].end.terminal)
    const line = lines.find(l => l.circuitIds.includes(sides[k].circuit.id))
    if (!line) return far
    const ids = line.circuitIds, i = ids.indexOf(sides[k].circuit.id), j = ids.indexOf(sides[1 - k].circuit.id)
    // the side's line runs on away from the junction toward the end its circuit is on
    const atStart = j >= 0 ? i < j : i === ids.length - 1 && ids.length > 1 ? true : i === 0 && ids.length > 1 ? false : line.to?.id === junctionId
    return (atStart ? line.from : line.to) ?? far
}

/** The code a take-off toward `ref` is named after: the site's, or the line junction's name. */
function towardCode(doc: NetworkDocument, ref: ConnectionJunctionRef | undefined): string | undefined {
    const end = pathEndOf(doc, ref)
    if (end?.kind === ConnectionJunctionKind.SUBSTATION_GROUP) return recordById(doc.substationGroups, end.id)?.groupName
    const j = ref ? recordById(doc.junctions, ref.id) : undefined
    return j ? j.name ?? j.id : undefined
}

/**
 * The lines through the two sides, once each side has gone to the place: through both, split at the yard
 * (`placeEnd` a yard) or carried on with the sides' new circuits between them (`added`, spliced at a junction); ending at
 * the junction on one side, that end moves to the place (with the side's new circuit). Pushes the ops; returns what
 * changed.
 */
function moveLines(probe: () => NetworkDocument, push: (...ops: NetworkOp[]) => void, junctionId: string, sides: Side[], before: TransmissionLineRecord[],
                   placeEnd: ConnectionJunctionRef, intoYard: boolean, added: string[], warn: (w: string) => void) {
    const lines: TransmissionLineRecord[] = [], splitLines: SectionalizedLine['splitLines'] = []
    for (const line of before) {
        const ids = line.circuitIds
        const i0 = ids.indexOf(sides[0].circuit.id), i1 = ids.indexOf(sides[1].circuit.id)
        if (i0 >= 0 && i1 >= 0 && Math.abs(i0 - i1) === 1) {
            const lo = Math.min(i0, i1), hi = lo + 1
            const newLo = added.length ? [lo === i0 ? added[0] : added[1]] : [], newHi = added.length ? [lo === i0 ? added[1] : added[0]] : []
            if (!intoYard) {
                const updated = {...line, circuitIds: [...ids.slice(0, lo + 1), ...newLo, ...newHi, ...ids.slice(hi)]}
                push({type: 'upsert', collection: 'lines', record: updated})
                lines.push(updated)
                continue
            }
            const kept: TransmissionLineRecord = {...line, to: placeEnd, circuitIds: [...ids.slice(0, lo + 1), ...newLo]}
            push({type: 'upsert', collection: 'lines', record: kept})
            const second = [...newHi, ...ids.slice(hi)]
            const ln = lineNaming(probe(), undefined, placeEnd, line.to, lineNameVoltage(probe(), second, line.voltage))
            const addedLine: TransmissionLineRecord = {id: uniqueId(probe(), ln.id), name: ln.name, voltage: line.voltage, planned: line.planned, from: placeEnd, to: line.to, circuitIds: second}
            push({type: 'upsert', collection: 'lines', record: addedLine})
            splitLines.push({line: kept, added: addedLine})
            continue
        }
        const k = i0 >= 0 && i1 < 0 ? 0 : i1 >= 0 && i0 < 0 ? 1 : -1
        const i = k === 0 ? i0 : i1
        // the side of the line at the junction: its last section (the line ends there), else its first
        const atEnd = k < 0 ? undefined : ids.length > 1 ? (i === ids.length - 1 ? 'to' : i === 0 ? 'from' : undefined) : line.from?.id === junctionId ? 'from' : 'to'
        if (!atEnd) {
            warn(`line ${line.name} does not run through the junction as its sections say: left as it is`)
            continue
        }
        const own = added.length ? [added[k]] : []
        const updated = atEnd === 'to' ? {...line, to: placeEnd, circuitIds: [...ids, ...own]} : {...line, from: placeEnd, circuitIds: [...own, ...ids]}
        push({type: 'upsert', collection: 'lines', record: updated})
        lines.push(updated)
    }
    return {lines, splitLines}
}

export function buildSectionalizePlan(doc: NetworkDocument, junctionId: string, keys: string[], target: SectionTarget, opts: { pathId?: string } = {}): SectionalizePlan {
    const plan: SectionalizePlan = {ops: [], targetLabel: '', intoOwnSite: false, pathCreated: false, lines: [], warnings: [], errors: [], regenerate: {ops: [], changes: []}}
    const fail = (e: string) => ({...plan, errors: [e]})
    const here = recordById(doc.junctions, junctionId)
    if (!here) return fail('the junction no longer exists')
    const items = passThroughs(doc, junctionId).filter(i => keys.includes(i.key))
    if (!items.length) return fail('check at least one line through this junction')

    // 1. the place: a site, or a line junction
    const site: SubstationGroupRecord | undefined = target.kind === 'site' ? recordById(doc.substationGroups, target.groupId) : undefined
    const other = target.kind === 'junction' ? recordById(doc.junctions, target.junctionId) : undefined
    if (target.kind === 'site' && !site) return fail('the site no longer exists')
    if (target.kind === 'junction' && !other) return fail('the junction no longer exists')
    if (other?.id === here.id) return fail('that is this junction')
    const hereRef = junctionPlace(doc, here.id)
    const thereRef = sectionTargetRef(doc, target)!
    const thereName = site ? site.groupName : other!.name ?? other!.id
    const hereName = here.name ?? here.id
    plan.intoOwnSite = isOwnSite(doc, here.id, target)
    plan.targetLabel = plan.intoOwnSite ? `the yard of site ${site!.groupName} (this junction's site)` : site ? `site ${site.groupName}` : `junction ${thereName}`
    if (plan.intoOwnSite && target.kind === 'site' && target.siteJunction) return fail(`the lines are spliced at the site junction of ${thereName} already`)
    if (!plan.intoOwnSite && samePlace(doc, hereRef, thereRef)) return fail(`this junction is at ${thereName}`)

    // 2. what can go: a pass-through of its own node, not already running to the place
    const labelOf = (i: PassThrough) => i.lines.length ? i.lines.map(l => l.name).join(', ') : `${i.circuits[0].name} + ${i.circuits[1].name}`
    const errors = items.flatMap(i => {
        const reason = sectionalizeReason(i)
        if (reason) return [`${labelOf(i)}: ${reason}`]
        return !plan.intoOwnSite && i.farEnds.some(f => samePlace(doc, f, thereRef)) ? [`${labelOf(i)}: it already runs to ${thereName}`] : []
    })
    if (errors.length) return {...plan, errors}

    const ops: NetworkOp[] = []
    let probe = doc
    const push = (...next: NetworkOp[]) => {
        ops.push(...next)
        probe = applyOps(probe, next)
    }
    const warn = (w: string) => plan.warnings.push(w)

    /** A take-off of the yard toward `toward`: a free one already named so (at the yard's voltage), else a new one. */
    const takeOffInto = (yard: SubstationRecord, toward: ConnectionJunctionRef | undefined) => {
        const free = freeTakeOffsTowardCode(probe, yard.id, towardCode(probe, toward)).find(t => takeOffVoltage(probe, t.id) === yard.voltage)
        if (free) return {takeOff: free, reused: true}
        const t = newTakeOffToward(probe, yard.id, toward)
        push({type: 'upsert', collection: 'takeOffs', record: t})
        return {takeOff: t, reused: false}
    }

    // 3. into the junction's own site: the circuit ends leave the junction for the yard right there
    if (plan.intoOwnSite) {
        for (const item of items) {
            const label = labelOf(item)
            const sides: Side[] = [0, 1].map(k => ({circuit: recordById(probe.circuits, item.circuits[k].id)!, end: item.ends[k]}))
            const yard = sectionYard(probe, site!.id, sides.map(s => s.circuit))
            if (!yard) {
                const v = [...new Set(sides.map(s => runVoltage(s.circuit) ?? 'no voltage'))].join(' / ')
                plan.errors.push(`${label} runs at ${v}: ${site!.groupName} has no yard at it, so it stays spliced at the site junction`)
                continue
            }
            const before = probe.lines.filter(l => l.circuitIds.includes(sides[0].circuit.id) || l.circuitIds.includes(sides[1].circuit.id))
            const toward = [0, 1].map(k => towardFar(probe, here.id, sides, before, k))
            for (const s of sides) push(...detachCircuitEndOps(probe, s.circuit.id, s.end.terminal as CircuitEnd))
            const takeOffs: SubstationTakeOffRecord[] = [], reusedTakeOffs: SubstationTakeOffRecord[] = []
            for (const k of [0, 1]) {
                const {takeOff, reused} = takeOffInto(yard, toward[k])
                takeOffs.push(takeOff)
                if (reused) reusedTakeOffs.push(takeOff)
                push(...attachCircuitEndToTakeOffOps(probe, sides[k].circuit.id, sides[k].end.terminal as CircuitEnd, takeOff.id))
            }
            const w = deEnergizedEntryWarning(sides.map(s => s.circuit), `yard ${site!.groupName} ${yard.yardName}`, yard.voltage)
            if (w) warn(w)
            const moved = moveLines(() => probe, push, here.id, sides, before, {kind: ConnectionJunctionKind.SUBSTATION, id: yard.id}, true, [], warn)
            plan.lines.push({key: item.key, label, circuits: [sides[0].circuit, sides[1].circuit], added: [], yard, fellBack: false, takeOffs, reusedTakeOffs, ...moved})
        }
        if (plan.errors.length) return {...plan, lines: []}
        // the site junction goes when nothing is left at it (no node, no path or line naming it)
        const used = probe.connections.some(c => c.junction.id === here.id) || probe.paths.some(p => p.from?.id === here.id || p.to?.id === here.id)
            || probe.lines.some(l => l.from?.id === here.id || l.to?.id === here.id)
        if (!used) {
            push({type: 'delete', collection: 'junctions', id: here.id})
            plan.removedJunction = here
        }
        plan.ops = ops
        for (const x of plan.lines) for (const s of x.circuits) {
            if (!circuitEndConnection(probe, s.id, CIRCUIT_END_FROM) || !circuitEndConnection(probe, s.id, CIRCUIT_END_TO)) plan.errors.push(`${s.name}: an end would be left unconnected`)
        }
        const targets = plan.lines.flatMap(x => [...x.lines.map(l => ({collection: 'lines' as const, id: l.id})), ...x.splitLines.flatMap(s => [{collection: 'lines' as const, id: s.line.id}, {collection: 'lines' as const, id: s.added.id}])])
        const regenerate = regenerateNamingOps(probe, targets, {id: true, name: true})
        plan.regenerate = {ops: regenerate.ops, changes: regenerate.changes}
        return plan
    }

    // 4. the path between the junction and the place: the one asked for, else a new straight one
    let path: TransmissionPathRecord
    if (opts.pathId) {
        const reuse = sectionalizePathChoices(doc, here.id, target).find(p => p.id === opts.pathId)
        if (!reuse) return fail(`path ${opts.pathId} does not run between ${hereName} and ${thereName}`)
        path = reuse
    } else {
        const pn = pathNaming(probe, hereRef, thereRef)
        path = {id: uniqueId(probe, pn.id), name: pn.name, from: hereRef, to: thereRef, waypoints: []}
        push({type: 'upsert', collection: 'paths', record: path})
        plan.pathCreated = true
    }
    plan.path = path
    // the new circuits follow the path: FROM at the junction when it runs from there
    const outward = samePlace(doc, path.from, hereRef)
    const endHere: CircuitEnd = outward ? CIRCUIT_END_FROM : CIRCUIT_END_TO
    const endThere: CircuitEnd = outward ? CIRCUIT_END_TO : CIRCUIT_END_FROM
    const thereCoords = site?.coords ?? other!.coords
    const km = Number(polylineKm(outward ? [here.coords, ...path.waypoints, thereCoords] : [thereCoords, ...path.waypoints, here.coords]).toFixed(2))
    if (!outward) warn(`path ${path.name} runs ${refLabel(doc, path.from)} → ${refLabel(doc, path.to)}: the new circuits follow its direction (FROM at ${thereName})`)

    /** The site junction, created once when a line is spliced there. */
    const siteJunction = () => {
        let j = siteJunctionOf(probe, site!.id)
        if (!j) {
            j = newSiteJunctionRecord(probe, site!)
            push({type: 'upsert', collection: 'junctions', record: j})
            plan.createdJunction = j
        }
        return j
    }

    // 5. every checked line
    for (const item of items) {
        const label = labelOf(item)
        const sides: Side[] = [0, 1].map(k => ({circuit: recordById(probe.circuits, item.circuits[k].id)!, end: item.ends[k]}))
        const node = probe.connections.find(c => c.id === item.connection.id)
        if (!node) {
            plan.errors.push(`${label}: its node is gone`)
            continue
        }
        // where it enters: the yard at its voltage, else (or when asked) the site junction; a line junction as it is
        let yard: SubstationRecord | undefined
        let junction: TransmissionJunctionRecord | undefined
        let fellBack = false
        if (site && !(target.kind === 'site' && target.siteJunction)) {
            yard = sectionYard(probe, site.id, sides.map(s => s.circuit))
            if (!yard) {
                fellBack = true
                junction = siteJunction()
                const v = [...new Set(sides.map(s => runVoltage(s.circuit) ?? 'no voltage'))].join(' / ')
                warn(`${label} runs at ${v}: ${site.groupName} has no yard at it, so it is spliced at the site junction ${junction.name ?? junction.id} and not connected to any take-off`)
            }
        } else junction = site ? siteJunction() : other

        // the new circuit of each side: its make-up, on the path, named after its line (two of one line on one path: _2)
        const added = sides.map(({circuit: c}) => {
            const lineName = probe.lines.filter(l => l.circuitIds.includes(c.id)).map(l => l.name).sort()[0]
            const base = circuitNaming(probe, {pathId: path.id, lineName, voltage: c.voltage ?? c.energizedVoltage})
            let naming = base
            for (let k = 2; probe.circuits.some(x => x.name === naming.name); k++) naming = circuitNaming(probe, {name: joinName([base.name, String(k)])})
            const record: TransmissionCircuitRecord = {
                id: uniqueId(probe, naming.id), name: naming.name, pathId: path.id,
                voltage: c.voltage, energizedVoltage: c.energizedVoltage, bundle: c.bundle, conductor: c.conductor ? {...c.conductor} : genericConductor(),
                conductorTemplateId: c.conductorTemplateId, planned: c.planned, lengthKm: km,
            }
            push({type: 'upsert', collection: 'circuits', record})
            return record
        })

        // at the junction: the first side stays in its node with its new circuit, the second goes into a new node with its own
        push(...detachCircuitEndOps(probe, sides[1].circuit.id, sides[1].end.terminal as CircuitEnd))
        push(...attachCircuitEndToJunctionOps(probe, added[0].id, endHere, here.id, nodeVoltage(sides[0].circuit), {connectionId: node.id}))
        const apart = attachCircuitEndToJunctionOps(probe, sides[1].circuit.id, sides[1].end.terminal as CircuitEnd, here.id, node.voltage ?? nodeVoltage(sides[1].circuit), {forceNew: true})
        push(...apart)
        const apartNode = apart[0]?.type === 'upsert' ? apart[0].record as ConnectionRecord : undefined
        if (apartNode) push(...attachCircuitEndToJunctionOps(probe, added[1].id, endHere, here.id, apartNode.voltage, {connectionId: apartNode.id}))

        // the lines through it, as they ran before
        const before = probe.lines.filter(l => l.circuitIds.includes(sides[0].circuit.id) || l.circuitIds.includes(sides[1].circuit.id))

        // at the place: into the yard through a take-off each, or spliced in one new node
        const takeOffs: SubstationTakeOffRecord[] = [], reusedTakeOffs: SubstationTakeOffRecord[] = []
        if (yard) {
            for (const k of [0, 1]) {
                const {takeOff, reused} = takeOffInto(yard, towardFar(probe, here.id, sides, before, k))
                takeOffs.push(takeOff)
                if (reused) reusedTakeOffs.push(takeOff)
                push(...attachCircuitEndToTakeOffOps(probe, added[k].id, endThere, takeOff.id))
            }
            const w = deEnergizedEntryWarning(sides.map(s => s.circuit), `yard ${site!.groupName} ${yard.yardName}`, yard.voltage)
            if (w) warn(w)
        } else {
            const at = attachCircuitEndToJunctionOps(probe, added[0].id, endThere, junction!.id, nodeVoltage(sides[0].circuit), {forceNew: true})
            push(...at)
            const spliced = at[0]?.type === 'upsert' ? at[0].record as ConnectionRecord : undefined
            if (spliced) push(...attachCircuitEndToJunctionOps(probe, added[1].id, endThere, junction!.id, spliced.voltage, {connectionId: spliced.id}))
        }

        const placeEnd: ConnectionJunctionRef = yard ? {kind: ConnectionJunctionKind.SUBSTATION, id: yard.id} : {kind: ConnectionJunctionKind.TRANSMISSION_JUNCTION, id: junction!.id}
        const moved = moveLines(() => probe, push, here.id, sides, before, placeEnd, !!yard, added.map(c => c.id), warn)
        plan.lines.push({
            key: item.key, label, circuits: [sides[0].circuit, sides[1].circuit],
            added: added.map(c => recordById(probe.circuits, c.id)!), yard, junction, fellBack, takeOffs, reusedTakeOffs, ...moved,
        })
    }
    plan.ops = ops

    // every new circuit must be connected at both ends: never hand out a plan that leaves one loose
    for (const x of plan.lines) for (const c of x.added) {
        if (!circuitEndConnection(probe, c.id, endHere)) plan.errors.push(`${c.name}: its end at ${hereName} would be left unconnected`)
        if (!circuitEndConnection(probe, c.id, endThere)) plan.errors.push(`${c.name}: its end at ${thereName} would be left unconnected`)
    }

    // 6. optional: names / ids by the rules (the new circuits, a new path, the lines changed)
    const targets = [
        ...(plan.pathCreated ? [{collection: 'paths' as const, id: path.id}] : []),
        ...plan.lines.flatMap(x => x.added.map(c => ({collection: 'circuits' as const, id: c.id}))),
        ...plan.lines.flatMap(x => [...x.lines.map(l => ({collection: 'lines' as const, id: l.id})), ...x.splitLines.flatMap(s => [{collection: 'lines' as const, id: s.line.id}, {collection: 'lines' as const, id: s.added.id}])]),
    ]
    const regenerate = regenerateNamingOps(probe, targets, {id: true, name: true})
    plan.regenerate = {ops: regenerate.ops, changes: regenerate.changes}
    return plan
}
