/**
 * Lookup tables over the lists of a network document, so that finding a record by id, the connection holding a circuit
 * end or the circuits of a path needs no scan of the whole list.
 *
 * A table is built on first use and kept with its list (a WeakMap keyed by the array). A document is never changed
 * once made — every edit gives new lists (`applyOps`) — so a table stays right for as long as its list lives, and
 * documents sharing a list (a view of the network with some circuits left out, say) share its tables. Code that builds
 * a list must therefore not change it after it is part of a document.
 */
import {ConnectionRecord, ConnectionScope, NetworkDocument, NetworkNodeKind, SubstationGroupRecord, SubstationRecord, TransmissionCircuitRecord, TransmissionJunctionRecord, TransmissionLineRecord, TransmissionPathRecord} from "./records";

const tables = new WeakMap<readonly object[], Map<string, unknown>>()

/** The table `name` of a list, built by `build` the first time it is asked for. */
function table<L extends readonly object[], T>(list: L, name: string, build: (list: L) => T): T {
    let named = tables.get(list)
    if (!named) tables.set(list, named = new Map())
    if (!named.has(name)) named.set(name, build(list))
    return named.get(name) as T
}

const NONE: readonly never[] = Object.freeze([])

/** Records of a list under each of their keys (in list order; a record once per key). */
function grouped<R extends object>(list: readonly R[], name: string, keys: (r: R) => (string | undefined)[]): ReadonlyMap<string, readonly R[]> {
    return table(list, name, l => {
        const out = new Map<string, R[]>()
        for (const r of l) for (const key of new Set(keys(r))) {
            if (key === undefined) continue
            const at = out.get(key)
            if (at) at.push(r)
            else out.set(key, [r])
        }
        return out
    })
}

/** The record with this id (the first one, as `find` would give). */
export function recordById<R extends { id: string }>(list: readonly R[], id: string | undefined): R | undefined {
    if (id === undefined) return undefined
    return table(list, 'id', l => {
        const out = new Map<string, R>()
        for (const r of l) if (!out.has(r.id)) out.set(r.id, r)
        return out
    }).get(id)
}

/** The TRANSMISSION connection holding a circuit end (the first one, as a scan would find). */
export function connectionOfEnd(doc: NetworkDocument, circuitId: string, end: string | undefined): ConnectionRecord | undefined {
    return table(doc.connections, 'circuitEnd', l => {
        const out = new Map<string, ConnectionRecord>()
        for (const conn of l) {
            if (conn.scope !== ConnectionScope.TRANSMISSION) continue
            for (const n of conn.nodes) if (n.kind === NetworkNodeKind.TRANSMISSION_CIRCUIT && !out.has(`${n.id}:${n.terminal}`)) out.set(`${n.id}:${n.terminal}`, conn)
        }
        return out
    }).get(`${circuitId}:${end}`)
}

/** The connections (of any scope) holding a take-off. */
export const connectionsOfTakeOff = (doc: NetworkDocument, takeOffId: string): readonly ConnectionRecord[] =>
    grouped(doc.connections, 'takeOff', c => c.nodes.filter(n => n.kind === NetworkNodeKind.SUBSTATION_TAKE_OFF).map(n => n.id)).get(takeOffId) ?? NONE

/** The connections (of any scope) at a yard or junction, by its id. */
export const connectionsAt = (doc: NetworkDocument, placeId: string): readonly ConnectionRecord[] =>
    grouped(doc.connections, 'junction', c => [c.junction?.id]).get(placeId) ?? NONE

/** The yards of a site. */
export const yardsOfSite = (doc: NetworkDocument, groupId: string): readonly SubstationRecord[] =>
    grouped(doc.substations, 'groupId', s => [s.groupId]).get(groupId) ?? NONE

/** The site junctions of a site (normally one). */
export const junctionsOfSite = (doc: NetworkDocument, groupId: string): readonly TransmissionJunctionRecord[] =>
    grouped(doc.junctions, 'groupId', j => [j.groupId]).get(groupId) ?? NONE

/** The extensions of a site (`extensionOf`), in list order. */
export const extensionSites = (doc: NetworkDocument, groupId: string): readonly SubstationGroupRecord[] =>
    grouped(doc.substationGroups, 'extensionOf', g => [g.extensionOf]).get(groupId) ?? NONE

/** The circuits running on a path. */
export const circuitsOnPath = (doc: NetworkDocument, pathId: string): readonly TransmissionCircuitRecord[] =>
    grouped(doc.circuits, 'pathId', c => [c.pathId]).get(pathId) ?? NONE

/** The paths with an end naming this site, yard or junction (by id, whatever the kind of the reference). */
export const pathsEndingAt = (doc: NetworkDocument, placeId: string): readonly TransmissionPathRecord[] =>
    grouped(doc.paths, 'ends', p => [p.from?.id, p.to?.id]).get(placeId) ?? NONE

/** The lines a circuit is a section of. */
export const linesOfCircuit = (doc: NetworkDocument, circuitId: string): readonly TransmissionLineRecord[] =>
    grouped(doc.lines, 'circuitIds', l => l.circuitIds).get(circuitId) ?? NONE

/** The records of a yard (buses, bays, take-offs, ...), by its id. */
export const ofYard = <R extends { substationId: string }>(list: readonly R[], substationId: string): readonly R[] =>
    grouped(list, 'substationId', r => [r.substationId]).get(substationId) ?? NONE
