/**
 * A new path between two places (the "New path" panel): a route without circuits. Its ends are path ends (a site
 * junction stands for its site), its rule name `<from>-<to>` (numbered when paths already run between the places),
 * and the paths already between them are listed (a new one is a duplicate unless it gets its own waypoints).
 * Refused: an end missing, both ends the same place, a typed id that is invalid or in use. A path is not voltage
 * specific: circuits of any voltage, energized or not, may share it. Pure.
 */
import {ConnectionJunctionRef, NetworkDocument, TransmissionPathRecord} from '@shared/network/records'
import {checkCreateId, pickId} from '@shared/network/ops'
import {Naming, pathNaming} from '@shared/network/naming'
import {pathEndOf} from '@shared/network/refs'
import {haversineKm, locationOfRef} from './mapUtil'
import {pathsBetween, samePlace} from './routeVia'

export interface NewPathPlan {
    /** The ends as path ends. */
    from?: ConnectionJunctionRef
    to?: ConnectionJunctionRef
    /** Both ends are the same place (a site and its junction count as one). */
    same: boolean
    /** The rule id / name (no typed name), when both ends are set and differ. */
    auto?: Naming
    /** Paths already running between the two places, either way. */
    existing: TransmissionPathRecord[]
    /** Straight-line distance between the ends. */
    km?: number
    /** The path to create, when nothing is refused. */
    record?: TransmissionPathRecord
    errors: string[]
}

export function buildNewPathPlan(doc: NetworkDocument, fromEnd: ConnectionJunctionRef | undefined, toEnd: ConnectionJunctionRef | undefined, opts: { name?: string; id?: string } = {}): NewPathPlan {
    const asPathEnd = (r?: ConnectionJunctionRef) => r && (pathEndOf(doc, r) ?? r)
    const from = asPathEnd(fromEnd), to = asPathEnd(toEnd)
    const same = !!from && !!to && samePlace(doc, from, to)
    const auto = from && to && !same ? pathNaming(doc, from, to) : undefined
    const existing = auto ? pathsBetween(doc, from, to) : []
    const a = locationOfRef(doc, from), b = locationOfRef(doc, to)
    const km = a && b && !same ? haversineKm(a.coords, b.coords) : undefined
    const errors: string[] = []
    if (!from || !to) errors.push('pick both ends')
    else if (same) errors.push('both ends are the same place')
    const typedId = opts.id?.trim()
    const idProblem = typedId ? checkCreateId(doc, typedId) : undefined
    if (idProblem) errors.push(idProblem)
    let record: TransmissionPathRecord | undefined
    if (!errors.length && from && to) {
        const naming = pathNaming(doc, from, to, opts.name)
        record = {id: pickId(doc, opts.id, naming.id), name: naming.name, from, to, waypoints: []}
    }
    return {from, to, same, auto, existing, km, record, errors}
}
