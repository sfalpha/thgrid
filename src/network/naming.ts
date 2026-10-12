/**
 * Default ids and names for new network records.
 *
 * The runtime classes (`SubstationUnit` / `TransmissionUnit` subclasses) own
 * the naming rules: a class prefix (`SSY`, `TCC`, …) plus tokens taken from
 * related items (site code, yard name, the endpoints of a route, …), exposed
 * as static `defaultId()` / `defaultName()`. This module feeds those statics
 * from the flat records of a document, so the editors propose the same ids
 * and names the classes would. The ids returned here are *base* ids: callers
 * wrap them in `pickId()` / `uniqueId()` (see `ops.ts`), which keep them
 * unique within the document by appending `_2`, `_3`, …
 */
import {
    AnyNetworkRecord,
    CIRCUIT_END_FROM,
    CIRCUIT_END_TO,
    ConnectionJunctionKind,
    ConnectionJunctionRef,
    ConnectionScope,
    NetworkCollectionName,
    NetworkDocument,
    NetworkNodeKind,
    networkCollectionNames,
    TransmissionCircuitRecord,
    TransmissionLineRecord,
} from "./records";
import {applyOps, NetworkOp, renameRecordOps} from "./ops";
import {pathEndOf} from "./refs";
import {TransmissionVoltage} from "../models/transmission.voltage";
import {SubstationGroup} from "../models/substation.group";
import {Substation} from "../models/substation";
import {SubstationBay} from "../models/substation.bay";
import {SubstationBus, SubstationBusType} from "../models/substation.bus";
import {SubstationCircuit} from "../models/substation.circuit";
import {SubstationEquipment, SubstationEquipmentType} from "../models/substation.equipment";
import {SubstationTakeOff} from "../models/substation.take.off";
import {TransmissionJunction} from "../models/transmission.junction";
import {TransmissionPath} from "../models/transmission.path";
import {TransmissionCircuit} from "../models/transmission.circuit";
import {TransmissionConnection} from "../models/transmission.connection";
import {TransmissionLine} from "../models/transmission.line";
import {joinName, voltageLabel} from "../models/naming";

export interface Naming {
    /** Base id (not yet made unique). */
    id: string
    name: string
}

/** Site code and yard name of a yard record, for the substation-side hints. */
export function yardHints(doc: NetworkDocument, substationId: string): { groupName?: string; yardName?: string } {
    const yard = doc.substations.find(s => s.id === substationId)
    const group = yard && doc.substationGroups.find(g => g.id === yard.groupId)
    return {groupName: group?.groupName, yardName: yard?.yardName}
}

/**
 * Name token of a path / circuit end: a yard as `<site>_<yard>` (`style`
 * "yard") or just its site code (`style` "site", the EGAT circuit style), a
 * junction by its name.
 */
export function endpointToken(doc: NetworkDocument, ref: ConnectionJunctionRef | undefined, style: 'yard' | 'site' = 'yard'): string | undefined {
    if (!ref) return undefined
    if (ref.kind === ConnectionJunctionKind.SUBSTATION_GROUP) return doc.substationGroups.find(g => g.id === ref.id)?.groupName || ref.id
    if (ref.kind === ConnectionJunctionKind.SUBSTATION) {
        const {groupName, yardName} = yardHints(doc, ref.id)
        if (!groupName) return ref.id
        return style === 'site' || !yardName ? groupName : `${groupName}_${yardName}`
    }
    const j = doc.junctions.find(x => x.id === ref.id)
    return j?.name || ref.id
}

/* ---------- substation side ---------- */

export function siteNaming(groupName: string, name?: string): Naming {
    return {id: SubstationGroup.defaultId({groupName}), name: name?.trim() || SubstationGroup.defaultName({groupName}) || groupName}
}

/** A yard: name from `yardName`, else from the voltage (`230KV`, `300KVDC`); id `SSY_<site>_<yard>`. */
export function yardNaming(doc: NetworkDocument, groupId: string, yardName?: string, voltage?: TransmissionVoltage | string): Naming {
    const groupName = doc.substationGroups.find(g => g.id === groupId)?.groupName
    const hints = {groupName, yardName: yardName?.trim() || undefined, voltage}
    return {id: Substation.defaultId(hints), name: Substation.defaultName(hints) || yardName || 'YARD'}
}

export function bayNaming(doc: NetworkDocument, substationId: string, bayNumber: string): Naming {
    const hints = {...yardHints(doc, substationId), bayNumber}
    return {id: SubstationBay.defaultId(hints), name: SubstationBay.defaultName(hints) || bayNumber}
}

export function busNaming(doc: NetworkDocument, substationId: string, busType: SubstationBusType | string, busNumber?: string): Naming {
    const hints = {...yardHints(doc, substationId), busType, busNumber}
    return {id: SubstationBus.defaultId(hints), name: SubstationBus.defaultName(hints) || String(busType)}
}

export function equipmentNaming(doc: NetworkDocument, substationId: string, code: string, equipmentType: SubstationEquipmentType | string): Naming {
    const hints = {...yardHints(doc, substationId), code, equipmentType}
    return {id: SubstationEquipment.defaultId(hints), name: SubstationEquipment.defaultName(hints) || code}
}

export function takeOffNaming(doc: NetworkDocument, substationId: string, lineName: string): Naming {
    const hints = {...yardHints(doc, substationId), lineName}
    return {id: SubstationTakeOff.defaultId(hints), name: SubstationTakeOff.defaultName(hints) || lineName}
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Line name of a new take-off from a yard toward another site:
 * `<voltage>_<target code>_L<n>` (`230KV_CTI_L1`), `n` following the highest
 * `L<n>` the yard already has toward that site (names without the voltage
 * part count too). Undefined for an unknown site.
 */
export function takeOffLineName(doc: NetworkDocument, substationId: string, targetGroupId: string, voltage?: TransmissionVoltage): string | undefined {
    const target = doc.substationGroups.find(g => g.id === targetGroupId)
    const yard = doc.substations.find(s => s.id === substationId)
    if (!target) return undefined
    const re = new RegExp(`^(?:[A-Z0-9]+_)?${escapeRegExp(target.groupName)}_L(\\d+)$`, 'i')
    let max = 0
    for (const t of doc.takeOffs) {
        if (t.substationId !== substationId) continue
        const m = re.exec(t.lineName)
        if (m) max = Math.max(max, Number(m[1]))
    }
    return SubstationTakeOff.defaultLineName({targetCode: target.groupName, voltage: voltage ?? yard?.voltage, sequence: max + 1})
}

/** An anonymous wiring node inside a yard (SUBSTATION-scope connection): `SCC_<site>_<yard>_X<n>`. */
export function yardWiringNaming(doc: NetworkDocument, substationId: string): Naming {
    const sequence = doc.connections.filter(c => c.scope === ConnectionScope.SUBSTATION && c.junction.id === substationId).length + 1
    const hints = {...yardHints(doc, substationId), sequence}
    return {id: SubstationCircuit.defaultId(hints), name: SubstationCircuit.defaultName(hints) || `X${sequence}`}
}

/* ---------- transmission side ---------- */

export function junctionNaming(doc: NetworkDocument, name?: string): Naming {
    const hints = {name: name?.trim() || undefined, sequence: doc.junctions.length + 1}
    return {id: TransmissionJunction.defaultId(hints), name: TransmissionJunction.defaultName(hints)}
}

const sameEnd = (a?: ConnectionJunctionRef, b?: ConnectionJunctionRef) => !!a && !!b && a.kind === b.kind && a.id === b.id

/**
 * A route between two ends: `<from>-<to>` with a yard named by its site code
 * only (a route is not specific to a voltage: `CTI-TRD`, not
 * `CTI_115KV-TRD_115KV`), numbered when other paths already run between the
 * same two names (another yard pair of the same sites counts too).
 */
export function pathNaming(doc: NetworkDocument, from?: ConnectionJunctionRef, to?: ConnectionJunctionRef, name?: string): Naming {
    const fromToken = endpointToken(doc, from, 'site'), toToken = endpointToken(doc, to, 'site')
    const sequence = doc.paths.filter(p => endpointToken(doc, p.from, 'site') === fromToken && endpointToken(doc, p.to, 'site') === toToken).length + 1
    const hints = {name: name?.trim() || undefined, from: fromToken, to: toToken, sequence}
    return {id: TransmissionPath.defaultId(hints), name: TransmissionPath.defaultName(hints) || 'path'}
}

/**
 * Circuit names (the model rules):
 * - a circuit that belongs to a line: `<line name>_<path name>` (of several lines, the first by name);
 * - one that belongs to no line: `<voltage>_<path name>_S<n>`, the rated voltage (else the energized one) without
 *   its AC prefix, n numbering the circuits on that path that belong to no line.
 * A circuit without a path stands in `<FROM>-<TO>` (its ends' site codes) for the path name. The id is `TCC_<name>`.
 */
export interface CircuitNamingInput {
    /** The circuit's path (or the name of a path about to be created, `pathName`). */
    pathId?: string
    pathName?: string
    /** The line the circuit belongs to (or will), if any. */
    lineName?: string
    voltage?: TransmissionVoltage | string
    /** Ends, for a circuit without a path. */
    from?: ConnectionJunctionRef
    to?: ConnectionJunctionRef
    /** A typed name: used as it is. */
    name?: string
}

/** The path part of a circuit name: the path's name, else `<FROM>-<TO>` from the ends' site codes. */
function circuitPathLabel(doc: NetworkDocument, pathId?: string, pathName?: string, from?: ConnectionJunctionRef, to?: ConnectionJunctionRef): string {
    const path = pathId ? doc.paths.find(p => p.id === pathId) : undefined
    return pathName?.trim() || path?.name || [endpointToken(doc, from, 'site'), endpointToken(doc, to, 'site')].filter(Boolean).join('-') || 'NOPATH'
}

/** The first line (by name) a circuit belongs to. */
function firstLineOf(doc: NetworkDocument, circuitId: string): TransmissionLineRecord | undefined {
    return doc.lines.filter(l => l.circuitIds.includes(circuitId)).sort((a, b) => a.name.localeCompare(b.name))[0]
}

/** Circuits sharing a path (or, without one, the same ends) that belong to no line: the ones numbered `S<n>` together. */
function unlinedSiblings(doc: NetworkDocument, label: string, pathId?: string): TransmissionCircuitRecord[] {
    return doc.circuits.filter(c => !doc.lines.some(l => l.circuitIds.includes(c.id))
        && (pathId ? c.pathId === pathId : !c.pathId && circuitPathLabel(doc, undefined, undefined, circuitEndOrPathEnd(doc, c.id, CIRCUIT_END_FROM), circuitEndOrPathEnd(doc, c.id, CIRCUIT_END_TO)) === label))
}

const circuitNameOf = (parts: (string | undefined)[]) => joinName(parts)

/** The name and id a new circuit gets (see `CircuitNamingInput`); an unlined one takes the first free `S<n>` on its path. */
export function circuitNaming(doc: NetworkDocument, input: CircuitNamingInput): Naming {
    if (input.name?.trim()) {
        const name = input.name.trim()
        return {id: TransmissionCircuit.defaultId({name}), name}
    }
    const label = circuitPathLabel(doc, input.pathId, input.pathName, input.from, input.to)
    let name: string
    if (input.lineName) name = circuitNameOf([input.lineName, label])
    else {
        const used = new Set(unlinedSiblings(doc, label, input.pathId).map(c => nameSequence('circuits', c.name)).filter((n): n is number => n !== undefined))
        let n = 1
        while (used.has(n)) n++
        name = circuitNameOf([voltageLabel(input.voltage ? String(input.voltage) : undefined), label, `S${n}`])
    }
    return {id: TransmissionCircuit.defaultId({name}), name}
}

/** True when the two lines run between the same pair of yards, in either direction. */
function samePair(a: { from?: ConnectionJunctionRef; to?: ConnectionJunctionRef }, from?: ConnectionJunctionRef, to?: ConnectionJunctionRef): boolean {
    const eq = (x?: ConnectionJunctionRef, y?: ConnectionJunctionRef) => !!x && !!y && x.kind === y.kind && x.id === y.id
    return (eq(a.from, from) && eq(a.to, to)) || (eq(a.from, to) && eq(a.to, from))
}

/** A named line: the typed name, or `<kV>_<site>_<site>_L<n>` from its ends, numbered among the lines between the same two yards. */
export function lineNaming(doc: NetworkDocument, name?: string, from?: ConnectionJunctionRef, to?: ConnectionJunctionRef, voltage?: TransmissionVoltage | string): Naming {
    const sequence = from && to ? doc.lines.filter(l => samePair(l, from, to)).length + 1 : 1
    const hints = {name: name?.trim() || undefined, from: endpointToken(doc, from, 'site'), to: endpointToken(doc, to, 'site'), voltage, sequence}
    return {id: TransmissionLine.defaultId(hints), name: TransmissionLine.defaultName(hints) || 'line'}
}

/** The TRANSMISSION node a take-off starts: named after the take-off's line, `TCN_<site>_<yard>_<line>`. */
export function takeOffConnectionNaming(doc: NetworkDocument, takeOffId: string): Naming {
    const takeOff = doc.takeOffs.find(t => t.id === takeOffId)
    const at = takeOff ? endpointToken(doc, {kind: ConnectionJunctionKind.SUBSTATION, id: takeOff.substationId}) : undefined
    const hints = {at, takeOff: takeOff?.lineName}
    return {id: TransmissionConnection.defaultId(hints), name: TransmissionConnection.defaultName(hints) || takeOffId}
}

/**
 * A node at a junction: `<junction>_<n>` with the first free `n` (names
 * already taken in the document, plus `extraTaken`, are skipped), id
 * `TCN_<junction>_<n>`. A typed `name` is kept and only the id is derived.
 */
export function junctionConnectionNaming(doc: NetworkDocument, junctionId: string, name?: string, extraTaken: string[] = []): Naming {
    const at = endpointToken(doc, {kind: ConnectionJunctionKind.TRANSMISSION_JUNCTION, id: junctionId}) || junctionId
    const taken = new Set([...doc.connections.filter(c => c.name).map(c => c.name!), ...extraTaken])
    let sequence = 1
    while (taken.has(TransmissionConnection.defaultName({at, sequence})!)) sequence++
    const hints = {name: name?.trim() || undefined, at, sequence}
    return {id: TransmissionConnection.defaultId(hints), name: TransmissionConnection.defaultName(hints) || `${at}_${sequence}`}
}

/* ---------- regenerating existing records ---------- */

/** Collections whose records can get their id from the model rules. A site regenerates its id (`SSG_<code>`) only, a junction its id from its name (`TJT_<name>`) only. */
export const REGENERABLE_COLLECTIONS: NetworkCollectionName[] = ['substationGroups', 'junctions', 'substations', 'buses', 'bays', 'equipments', 'takeOffs', 'paths', 'circuits', 'lines']
/** Of those, the ones whose `name` is derived too: from the code / number / line name inside a yard, from the ends on the transmission side. A site keeps the name the user gave it and a yard its optional display name. */
export const NAME_REGENERABLE_COLLECTIONS: NetworkCollectionName[] = ['buses', 'bays', 'equipments', 'takeOffs', 'paths', 'circuits', 'lines']
const NAMED_BY_RULES = NAME_REGENERABLE_COLLECTIONS

const sameEndRef = (a?: ConnectionJunctionRef, b?: ConnectionJunctionRef) => (!a && !b) || (!!a && !!b && a.kind === b.kind && a.id === b.id)

/** The sequence number the rule name of a path (`A-B` = 1, `A-B (2)`), circuit (`…_S2`) or line (`…_L2`) carries; undefined for other names. */
function nameSequence(collection: 'paths' | 'circuits' | 'lines', name?: string): number | undefined {
    if (!name) return undefined
    const m = collection === 'paths' ? / \((\d+)\)$/.exec(name) : collection === 'circuits' ? /_S(\d+)$/.exec(name) : /_L(\d+)$/.exec(name)
    if (m) return Number(m[1])
    return collection === 'paths' && name.includes('-') ? 1 : undefined
}

/**
 * Parallel records (same ends) in the order they are numbered: by the sequence
 * their current names carry, names without one last, then by name and id. Not
 * by document order, which a rename changes (the renamed record moves to the
 * end), so regenerating twice gives the same numbers.
 */
function inSequenceOrder<R extends { id: string; name?: string }>(collection: 'paths' | 'circuits' | 'lines', records: R[]): R[] {
    const key = (r: R) => nameSequence(collection, r.name) ?? Number.POSITIVE_INFINITY
    return [...records].sort((a, b) => key(a) - key(b) || (a.name ?? '').localeCompare(b.name ?? '', undefined, {numeric: true, sensitivity: 'base'}) || a.id.localeCompare(b.id))
}

/**
 * The sequence number `record` gets among its parallel `siblings` when the `renamed` ones (it included) are numbered
 * by the rules and the others keep their names: in `inSequenceOrder`, each renamed record takes the next number that
 * no kept sibling's name already carries. With every sibling renamed that is simply 1, 2, 3, ...; renaming only some
 * (records moved onto a path that already has S1 to S4) never hands out a number a kept sibling still uses.
 */
function sequenceAmong<R extends { id: string; name?: string }>(collection: 'paths' | 'circuits' | 'lines', siblings: R[], record: R, renamed: ReadonlySet<string>): number {
    const ordered = inSequenceOrder(collection, siblings.includes(record) ? siblings : [...siblings, record])
    const moving = (r: R) => r.id === record.id || renamed.has(r.id)
    const used = new Set(ordered.filter(r => !moving(r)).map(r => nameSequence(collection, r.name)).filter((n): n is number => n !== undefined))
    const k = ordered.filter(moving).indexOf(record)
    for (let seq = 1, n = 0; ; seq++) {
        if (used.has(seq)) continue
        if (n === k) return seq
        n++
    }
}

/** Where a circuit end is connected (as a path end: the yard's site, or the junction), else where its path ends. */
function circuitEndOrPathEnd(doc: NetworkDocument, circuitId: string, end: string): ConnectionJunctionRef | undefined {
    const conn = doc.connections.find(c => c.scope === ConnectionScope.TRANSMISSION && c.nodes.some(n => n.kind === NetworkNodeKind.TRANSMISSION_CIRCUIT && n.id === circuitId && n.terminal === end))
    if (conn) return pathEndOf(doc, conn.junction) ?? conn.junction
    const circuit = doc.circuits.find(c => c.id === circuitId)
    const path = circuit && doc.paths.find(p => p.id === circuit.pathId)
    return end === CIRCUIT_END_FROM ? path?.from : path?.to
}

/**
 * The id / name an existing record would get from the model rules today.
 * Parallel paths, circuits and lines (same ends) are numbered in the order of
 * the numbers their current names carry (`inSequenceOrder`), so regenerating
 * a whole group yields `S1`, `S2`, … and keeps the existing order. `renamed`
 * (default: just this record) are the records renumbered together; the other
 * siblings keep their numbers (`sequenceAmong`). Undefined for records that
 * are not regenerable or no longer exist.
 */
export function defaultNamingFor(doc: NetworkDocument, collection: NetworkCollectionName, id: string, renamed: ReadonlySet<string> = new Set([id])): Naming | undefined {
    switch (collection) {
        case 'substationGroups': {
            // Mass regeneration takes the id only (sites are not in NAME_REGENERABLE_COLLECTIONS); the site panel's "auto" buttons use both.
            const g = doc.substationGroups.find(r => r.id === id)
            return g && siteNaming(g.groupName)
        }
        case 'junctions': {
            // The id follows the name (`TJT_<name>`); an unnamed site junction goes by its site's code, any other unnamed one has no rule.
            const j = doc.junctions.find(r => r.id === id)
            const name = j && (j.name?.trim() || (j.groupId ? doc.substationGroups.find(g => g.id === j.groupId)?.groupName : undefined))
            return name ? {id: TransmissionJunction.defaultId({name}), name} : undefined
        }
        case 'substations': {
            const y = doc.substations.find(r => r.id === id)
            return y && yardNaming(doc, y.groupId, y.yardName)
        }
        case 'buses': {
            const b = doc.buses.find(r => r.id === id)
            return b && busNaming(doc, b.substationId, b.busType, b.busNumber)
        }
        case 'bays': {
            const b = doc.bays.find(r => r.id === id)
            return b && bayNaming(doc, b.substationId, b.bayNumber)
        }
        case 'equipments': {
            const e = doc.equipments.find(r => r.id === id)
            return e && equipmentNaming(doc, e.substationId, e.code, e.equipmentType)
        }
        case 'takeOffs': {
            const t = doc.takeOffs.find(r => r.id === id)
            return t && takeOffNaming(doc, t.substationId, t.lineName)
        }
        case 'paths': {
            const p = doc.paths.find(r => r.id === id)
            if (!p) return undefined
            const fromToken = endpointToken(doc, p.from, 'site'), toToken = endpointToken(doc, p.to, 'site')
            const siblings = doc.paths.filter(x => endpointToken(doc, x.from, 'site') === fromToken && endpointToken(doc, x.to, 'site') === toToken)
            const hints = {from: fromToken, to: toToken, sequence: sequenceAmong('paths', siblings, p, renamed)}
            return {id: TransmissionPath.defaultId(hints), name: TransmissionPath.defaultName(hints) || p.name}
        }
        case 'circuits': {
            const c = doc.circuits.find(r => r.id === id)
            if (!c) return undefined
            const label = circuitPathLabel(doc, c.pathId, undefined, circuitEndOrPathEnd(doc, c.id, CIRCUIT_END_FROM), circuitEndOrPathEnd(doc, c.id, CIRCUIT_END_TO))
            const line = firstLineOf(doc, c.id)
            let name: string
            if (line) {
                // circuits of one line on one path (rare) are told apart by _2, _3, … in id order
                const same = doc.circuits.filter(x => firstLineOf(doc, x.id)?.id === line.id && circuitPathLabel(doc, x.pathId, undefined, circuitEndOrPathEnd(doc, x.id, CIRCUIT_END_FROM), circuitEndOrPathEnd(doc, x.id, CIRCUIT_END_TO)) === label)
                    .sort((a, b) => a.id.localeCompare(b.id))
                const k = same.findIndex(x => x.id === c.id)
                name = circuitNameOf([line.name, label, k > 0 ? String(k + 1) : undefined])
            } else {
                const siblings = unlinedSiblings(doc, label, c.pathId)
                name = circuitNameOf([voltageLabel(c.voltage ?? c.energizedVoltage), label, `S${sequenceAmong('circuits', siblings, c, renamed)}`])
            }
            return {id: TransmissionCircuit.defaultId({name}), name}
        }
        case 'lines': {
            const l = doc.lines.find(r => r.id === id)
            if (!l) return undefined
            const siblings = l.from && l.to ? doc.lines.filter(x => samePair(x, l.from, l.to)) : [l]
            const hints = {from: endpointToken(doc, l.from, 'site'), to: endpointToken(doc, l.to, 'site'), voltage: l.voltage, sequence: sequenceAmong('lines', siblings, l, renamed)}
            const name = TransmissionLine.defaultName(hints) || l.name
            return {id: TransmissionLine.defaultId({name}), name}
        }
        default:
            return undefined
    }
}

export interface RegenerateTarget {
    collection: NetworkCollectionName
    id: string
}

export interface RegenerateChange extends RegenerateTarget {
    newId?: string
    oldName?: string
    newName?: string
}

export interface RegeneratePlan {
    /** Ops to apply, in order (name upserts and `renameRecordOps` per record). */
    ops: NetworkOp[]
    /** What changes per record; records already matching the rules are left out. */
    changes: RegenerateChange[]
    /** Targets that were skipped: not regenerable or missing. */
    skipped: RegenerateTarget[]
}

/** `base`, or `base_2`, `base_3`, … : the first one not in `used` (the suffixes `uniqueId` uses). */
function firstFreeId(base: string, used: Set<string>): string {
    if (!used.has(base)) return base
    for (let n = 2; ; n++) if (!used.has(`${base}_${n}`)) return `${base}_${n}`
}

/**
 * Ops that re-derive the id and / or name of the given records from the
 * model rules. Names and ids are computed up front from the document as it
 * is (so parallel records keep distinct sequence numbers). A record gets its
 * rule id unless a record that keeps its id (or an earlier target) already has
 * it, then the usual `_2` suffix. Records that trade ids with each other (L1
 * and L2 swapping) do not clash: a target whose current id another target is
 * about to take first moves to a temporary id. Every reference follows the
 * renames.
 */
export function regenerateNamingOps(doc: NetworkDocument, targets: RegenerateTarget[], what: { id?: boolean; name?: boolean }): RegeneratePlan {
    const renamed = new Set(targets.map(t => t.id))
    const namingFor = (d: NetworkDocument, t: RegenerateTarget) => REGENERABLE_COLLECTIONS.includes(t.collection) ? defaultNamingFor(d, t.collection, t.id, renamed) : undefined
    // Circuit names contain line and path names: circuits are named after those got their new names (below).
    const planned = targets.map(t => ({t, naming: t.collection === 'circuits' ? undefined : namingFor(doc, t)}))
    const ops: NetworkOp[] = []
    const changes = new Map<string, RegenerateChange>()
    const skipped: RegenerateTarget[] = []
    let current = doc
    const push = (next: NetworkOp[]) => {
        ops.push(...next)
        current = applyOps(current, next)
    }
    const changeOf = (t: RegenerateTarget) => changes.get(t.id) ?? changes.set(t.id, {collection: t.collection, id: t.id}).get(t.id)!

    // Names (the record keeps its id meanwhile): the others first, then the circuits, all named from one state.
    const applyName = ({t, naming}: { t: RegenerateTarget; naming?: Naming }) => {
        if (!naming) {
            skipped.push(t)
            return
        }
        if (!what.name || !NAMED_BY_RULES.includes(t.collection)) return
        const rec = (current[t.collection] as AnyNetworkRecord[]).find(r => r.id === t.id) as (AnyNetworkRecord & { name?: string }) | undefined
        if (rec && naming.name && naming.name !== rec.name) {
            push([{type: 'upsert', collection: t.collection, record: {...rec, name: naming.name}}])
            Object.assign(changeOf(t), {oldName: rec.name, newName: naming.name})
        }
    }
    planned.filter(p => p.t.collection !== 'circuits').forEach(applyName)
    const othersNamed = current
    for (const p of planned) if (p.t.collection === 'circuits') p.naming = namingFor(othersNamed, p.t)
    planned.filter(p => p.t.collection === 'circuits').forEach(applyName)

    if (what.id) {
        // Final ids, decided up front: ids of records that keep theirs are taken, and so is each id handed out.
        const moving = planned.filter(p => p.naming && p.naming.id !== p.t.id)
        const movingIds = new Set(moving.map(p => p.t.id))
        const taken = new Set<string>()
        for (const c of networkCollectionNames) for (const r of doc[c] as AnyNetworkRecord[]) if (!movingIds.has(r.id)) taken.add(r.id)
        const renames: { t: RegenerateTarget; to: string }[] = []
        for (const p of moving) {
            const to = firstFreeId(p.naming!.id, taken)
            taken.add(to)
            if (to !== p.t.id) renames.push({t: p.t, to})
        }
        // A target whose current id another target takes moves aside first, to an id nobody has or gets.
        const finals = new Set(renames.map(r => r.to))
        const used = new Set([...taken, ...movingIds])
        const at = new Map(renames.map(r => [r.t.id, r.t.id]))
        for (const r of renames) {
            if (!finals.has(r.t.id)) continue
            const tmp = firstFreeId('regen_tmp', used)
            used.add(tmp)
            push(renameRecordOps(current, r.t.collection, r.t.id, tmp))
            at.set(r.t.id, tmp)
        }
        for (const r of renames) {
            push(renameRecordOps(current, r.t.collection, at.get(r.t.id)!, r.to))
            changeOf(r.t).newId = r.to
        }
    }
    // In target order (document order for the lists).
    const ordered = targets.map(t => changes.get(t.id)).filter((c): c is RegenerateChange => !!c && (!!c.newId || c.newName !== undefined))
    return {ops, changes: ordered, skipped}
}
