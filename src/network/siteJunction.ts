/**
 * The site junction: a substation site may own one transmission junction
 * (`TransmissionJunctionRecord.groupId`), a tap / splice point at the site
 * itself where circuits are joined or teed without entering a yard. It is an
 * ordinary junction otherwise (nodes, circuit ends, a stop of a line), named
 * after the site by default and located at the site: it moves with it.
 */
import {NetworkDocument, SubstationGroupRecord, TransmissionJunctionRecord} from "./records";
import {CoordinatesProps} from "../models/coordinates";
import {NetworkOp, uniqueId} from "./ops";
import {junctionNaming} from "./naming";

/** The junction a site owns, if it has one. */
export function siteJunctionOf(doc: NetworkDocument, groupId: string): TransmissionJunctionRecord | undefined {
    return doc.junctions.find(j => j.groupId === groupId)
}

/** A new site junction for `group`: id `TJT_<code>`, named after the site, at the site's position. */
export function newSiteJunctionRecord(doc: NetworkDocument, group: SubstationGroupRecord): TransmissionJunctionRecord {
    const naming = junctionNaming(doc, group.groupName)
    return {id: uniqueId(doc, naming.id), name: naming.name, coords: {...group.coords}, groupId: group.id}
}

/** Ops that move a site and, with it, its junction. */
export function moveSiteOps(doc: NetworkDocument, group: SubstationGroupRecord, coords: CoordinatesProps): NetworkOp[] {
    const ops: NetworkOp[] = [{type: 'upsert', collection: 'substationGroups', record: {...group, coords}}]
    const junction = siteJunctionOf(doc, group.id)
    if (junction) ops.push({type: 'upsert', collection: 'junctions', record: {...junction, coords: {...coords}}})
    return ops
}
