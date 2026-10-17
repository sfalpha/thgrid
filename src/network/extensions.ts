/**
 * Site extensions: a site may be an extension of another one
 * (`SubstationGroupRecord.extensionOf`), e.g. a power plant's switchyard
 * `BPK_T` next to the substation `BPK`. One level deep: a parent is not an
 * extension itself, and an extension has no extensions of its own.
 */
import {NetworkDocument, SubstationGroupRecord} from "./records";
import {NetworkOp} from "./ops";
import {extensionSites, recordById} from "./lookup";

/** The site a site extends, if any. */
export function parentSiteOf(doc: NetworkDocument, site: SubstationGroupRecord): SubstationGroupRecord | undefined {
    return recordById(doc.substationGroups, site.extensionOf)
}

/** The extensions of a site, by code. */
export function extensionsOf(doc: NetworkDocument, groupId: string): SubstationGroupRecord[] {
    return [...extensionSites(doc, groupId)].sort((a, b) => a.groupName.localeCompare(b.groupName))
}

/** Why `childId` cannot become an extension of `parentId` (undefined when it can). */
export function extensionLinkProblem(doc: NetworkDocument, childId: string, parentId: string): string | undefined {
    const child = doc.substationGroups.find(g => g.id === childId), parent = doc.substationGroups.find(g => g.id === parentId)
    if (!child || !parent) return 'the site no longer exists'
    if (child.id === parent.id) return 'a site cannot extend itself'
    if (parent.extensionOf) return `${parent.groupName} is an extension itself`
    if (extensionsOf(doc, child.id).length) return `${child.groupName} has extensions of its own`
    return undefined
}

/** Ops that make `childId` an extension of `parentId`, or (no parent) a site of its own again. */
export function setExtensionOfOps(doc: NetworkDocument, childId: string, parentId: string | undefined): NetworkOp[] {
    const child = doc.substationGroups.find(g => g.id === childId)
    if (!child) return []
    const {extensionOf: _, ...rest} = child
    return [{type: 'upsert', collection: 'substationGroups', record: parentId ? {...rest, extensionOf: parentId} : rest}]
}

const km = (a: SubstationGroupRecord, b: SubstationGroupRecord) => {
    const R = 6371, rad = Math.PI / 180
    const dLat = (b.coords.latitude - a.coords.latitude) * rad, dLon = (b.coords.longitude - a.coords.longitude) * rad
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.coords.latitude * rad) * Math.cos(b.coords.latitude * rad) * Math.sin(dLon / 2) ** 2
    return 2 * R * Math.asin(Math.sqrt(h))
}

/** How far (km) a site may lie from the site its code points at to be suggested as its extension. */
export const EXTENSION_SUGGEST_KM = 10

/**
 * The site a site's code suggests it extends: its code with the last `_` / `-`
 * part dropped, again and again (`BPK_C5` → `BPK`, `SB_S4` → `SB`), naming a
 * site that can be its parent and lies within `EXTENSION_SUGGEST_KM`.
 */
export function suggestedParentSite(doc: NetworkDocument, site: SubstationGroupRecord): { parent: SubstationGroupRecord; km: number } | undefined {
    let code = site.groupName
    for (let cut = code.search(/[_-][^_-]*$/); cut > 0; cut = code.search(/[_-][^_-]*$/)) {
        code = code.slice(0, cut)
        const parent = doc.substationGroups.find(g => g.groupName === code)
        if (!parent) continue
        const d = km(site, parent)
        return !extensionLinkProblem(doc, site.id, parent.id) && d <= EXTENSION_SUGGEST_KM ? {parent, km: d} : undefined
    }
    return undefined
}
