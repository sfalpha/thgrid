/**
 * "New circuit" wizard: one circuit between two places, each a site or a line junction.
 *
 * At a site the circuit leaves through a take-off: one no circuit uses yet, of any yard, or a new one in a yard (named
 * toward the other end by the model rules); or it ends at the site's junction (created when the site has none). At a
 * junction it joins an existing node, or starts a node of its own: an open end, connected to nothing else yet. The
 * circuit runs on a path that already goes between the two places (the best one by default, following its direction when
 * it runs the other way) or on a new one. Created by hand, anything goes: nothing is refused for its voltages, the plan
 * warns on every mismatch instead (ends at different voltages, an end at another voltage than the circuit is energized
 * at, energized above or below its rating or at another current type, an open end, both ends open yet energized);
 * joining circuits that run at the same voltage at a node, and a de-energized circuit, are notes. The circuit is energized at the voltage chosen, else at its connections' (the FROM end first; a node joined
 * runs at the voltage of the circuits there), de-energized (0 V) when both ends are open; a new node is created at
 * that voltage.
 * Everything (site junctions, take-offs, path, circuit, connections) is one journaled batch.
 * Pure: works on a document and returns ops plus a summary for the panel.
 */
import {energizedVsRated, TransmissionVoltage, withinRating} from '@shared/models/transmission.voltage'
import {nodeRunningVoltage, runningVoltagesAt} from '@shared/network/lines'
import {genericConductor, type TransmissionConductor} from '@shared/models/transmission.conductor'
import {
    CIRCUIT_END_FROM,
    CIRCUIT_END_TO,
    CircuitEnd,
    ConnectionJunctionRef,
    ConnectionRecord,
    NetworkDocument,
    SubstationGroupRecord,
    SubstationRecord,
    SubstationTakeOffRecord,
    TransmissionCircuitRecord,
    TransmissionJunctionRecord,
    TransmissionPathRecord,
} from '@shared/network/records'
import {applyOps, checkCreateId, NetworkOp, pickId, uniqueId} from '@shared/network/ops'
import {circuitNaming, Naming, pathNaming, takeOffNaming} from '@shared/network/naming'
import {junctionRef, siteRef} from '@shared/network/refs'
import {newSiteJunctionRecord, siteJunctionOf} from '@shared/network/siteJunction'
import {attachCircuitEndToJunctionOps, attachCircuitEndToTakeOffOps, connectionsAtJunction, freeTakeOffs, takeOffVoltage as takeOffCircuitVoltage} from './linkOps'
import {haversineKm, locationOfRef, voltageKv} from './mapUtil'
import {freeTakeOffsToward} from './lineWizard'
import {newTakeOffToward, pathsBetween, samePlace} from './routeVia'

/** How a circuit end connects at its place. */
export type NewCircuitConnect =
    /** A take-off of the site that no circuit uses yet. */
    | { kind: 'takeOff'; takeOffId: string }
    /** A new take-off in a yard of the site; its line name is the rule one toward the other end when empty. */
    | { kind: 'newTakeOff'; yardId: string; lineName?: string }
    /** At the junction (the place itself, or the site's junction): join this node, or a node of its own when empty. */
    | { kind: 'junction'; connectionId?: string }

export interface NewCircuitEndSpec {
    /** `G:<site id>` or `J:<junction id>`; '' = not chosen yet. */
    place: string
    /** How the end connects; `defaultCircuitConnect` when missing. */
    connect?: NewCircuitConnect
    /** Name / id of the new connection there (a node of its own, or the one a take-off starts); generated when empty. */
    connectionName?: string
    connectionId?: string
}

export interface NewCircuitSpec {
    from: NewCircuitEndSpec
    to: NewCircuitEndSpec
    /** Name / id of the circuit; the rule ones when empty. */
    name?: string
    id?: string
    voltage?: TransmissionVoltage
    bundle?: number
    conductor?: TransmissionConductor
    lengthKm?: number
    /** Run on this path (one between the two places, either way); the best one there (`pathChoices[0]`) when empty. */
    pathId?: string
    /** Run on a new path even when one already goes between the two places (also when none does). */
    newPath?: boolean
    newPathName?: string
    newPathId?: string
    /** Voltage the circuit is energized at; its connections' (the FROM end first) when empty. */
    energizedVoltage?: TransmissionVoltage
}

export interface NewCircuitEndPlan {
    /** The place as a path end (a site, or a junction), when chosen. */
    ref?: ConnectionJunctionRef
    site?: SubstationGroupRecord
    /** How the end connects, resolved (the default filled in). */
    connect?: NewCircuitConnect
    /** The take-off used, and the yard it belongs to. */
    takeOff?: SubstationTakeOffRecord
    takeOffCreated: boolean
    yard?: SubstationRecord
    /** The junction the end connects at (a site junction the plan creates included). */
    junction?: TransmissionJunctionRecord
    junctionCreated: boolean
    /** The existing node it joins. */
    node?: ConnectionRecord
    /** Voltage of what the end connects to (take-off or yard, or what the circuits at the node joined run at); unknown for a node of its own. */
    voltage?: TransmissionVoltage
    /** Ends in a node of its own at a junction: connected to nothing else. */
    open: boolean
    label: string
}

export interface NewCircuitPlan {
    ops: NetworkOp[]
    from: NewCircuitEndPlan
    to: NewCircuitEndPlan
    /** Straight-line distance between the places. */
    km?: number
    /** Paths between the two places (either way), best first. */
    pathChoices: TransmissionPathRecord[]
    /** The path the circuit runs on; `reversed`: it runs TO → FROM and the circuit follows it. */
    path?: TransmissionPathRecord
    pathCreated: boolean
    reversed: boolean
    circuit?: TransmissionCircuitRecord
    /** Rule names for the empty fields. */
    autoCircuit?: Naming
    autoPath?: Naming
    /** The voltage the circuit gets from its connections (what an empty `energizedVoltage` means). */
    autoEnergized?: TransmissionVoltage
    warnings: string[]
    /** Worth knowing, nothing to fix (shown in blue): running below the rating, joining circuits at the same voltage. */
    notes: string[]
    errors: string[]
}

const parsePlace = (place: string): { kind: 'G' | 'J'; id: string } | undefined => {
    const m = /^([GJ]):(.+)$/.exec(place)
    return m ? {kind: m[1] as 'G' | 'J', id: m[2]} : undefined
}

/** A take-off's voltage: its circuit's (a line leaving at another voltage than the yard's), else the yard's. */
const takeOffVoltage = (doc: NetworkDocument, t: SubstationTakeOffRecord) => takeOffCircuitVoltage(doc, t.id)

/** The yards of a site, highest voltage first. */
export const yardsOf = (doc: NetworkDocument, groupId: string) => doc.substations.filter(y => y.groupId === groupId).sort((a, b) => voltageKv(b.voltage) - voltageKv(a.voltage) || a.yardName.localeCompare(b.yardName))

/**
 * How an end connects when nothing was picked: at a junction a node of its own; at a site the yard at `voltage` (the
 * energized voltage when one is given, else the rated one) when the other end can take it too, else at a voltage the
 * other site has within that rating, else at `voltage`, else the highest within it, else the highest; through a free
 * take-off it already has toward the other site at that yard's voltage, else a new one; the site junction when the site
 * has no yards.
 */
export function defaultCircuitConnect(doc: NetworkDocument, place: string, otherPlace: string, voltage?: TransmissionVoltage): NewCircuitConnect | undefined {
    const p = parsePlace(place)
    if (!p) return undefined
    if (p.kind === 'J') return {kind: 'junction'}
    const yards = yardsOf(doc, p.id)
    if (!yards.length) return {kind: 'junction'}
    const other = parsePlace(otherPlace)
    const otherVoltages = other?.kind === 'G' ? new Set(yardsOf(doc, other.id).map(y => y.voltage)) : new Set<string>()
    const fits = (v: TransmissionVoltage) => !voltage || withinRating(voltage, v)
    const yard = yards.find(y => voltage && y.voltage === voltage && (other?.kind !== 'G' || otherVoltages.has(y.voltage)))
        ?? yards.find(y => otherVoltages.has(y.voltage) && fits(y.voltage))
        ?? yards.find(y => voltage && y.voltage === voltage) ?? yards.find(y => fits(y.voltage)) ?? yards[0]
    const toward = other?.kind === 'G' ? freeTakeOffsToward(doc, yard.id, other.id).find(t => takeOffVoltage(doc, t) === yard.voltage) : undefined
    return toward ? {kind: 'takeOff', takeOffId: toward.id} : {kind: 'newTakeOff', yardId: yard.id}
}

/**
 * The rated voltage the ends suggest when none is picked: what the FROM end connects to (a take-off or its yard, or
 * the node it joins), else the TO end's, each end's default connection worked out without a voltage (so the two ends
 * settle on a voltage both sites have).
 */
export function suggestedCircuitVoltage(doc: NetworkDocument, from: NewCircuitEndSpec, to: NewCircuitEndSpec): TransmissionVoltage | undefined {
    const voltageOf = (end: NewCircuitEndSpec, other: NewCircuitEndSpec): TransmissionVoltage | undefined => {
        const connect = end.connect ?? defaultCircuitConnect(doc, end.place, other.place)
        if (connect?.kind === 'takeOff') {
            const t = doc.takeOffs.find(x => x.id === connect.takeOffId)
            return t && takeOffVoltage(doc, t)
        }
        if (connect?.kind === 'newTakeOff') return doc.substations.find(y => y.id === connect.yardId)?.voltage
        const node = connect?.connectionId ? doc.connections.find(c => c.id === connect.connectionId) : undefined
        return node && nodeRunningVoltage(doc, node)
    }
    return voltageOf(from, to) ?? voltageOf(to, from)
}

export function buildNewCircuitPlan(doc: NetworkDocument, spec: NewCircuitSpec): NewCircuitPlan {
    const errors: string[] = []
    const warnings: string[] = []
    const notes: string[] = []
    const ops: NetworkOp[] = []
    let probe = doc
    const push = (...next: NetworkOp[]) => {
        ops.push(...next)
        probe = applyOps(probe, next)
    }
    const idProblem = (what: string, id?: string) => {
        const reason = id?.trim() ? checkCreateId(doc, id.trim()) : undefined
        if (reason) errors.push(`${what}: ${reason}`)
    }

    // 1. the ends: the place, and the take-off or junction (node) the end connects to; take-offs and site junctions
    // the plan creates are added to the probe right away, so the other end and the naming see them
    /** The energized voltage asked for (not 0 V): the default yard is the one at it. */
    const asked = spec.energizedVoltage && spec.energizedVoltage !== TransmissionVoltage.DE_ENERGIZED ? spec.energizedVoltage : undefined
    const resolve = (end: NewCircuitEndSpec, other: NewCircuitEndSpec, side: 'FROM' | 'TO'): NewCircuitEndPlan => {
        const out: NewCircuitEndPlan = {takeOffCreated: false, junctionCreated: false, open: false, label: '–'}
        const p = parsePlace(end.place)
        if (!p) {
            errors.push(`pick where the circuit ${side === 'FROM' ? 'starts' : 'ends'}`)
            return out
        }
        let junction: TransmissionJunctionRecord | undefined
        if (p.kind === 'G') {
            const site = doc.substationGroups.find(g => g.id === p.id)
            if (!site) {
                errors.push(`site ${p.id} no longer exists`)
                return out
            }
            out.site = site
            out.ref = siteRef(site.id)
            out.label = site.groupName
            const connect = end.connect ?? defaultCircuitConnect(doc, end.place, other.place, asked ?? spec.voltage)!
            out.connect = connect
            if (connect.kind === 'takeOff') {
                const t = doc.takeOffs.find(x => x.id === connect.takeOffId)
                const yard = t && doc.substations.find(y => y.id === t.substationId && y.groupId === site.id)
                if (!t || !yard) errors.push(`take-off ${connect.takeOffId} is not a take-off of ${site.groupName}`)
                else if (!freeTakeOffs(probe, yard.id).some(x => x.id === t.id)) errors.push(`take-off ${t.lineName} at ${site.groupName} ${yard.yardName} is already connected`)
                else Object.assign(out, {takeOff: t, yard, voltage: takeOffVoltage(doc, t), label: `${site.groupName} ${yard.yardName} · take-off ${t.lineName}`})
                return out
            }
            if (connect.kind === 'newTakeOff') {
                const yard = doc.substations.find(y => y.id === connect.yardId && y.groupId === site.id)
                if (!yard) {
                    errors.push(`yard ${connect.yardId} is not a yard of ${site.groupName}`)
                    return out
                }
                // made by hand: the take-off goes where it was picked, at its yard's voltage (a mismatch is warned below)
                const carried = yard.voltage
                const lineName = connect.lineName?.trim()
                let t: SubstationTakeOffRecord
                if (lineName) {
                    if (probe.takeOffs.some(x => x.substationId === yard.id && x.lineName === lineName)) errors.push(`${site.groupName} ${yard.yardName} already has a take-off ${lineName}`)
                    const naming = takeOffNaming(probe, yard.id, lineName)
                    t = {id: uniqueId(probe, naming.id), name: naming.name, substationId: yard.id, lineName, takeOffColumn: true}
                } else {
                    // named toward the other end: its site, else the junction
                    const target = parsePlace(other.place)
                    t = newTakeOffToward(probe, yard.id, target ? (target.kind === 'G' ? siteRef(target.id) : junctionRef(target.id)) : undefined, carried)
                }
                push({type: 'upsert', collection: 'takeOffs', record: t})
                Object.assign(out, {takeOff: t, takeOffCreated: true, yard, voltage: carried, label: `${site.groupName} ${yard.yardName} · new take-off ${t.lineName}`})
                return out
            }
            // the site junction, created when the site has none
            junction = siteJunctionOf(probe, site.id)
            if (!junction) {
                junction = newSiteJunctionRecord(probe, site)
                push({type: 'upsert', collection: 'junctions', record: junction})
                out.junctionCreated = true
            }
        } else {
            junction = doc.junctions.find(j => j.id === p.id)
            if (!junction) {
                errors.push(`junction ${p.id} no longer exists`)
                return out
            }
            const site = junction.groupId ? doc.substationGroups.find(g => g.id === junction!.groupId) : undefined
            out.site = site
            out.ref = site ? siteRef(site.id) : junctionRef(junction.id)
            out.connect = end.connect?.kind === 'junction' ? end.connect : {kind: 'junction'}
        }
        out.junction = junction
        const connect = out.connect?.kind === 'junction' ? out.connect : {kind: 'junction' as const}
        out.connect = connect
        const jName = `junction ${junction.name ?? junction.id}`
        if (connect.connectionId) {
            const node = connectionsAtJunction(probe, junction.id).find(c => c.id === connect.connectionId)
            if (!node) errors.push(`node ${connect.connectionId} is not at ${jName}`)
            else Object.assign(out, {node, voltage: nodeRunningVoltage(probe, node), label: `${out.site ? `${out.site.groupName} · ` : ''}${jName} · node ${node.name ?? node.id}`})
        } else Object.assign(out, {open: true, label: `${out.site ? `${out.site.groupName} · ` : ''}${jName}${out.junctionCreated ? ' (new)' : ''} · a node of its own`})
        return out
    }
    const from = resolve(spec.from, spec.to, 'FROM')
    const to = resolve(spec.to, spec.from, 'TO')
    if (from.ref && to.ref && samePlace(doc, from.ref, to.ref)) errors.push('the two ends must be different places')
    for (const [end, what] of [[spec.from, 'FROM connection id'], [spec.to, 'TO connection id']] as const) idProblem(what, end.connectionId)
    idProblem('circuit id', spec.id)
    const a = locationOfRef(doc, from.ref), b = locationOfRef(doc, to.ref)
    const km = a && b ? Number(haversineKm(a.coords, b.coords).toFixed(2)) : undefined
    const pathChoices = from.ref && to.ref && !samePlace(doc, from.ref, to.ref) ? pathsBetween(doc, from.ref, to.ref) : []
    const plan: NewCircuitPlan = {ops: [], from, to, km, pathChoices, pathCreated: false, reversed: false, warnings, notes, errors}
    if (!from.ref || !to.ref || errors.length) return plan

    // 2. the path: an existing one between the two places (the circuit follows its direction), else a new one
    const autoPath = pathNaming(probe, from.ref, to.ref)
    plan.autoPath = autoPath
    let path: TransmissionPathRecord
    const chosen = spec.newPath ? undefined : spec.pathId ? pathChoices.find(p => p.id === spec.pathId) : pathChoices[0]
    if (!spec.newPath && spec.pathId && !chosen) {
        errors.push(`path ${spec.pathId} does not run between ${from.label} and ${to.label}`)
        return plan
    }
    if (chosen) {
        path = chosen
        plan.reversed = !samePlace(doc, chosen.from, from.ref)
    } else {
        idProblem('path id', spec.newPathId)
        const naming = pathNaming(probe, from.ref, to.ref, spec.newPathName)
        path = {id: pickId(probe, spec.newPathId, naming.id), name: naming.name, from: from.ref, to: to.ref, waypoints: []}
        push({type: 'upsert', collection: 'paths', record: path})
        plan.pathCreated = true
    }
    plan.path = path
    /** The circuit's FROM and TO ends: the ones picked, swapped on a path that runs the other way. */
    const [first, second] = plan.reversed ? [to, from] : [from, to]
    const [firstSpec, secondSpec] = plan.reversed ? [spec.to, spec.from] : [spec.from, spec.to]

    // 3. the circuit: energized at the voltage chosen, else its connections' (FROM first), de-energized when both ends are
    // open (nothing reaches it); a node of its own at that voltage
    plan.autoEnergized = first.voltage ?? second.voltage ?? (first.open && second.open ? TransmissionVoltage.DE_ENERGIZED : spec.voltage)
    const energized = spec.energizedVoltage ?? plan.autoEnergized
    const nodeVoltage = energized ?? spec.voltage
    // an end at another voltage than the circuit runs at: allowed by hand, warned (a de-energized circuit may join anything)
    if (energized && energized !== TransmissionVoltage.DE_ENERGIZED) {
        for (const [end, side] of [[from, 'FROM'], [to, 'TO']] as const) {
            if (!end.voltage || end.voltage === energized) continue
            warnings.push(end.takeOff && !end.takeOffCreated ? `the ${side} end: take-off ${end.takeOff.lineName} is at ${end.voltage}, the circuit is energized at ${energized}`
                : end.node ? `the ${side} end: node ${end.node.name ?? end.node.id} runs at ${end.voltage}, the circuit is energized at ${energized}`
                    : `the ${side} end: ${end.label} is at ${end.voltage}, the circuit is energized at ${energized}`)
        }
    }
    const autoCircuit = circuitNaming(probe, {pathId: path.id, voltage: spec.voltage, from: first.ref, to: second.ref})
    plan.autoCircuit = autoCircuit
    const naming = spec.name?.trim() ? circuitNaming(probe, {name: spec.name}) : autoCircuit
    const circuit: TransmissionCircuitRecord = {
        id: pickId(probe, spec.id, naming.id), name: naming.name, pathId: path.id,
        voltage: spec.voltage, energizedVoltage: energized, bundle: spec.bundle, conductor: spec.conductor ?? genericConductor(), lengthKm: spec.lengthKm,
    }
    // attach both ends (the circuit is added last: the helpers' energize ops are not needed, the voltage is set above)
    const attach = (end: NewCircuitEndPlan, endSpec: NewCircuitEndSpec, circuitEnd: CircuitEnd) => {
        const opts = {newId: endSpec.connectionId?.trim() || undefined, newName: endSpec.connectionName?.trim() || undefined}
        const next = end.takeOff ? attachCircuitEndToTakeOffOps(probe, circuit.id, circuitEnd, end.takeOff.id, opts)
            : attachCircuitEndToJunctionOps(probe, circuit.id, circuitEnd, end.junction!.id, nodeVoltage, end.node ? {connectionId: end.node.id} : {forceNew: true, ...opts})
        push(...next.filter(o => !(o.type === 'upsert' && o.collection === 'circuits')))
    }
    attach(first, firstSpec, CIRCUIT_END_FROM)
    attach(second, secondSpec, CIRCUIT_END_TO)
    push({type: 'upsert', collection: 'circuits', record: circuit})
    plan.circuit = circuit
    plan.ops = ops

    // 4. what is worth a look
    if (from.site && from.site.id === to.site?.id) warnings.push('both ends belong to the same site')
    for (const [end, side] of [[from, 'FROM'], [to, 'TO']] as const) {
        if (end.open) warnings.push(`the ${side} end is open: a node of its own at ${end.junction?.name ?? end.junction?.id}, connected to nothing else (pick a node to join, or join it later from the junction panel)`)
    }
    for (const [end, side] of [[from, 'FROM'], [to, 'TO']] as const) {
        const joined = end.node ? runningVoltagesAt(probe, end.node, [circuit.id]).circuits : []
        if (joined.length && end.voltage === energized) notes.push(`the ${side} end joins ${joined.map(c => c.name).join(', ')} at node ${end.node!.name ?? end.node!.id}, all at ${energized}`)
    }
    const rating = energizedVsRated(spec.voltage, energized)
    if (rating === 'lower') warnings.push(`energized at ${energized}, below its rated ${spec.voltage}: drawn with a dotted overlay in the rated colour`)
    else if (rating === 'deEnergized') notes.push(first.open && second.open && !spec.energizedVoltage ? 'both ends are open: the circuit is de-energized (0 V) until it is connected' : 'de-energized (0 V)')
    else if (rating === 'higher') warnings.push(`energized at ${energized}, above its rated ${spec.voltage}`)
    else if (rating === 'typeMismatch') warnings.push(`energized at ${energized}, but rated ${spec.voltage}: AC and DC do not mix`)
    if (from.open && to.open && spec.energizedVoltage && spec.energizedVoltage !== TransmissionVoltage.DE_ENERGIZED) {
        warnings.push(`both ends are open, yet it is energized at ${spec.energizedVoltage}: nothing feeds it (empty, it would be de-energized, 0 V)`)
    }
    if (!spec.voltage) warnings.push('no rated voltage: pick one, or a circuit template')
    if (errors.length) plan.ops = []
    return plan
}

/** The sites and junctions a place list offers for a circuit end: every site, and every junction that is not a site's own (the site stands for it). */
export function circuitPlaceOptions(doc: NetworkDocument): { value: string; label: string }[] {
    const sites = doc.substationGroups.map(g => ({
        value: `G:${g.id}`,
        label: `${g.groupName}${g.name && g.name !== g.groupName ? ` – ${g.name}` : ''} (${yardsOf(doc, g.id).map(y => y.yardName).join(', ') || 'no yards'})`,
    }))
    const junctions = doc.junctions.filter(j => !j.groupId).map(j => ({value: `J:${j.id}`, label: `Junction ${j.name ?? j.id}`}))
    return [...sites, ...junctions].sort((x, y) => x.label.localeCompare(y.label))
}

