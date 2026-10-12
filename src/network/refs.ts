/**
 * Helpers for the places a transmission record points at.
 *
 * Two kinds of place references live in a document:
 *  - a *connection* sits at a yard (`SUBSTATION`, the yard id) or at a line
 *    junction (`TRANSMISSION_JUNCTION`); lines run between yards too;
 *  - a *path* starts and ends at a site (`SUBSTATION_GROUP`, the group id)
 *    or at a junction: a route is not specific to a voltage, so circuits
 *    of any yard of the site may share it.
 * A circuit end connected at a yard is therefore "at" a path end that names
 * the yard's site; the helpers below do that comparison in one place.
 */
import {ConnectionJunctionKind, ConnectionJunctionRef, NetworkDocument} from "./records";

export const siteRef = (groupId: string): ConnectionJunctionRef => ({kind: ConnectionJunctionKind.SUBSTATION_GROUP, id: groupId})
export const yardRef = (substationId: string): ConnectionJunctionRef => ({kind: ConnectionJunctionKind.SUBSTATION, id: substationId})
export const junctionRef = (junctionId: string): ConnectionJunctionRef => ({kind: ConnectionJunctionKind.TRANSMISSION_JUNCTION, id: junctionId})

/** Same kind and id. */
export function sameRef(a?: ConnectionJunctionRef, b?: ConnectionJunctionRef): boolean {
    return !!a && !!b && a.kind === b.kind && a.id === b.id
}

/**
 * The site a reference belongs to: the group itself, the yard's group, or
 * the site a *site junction* belongs to; undefined for a free junction or an
 * unknown yard / junction.
 */
export function siteOfRef(doc: NetworkDocument, ref?: ConnectionJunctionRef): string | undefined {
    if (!ref) return undefined
    if (ref.kind === ConnectionJunctionKind.SUBSTATION_GROUP) return ref.id
    if (ref.kind === ConnectionJunctionKind.SUBSTATION) return doc.substations.find(s => s.id === ref.id)?.groupId
    return doc.junctions.find(j => j.id === ref.id)?.groupId
}

/**
 * The path end a connection place maps to: a yard becomes its site, a site
 * junction becomes its site too, a free junction (or a site) stays as it is.
 * Undefined for an unknown yard.
 */
export function pathEndOf(doc: NetworkDocument, ref?: ConnectionJunctionRef): ConnectionJunctionRef | undefined {
    if (!ref) return undefined
    if (ref.kind === ConnectionJunctionKind.SUBSTATION_GROUP) return ref
    const groupId = siteOfRef(doc, ref)
    if (groupId) return siteRef(groupId)
    return ref.kind === ConnectionJunctionKind.SUBSTATION ? undefined : ref
}

/**
 * True when a place (a connection's junction, a yard, a site or a junction)
 * lies at the given path end: the same junction, or a yard or the site
 * junction of the site the path end names. A legacy path end naming a yard
 * matches that yard only.
 */
export function atPathEnd(doc: NetworkDocument, place?: ConnectionJunctionRef, pathEnd?: ConnectionJunctionRef): boolean {
    if (!place || !pathEnd) return false
    if (sameRef(place, pathEnd)) return true
    if (pathEnd.kind !== ConnectionJunctionKind.SUBSTATION_GROUP) return false
    return siteOfRef(doc, place) === pathEnd.id
}
