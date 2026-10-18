/**
 * A part of a network around one site: the site, the lines connected to it, and the sites and junctions those lines
 * reach, as a document of its own (e.g. the sample grid, taken from the EGAT network by `npm run sample:grid`).
 */
import {
    ConnectionJunctionRef,
    ConnectionRecord,
    ConnectionScope,
    NetworkDocument,
    NetworkNodeKind,
    TransmissionCircuitRecord,
} from "./records";
import {siteOfRef} from "./refs";

export interface ExtractResult {
    doc: NetworkDocument
    /** Sites by their distance in lines from the centre (0: the centre). */
    sitesByHop: string[][]
}

/**
 * The part of `doc` within `hops` lines of the site `groupId`: every circuit with an end at a site closer than `hops`
 * (at one of its yards or at its site junction) and every line through such a circuit (with all its sections); the
 * sites, yards and line junctions those circuits and their paths reach. The sites keep their yards, buses, bays,
 * equipment, generation units and in-yard wiring, and their site junction when an included circuit ends there;
 * take-offs are kept where an included circuit leaves through them or the in-yard wiring uses them, and every take-off
 * of the sites closer than `hops`. Connections at line junctions keep
 * only the included circuit ends (a node left without any goes); an extension whose parent is left out is a site of its
 * own. The document keeps the id, name and description of `doc` (the caller sets its own).
 */
export function extractAround(doc: NetworkDocument, groupId: string, hops: number): ExtractResult {
    const placeOf = (ref?: ConnectionJunctionRef) => ref ? siteOfRef(doc, ref) ?? `J:${ref.id}` : undefined
    const circuitEnds = (c: ConnectionRecord) => c.nodes.filter(n => n.kind === NetworkNodeKind.TRANSMISSION_CIRCUIT)

    // every circuit's places: the sites (or free junctions, `J:<id>`) its ends are connected at and its path ends at
    const pathOf = new Map(doc.paths.map(p => [p.id, p]))
    const placesOf = new Map<string, Set<string>>()
    const addPlace = (circuitId: string, place?: string) => {
        if (!place) return
        const at = placesOf.get(circuitId) ?? placesOf.set(circuitId, new Set()).get(circuitId)!
        at.add(place)
    }
    for (const conn of doc.connections) {
        if (conn.scope !== ConnectionScope.TRANSMISSION) continue
        for (const n of circuitEnds(conn)) addPlace(n.id, placeOf(conn.junction))
    }
    for (const c of doc.circuits) {
        const path = c.pathId ? pathOf.get(c.pathId) : undefined
        addPlace(c.id, placeOf(path?.from))
        addPlace(c.id, placeOf(path?.to))
    }
    const linesOf = (circuitId: string) => doc.lines.filter(l => l.circuitIds.includes(circuitId))

    // ring by ring: the circuits connected at the sites reached so far, their whole lines, the places those reach
    const sitesByHop: string[][] = [[groupId]]
    const sites = new Set([groupId])
    const circuits = new Set<string>()
    const junctions = new Set<string>()
    for (let hop = 1; hop <= hops; hop++) {
        const inner = new Set(sites)
        const here = doc.circuits.filter(c => [...placesOf.get(c.id) ?? []].some(p => inner.has(p)))
        for (const c of here) for (const id of [c.id, ...linesOf(c.id).flatMap(l => l.circuitIds)]) circuits.add(id)
        const reached: string[] = []
        for (const id of circuits) for (const p of placesOf.get(id) ?? []) {
            if (p.startsWith('J:')) junctions.add(p.slice(2))
            else if (!sites.has(p)) {
                sites.add(p)
                reached.push(p)
            }
        }
        sitesByHop.push(reached.sort())
    }
    /** The sites whose every circuit is included: closer than `hops`. */
    const inner = new Set(sitesByHop.slice(0, hops).flat())

    const yards = new Set(doc.substations.filter(y => sites.has(y.groupId)).map(y => y.id))
    const inYards = <R extends { substationId: string }>(list: R[]) => list.filter(r => yards.has(r.substationId))

    // connections: in-yard wiring of the kept yards; on the lines, the included circuit ends (and the take-off they leave by)
    const connections: ConnectionRecord[] = []
    for (const conn of doc.connections) {
        if (conn.scope === ConnectionScope.SUBSTATION) {
            if (yards.has(conn.junction.id)) connections.push(conn)
            continue
        }
        const ends = circuitEnds(conn).filter(n => circuits.has(n.id))
        if (!ends.length) continue
        connections.push({...conn, nodes: conn.nodes.filter(n => n.kind !== NetworkNodeKind.TRANSMISSION_CIRCUIT || circuits.has(n.id))})
    }
    const usedTakeOffs = new Set([
        ...connections.flatMap(c => c.nodes.filter(n => n.kind === NetworkNodeKind.SUBSTATION_TAKE_OFF).map(n => n.id)),
        ...doc.equipments.filter(e => yards.has(e.substationId) && e.takeOffId).map(e => e.takeOffId!),
        ...(doc.yardConnections ?? []).flatMap(l => l.nodes.filter(n => n.kind === NetworkNodeKind.SUBSTATION_TAKE_OFF).map(n => n.id)),
    ])
    // a site's junction only with an included circuit end at it (the free junctions the circuits reach are kept above)
    const keptJunctions = new Set([...junctions, ...connections.filter(c => c.scope === ConnectionScope.TRANSMISSION).map(c => c.junction.id)
        .filter(id => doc.junctions.some(j => j.id === id && j.groupId && sites.has(j.groupId)))])
    const innerYards = new Set(doc.substations.filter(y => inner.has(y.groupId)).map(y => y.id))
    const keptCircuits: TransmissionCircuitRecord[] = doc.circuits.filter(c => circuits.has(c.id))
    const keptPaths = new Set(keptCircuits.map(c => c.pathId).filter((id): id is string => !!id))

    const out: NetworkDocument = {
        ...doc,
        substationGroups: doc.substationGroups.filter(g => sites.has(g.id)).map(g => {
            if (!g.extensionOf || sites.has(g.extensionOf)) return g
            const {extensionOf: _, ...own} = g
            return own
        }),
        generationUnits: (doc.generationUnits ?? []).filter(u => sites.has(u.groupId)),
        substations: doc.substations.filter(y => yards.has(y.id)),
        buses: inYards(doc.buses),
        bays: inYards(doc.bays),
        equipments: inYards(doc.equipments),
        takeOffs: inYards(doc.takeOffs).filter(t => innerYards.has(t.substationId) || usedTakeOffs.has(t.id)),
        junctions: doc.junctions.filter(j => keptJunctions.has(j.id)),
        paths: doc.paths.filter(p => keptPaths.has(p.id)),
        circuits: keptCircuits,
        lines: doc.lines.filter(l => l.circuitIds.length > 0 && l.circuitIds.every(id => circuits.has(id))),
        connections,
        yardConnections: (doc.yardConnections ?? []).filter(l => yards.has(l.yardAId) && yards.has(l.yardBId)),
    }
    return {doc: out, sitesByHop}
}
