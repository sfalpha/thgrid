/**
 * The synthetic network the tests run on (see docs/testing.md, "Fixture"): small, valid, with one site or junction per
 * role so each case reads as "from <role> to <role>"; and a busy area whose sites, site junction and line junctions
 * already carry lines from de-energized to 500 kV, with lines between two quiet sites to route through it.
 */
import {TransmissionVoltage as V} from '@shared/models/transmission.voltage'
import {TransmissionConductor, TransmissionWireType, TransmissionWireUnit} from '@shared/models/transmission.conductor'
import {applyOps} from '@shared/network/ops'
import {
    NetworkDocument,
    newNetworkDocument,
    SubstationGroupRecord,
    SubstationRecord,
    SubstationTakeOffRecord,
    TransmissionJunctionRecord,
} from '@shared/network/records'
import {buildNewLinePlan, NewLineLegSpec, NewLineVia} from '../src/network/lineWizard'

export const siteId = (code: string) => `SSG_${code}`
export const yardId = (code: string, kv: string) => `SSY_${code}_${kv}`
export const junctionId = (name: string) => `TJT_${name}`
/** Line wizard end keys: a yard, a site's junction, a line junction. */
export const Y = (code: string, kv: string) => `Y:${yardId(code, kv)}`
export const G = (code: string) => `G:${siteId(code)}`
export const J = (name: string) => `J:${junctionId(name)}`

/**
 * Sites (code: yards) and their role:
 * - SA: 230 kV — FROM end, new take-off (no free take-offs);
 * - SF: 230 kV — FROM end, existing take-off: free take-offs toward SB, SG, SS and J2;
 * - ST: 230 kV and its site junction (exists) — FROM end at a site junction;
 * - SB: 230 kV — TO end, new take-off;
 * - SG: 230 kV — TO end, existing take-off: free take-offs toward SA, SF, ST and J1;
 * - SS: 230 kV, no site junction yet — TO end at a site junction (created);
 * - SC, SD: 115 kV only — yards below a 230 kV conductor;
 * - SH: 230 kV and 115 kV — a site with a yard at either voltage;
 * - SE: 230 kV only — a site without a 115 kV yard (an auxiliary 115 kV line);
 * - SV: 230 kV, no site junction yet — passed in between (its site junction is created).
 * Line junctions: J1 (a FROM end), J2 (a TO end), J3, J4 (passed in between).
 */
export function lineFixture(): NetworkDocument {
    cached ??= busyArea(baseFixture())
    return structuredClone(cached)
}

let cached: NetworkDocument | undefined

function baseFixture(): NetworkDocument {
    const doc = newNetworkDocument('fixture', 'Line creation fixture', '2026-01-01T00:00:00.000Z')
    const site = (code: string, lat: number, lon: number, yards: [string, V][]) => {
        const g: SubstationGroupRecord = {id: siteId(code), groupName: code, coords: {latitude: lat, longitude: lon}}
        doc.substationGroups.push(g)
        for (const [kv, voltage] of yards) {
            const y: SubstationRecord = {id: yardId(code, kv), groupId: g.id, yardName: kv, voltage}
            doc.substations.push(y)
        }
    }
    site('SA', 13.0, 100.0, [['230KV', V.AC230KV]])
    site('SF', 13.0, 100.2, [['230KV', V.AC230KV]])
    site('ST', 13.0, 100.4, [['230KV', V.AC230KV]])
    site('SB', 13.6, 100.0, [['230KV', V.AC230KV]])
    site('SG', 13.6, 100.2, [['230KV', V.AC230KV]])
    site('SS', 13.6, 100.4, [['230KV', V.AC230KV]])
    site('SC', 14.0, 100.0, [['115KV', V.AC115KV]])
    site('SD', 14.6, 100.0, [['115KV', V.AC115KV]])
    site('SH', 14.0, 100.4, [['230KV', V.AC230KV], ['115KV', V.AC115KV]])
    site('SE', 14.6, 100.4, [['230KV', V.AC230KV]])
    site('SV', 13.3, 100.6, [['230KV', V.AC230KV]])
    const junction = (name: string, lat: number, lon: number, groupId?: string): TransmissionJunctionRecord => {
        const j: TransmissionJunctionRecord = {id: junctionId(name), name, coords: {latitude: lat, longitude: lon}, ...(groupId ? {groupId} : {})}
        doc.junctions.push(j)
        return j
    }
    junction('ST', 13.0, 100.4, siteId('ST'))   // the site junction of ST
    junction('J1', 13.0, 100.6)
    junction('J2', 13.6, 100.6)
    junction('J3', 13.3, 100.1)
    junction('J4', 13.3, 100.3)
    const takeOff = (code: string, kv: string, lineName: string) => {
        const t: SubstationTakeOffRecord = {id: `STO_${code}_${kv}_${lineName}`, name: lineName, substationId: yardId(code, kv), lineName, takeOffColumn: true}
        doc.takeOffs.push(t)
    }
    for (const toward of ['SB', 'SG', 'SS', 'J2']) takeOff('SF', '230KV', `230KV_${toward}_L1`)
    for (const toward of ['SA', 'SF', 'ST', 'J1']) takeOff('SG', '230KV', `230KV_${toward}_L1`)
    return doc
}

/* ---------- the busy area ---------- */

/** A conductor per rated voltage, as EGAT strings them (the wizard copies it onto each section). */
const CONDUCTOR: Partial<Record<V, { bundle: number; conductor: TransmissionConductor }>> = {
    [V.AC500KV]: {bundle: 4, conductor: {size: 1272, unit: TransmissionWireUnit.MCM, type: TransmissionWireType.ACSR_GA}},
    [V.AC230KV]: {bundle: 2, conductor: {size: 1272, unit: TransmissionWireUnit.MCM, type: TransmissionWireType.ACSR_GA}},
    [V.AC115KV]: {bundle: 1, conductor: {size: 795, unit: TransmissionWireUnit.MCM, type: TransmissionWireType.ACSR_GA}},
}

/** A line of the busy area: its ends and stops (wizard keys), conductor rating, energized voltage when not the yards'. */
interface BusyLine {
    from: string
    to: string
    vias?: NewLineVia[]
    rated: V
    energized?: V
    /** `true`: on a path of its own; a line name: on that line's path (when the wizard would not pick it). */
    path?: true | string
}

/**
 * The lines the busy area starts with, in creation order, made by the line wizard as the editor would (names, take-offs,
 * nodes and voltages by its rules); see docs/testing.md, "Busy area". At the places:
 * - MA (500 / 230 / 115 kV yards): 500 kV to MB; 230 kV twice via JP and a de-energized one to MC; 115 kV and a 230 kV-rated
 *   one at 115 kV to MD; 230 kV to ME through the site junction of MS;
 * - MB (500 kV): to MA, and to ME via JX;  MC (230 kV): the three from MA;  ME (500 / 230 kV): from MB, MS, MA, and to JX;
 * - MD (115 kV): the two from MA, open-ended lines to JQ, JX (230 kV-rated) and the site junction of MS;
 * - MS (230 / 115 kV, site junction MS): 230 kV to ME via JQ; its junction splices MA-ME (230 kV), ends the 115 kV line
 *   from MD and the de-energized one from JX;
 * - JP: two 230 kV splices (one voltage);  JQ: a 230 kV splice and a 115 kV open end (two);
 *   JX: a 500 kV splice, open ends at 230 kV, 115 kV (230 kV-rated) and 0 V (four).
 * Between QA and QB (500 / 230 / 115 kV yards each, nothing else around): one line per kind to route through the area,
 * 500, 230, 115 kV, 230 kV-rated at 115 kV (on the path of the 115 kV one) and 230 kV-rated de-energized (on the path
 * of the 230 kV one).
 */
export const BUSY_LINES: BusyLine[] = [
    {from: Y('MA', '500KV'), to: Y('MB', '500KV'), rated: V.AC500KV},
    {from: Y('MB', '500KV'), to: Y('ME', '500KV'), vias: [{junctionId: junctionId('JX')}], rated: V.AC500KV},
    {from: Y('MA', '230KV'), to: Y('MC', '230KV'), vias: [{junctionId: junctionId('JP')}], rated: V.AC230KV},
    {from: Y('MA', '230KV'), to: Y('MC', '230KV'), vias: [{junctionId: junctionId('JP')}], rated: V.AC230KV},
    {from: Y('MA', '230KV'), to: Y('MC', '230KV'), rated: V.AC230KV, energized: V.DE_ENERGIZED},
    {from: Y('MA', '115KV'), to: Y('MD', '115KV'), rated: V.AC115KV},
    {from: Y('MA', '115KV'), to: Y('MD', '115KV'), rated: V.AC230KV},
    {from: Y('MS', '230KV'), to: Y('ME', '230KV'), vias: [{junctionId: junctionId('JQ')}], rated: V.AC230KV},
    {from: Y('MD', '115KV'), to: J('JQ'), rated: V.AC115KV},
    {from: Y('MD', '115KV'), to: J('JX'), rated: V.AC230KV},
    {from: Y('ME', '230KV'), to: J('JX'), rated: V.AC230KV, path: true},
    {from: J('JX'), to: G('MS'), rated: V.AC230KV},
    {from: Y('MA', '230KV'), to: Y('ME', '230KV'), vias: [{groupId: siteId('MS')}], rated: V.AC230KV},
    {from: Y('MD', '115KV'), to: G('MS'), rated: V.AC115KV},
    {from: Y('QA', '500KV'), to: Y('QB', '500KV'), rated: V.AC500KV},
    {from: Y('QA', '230KV'), to: Y('QB', '230KV'), rated: V.AC230KV, path: true},
    {from: Y('QA', '115KV'), to: Y('QB', '115KV'), rated: V.AC115KV, path: true},
    {from: Y('QA', '115KV'), to: Y('QB', '115KV'), rated: V.AC230KV},
    {from: Y('QA', '230KV'), to: Y('QB', '230KV'), rated: V.AC230KV, energized: V.DE_ENERGIZED, path: '230KV_QA_QB_L1'},
]

/** The quiet lines between QA and QB, by kind: what the route cases move. */
export const QUIET = {
    q500: '500KV_QA_QB_L1',
    q230: '230KV_QA_QB_L1',
    q115: '115KV_QA_QB_L1',
    /** 230 kV-rated, energized at 115 kV. */
    q230at115: '230KV_QA_QB_L2',
    /** 230 kV-rated, de-energized (0 V). */
    q0: '230KV_QA_QB_L3',
} as const

function busyArea(doc: NetworkDocument): NetworkDocument {
    const site = (code: string, lat: number, lon: number, yards: [string, V][]) => {
        doc.substationGroups.push({id: siteId(code), groupName: code, coords: {latitude: lat, longitude: lon}})
        for (const [kv, voltage] of yards) doc.substations.push({id: yardId(code, kv), groupId: siteId(code), yardName: kv, voltage})
    }
    const all: [string, V][] = [['500KV', V.AC500KV], ['230KV', V.AC230KV], ['115KV', V.AC115KV]]
    site('MA', 13.0, 101.0, all)
    site('MB', 13.0, 101.4, [['500KV', V.AC500KV]])
    site('MC', 13.6, 101.4, [['230KV', V.AC230KV]])
    site('MS', 13.6, 101.0, [['230KV', V.AC230KV], ['115KV', V.AC115KV]])
    site('MD', 14.2, 101.0, [['115KV', V.AC115KV]])
    site('ME', 14.2, 101.6, [['500KV', V.AC500KV], ['230KV', V.AC230KV]])
    site('QA', 13.0, 102.0, all)
    site('QB', 14.6, 102.0, all)
    for (const [name, lat, lon] of [['JP', 13.3, 101.2], ['JQ', 13.9, 101.3], ['JX', 14.2, 101.3]] as const) {
        doc.junctions.push({id: junctionId(name), name, coords: {latitude: lat, longitude: lon}})
    }
    let out = doc
    for (const l of BUSY_LINES) {
        const shareWith = typeof l.path === 'string' ? out.lines.find(x => x.name === l.path) : undefined
        const sharedPath = shareWith && out.circuits.find(c => c.id === shareWith.circuitIds[0])?.pathId
        const legs: NewLineLegSpec[] | undefined = l.path === true ? [{createPath: true}] : sharedPath ? [{pathId: sharedPath}] : undefined
        const plan = buildNewLinePlan(out, {from: l.from, to: l.to, vias: l.vias, circuits: 1, voltage: l.rated, energizedVoltage: l.energized, legs, ...CONDUCTOR[l.rated]})
        if (plan.errors.length) throw new Error(`fixture line ${l.from} → ${l.to}: ${plan.errors.join('; ')}`)
        out = applyOps(out, plan.ops)
    }
    return out
}
