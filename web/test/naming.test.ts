/**
 * Naming of new junctions (docs/testing.md section 4): after the site closest to where they are placed, `<site>_J<n>`,
 * `J<n>` when the network has no site; how place lists show junctions (name first, sorted with the sites); and take-off
 * line names, which carry their yard's voltage.
 */
import {TransmissionVoltage as V} from '@shared/models/transmission.voltage'
import {closestSite, defaultNamingFor, junctionNaming} from '@shared/network/naming'
import {takeOffVoltage} from '@shared/network/migrate'
import {newNetworkDocument, TransmissionJunctionRecord} from '@shared/network/records'
import {newSiteJunctionRecord} from '@shared/network/siteJunction'
import {applyOps} from '@shared/network/ops'
import {buildSplitPathPlan} from '../src/network/splitPath'
import {buildNewCircuitPlan, circuitPlaceOptions} from '../src/network/circuitWizard'
import {buildNewLinePlan} from '../src/network/lineWizard'
import {test} from './harness'
import {lineFixture, siteId, yardId} from './fixture'

const nearMA = {latitude: 13.05, longitude: 101.02}
const nearME = {latitude: 14.15, longitude: 101.62}
const junction = (id: string, name: string): TransmissionJunctionRecord => ({id, name, coords: {...nearMA}})

test('JN-1', 'no site in the network: J<n>, id TJT_J<n>, the next number free', t => {
    const doc = newNetworkDocument('empty', 'empty', '2026-01-01T00:00:00.000Z')
    const first = junctionNaming(doc, undefined, nearMA)
    t.eq(first.name, 'J1', 'the first junction')
    t.eq(first.id, 'TJT_J1', 'its id')
    doc.junctions.push(junction('TJT_J1', 'J1'))
    t.eq(junctionNaming(doc, undefined, nearMA).name, 'J2', 'the next one')
})
test('JN-2', 'named after the closest site, numbered per site', t => {
    const doc = lineFixture()
    t.eq(closestSite(doc, nearMA)?.groupName, 'MA', 'the closest site')
    const a = junctionNaming(doc, undefined, nearMA)
    t.eq(a.name, 'MA_J1', 'near MA')
    t.eq(a.id, 'TJT_MA_J1', 'its id')
    doc.junctions.push(junction(a.id, a.name))
    t.eq(junctionNaming(doc, undefined, nearMA).name, 'MA_J2', 'the next one near MA')
    t.eq(junctionNaming(doc, undefined, nearME).name, 'ME_J1', 'near ME: numbered for ME')
})
test('JN-3', 'a number whose id is taken is skipped; a typed name is kept', t => {
    const doc = lineFixture()
    doc.junctions.push(junction('TJT_MA_J1', 'renamed'))
    t.eq(junctionNaming(doc, undefined, nearMA).name, 'MA_J2', 'TJT_MA_J1 is in use')
    const typed = junctionNaming(doc, 'TAP_X', nearMA)
    t.check(typed.name === 'TAP_X' && typed.id === 'TJT_TAP_X', 'the typed name', typed)
    t.eq(junctionNaming(doc).name, 'J5', 'no position: J<n>, past the J1-J4 of the fixture')
})
test('JN-4', 'a site junction is named after its site', t => {
    const doc = lineFixture()
    const sv = doc.substationGroups.find(g => g.id === siteId('SV'))!
    const rec = newSiteJunctionRecord(doc, sv)
    t.check(rec.name === 'SV' && rec.id === 'TJT_SV' && rec.groupId === sv.id, 'SV', rec)
})
test('JN-5', 'splitting a path at a new junction names it after the site closest to the click', t => {
    const doc = lineFixture()
    const plan = buildSplitPathPlan(doc, 'TPA_MA_MB', {latitude: 13.0, longitude: 101.35})
    t.check(plan.errors.length === 0 && plan.junctionCreated, 'a junction is created', plan.errors)
    const after = applyOps(doc, plan.ops)
    const created = after.junctions.find(j => !doc.junctions.some(x => x.id === j.id))
    t.check(created?.name === 'MB_J1' && created.id === 'TJT_MB_J1', 'named after MB, the closest site', created)
})
test('JN-6', 'place lists: a junction reads name first and is sorted with the sites', t => {
    const options = circuitPlaceOptions(lineFixture())
    t.check(options.some(o => o.value === 'J:TJT_JX' && o.label === 'JX Junction'), 'JX Junction', options.filter(o => o.value.startsWith('J:')))
    t.check(!options.some(o => o.label.startsWith('Junction ')), 'no label starts with "Junction"')
    const labels = options.map(o => o.label)
    t.check(labels.every((l, i) => i === 0 || labels[i - 1].localeCompare(l) <= 0), 'sorted by label', labels)
})

/* ---------- take-off line names: the yard's voltage ---------- */

test('TN-1', 'Regenerate: a take-off line name takes its yard voltage, whatever its circuit runs at', t => {
    const doc = lineFixture()
    const sf = doc.takeOffs.find(x => x.id === 'STO_SF_230KV_230KV_SB_L1')!
    const renamed = applyOps(doc, [
        {type: 'upsert', collection: 'takeOffs', record: {...sf, lineName: '115KV_SB_L1'}},
        {type: 'upsert', collection: 'takeOffs', record: {id: 'STO_SC_115KV_X', name: 'X', substationId: yardId('SC', '115KV'), lineName: '230KV_SD_L1', takeOffColumn: true}},
    ])
    t.eq(defaultNamingFor(renamed, 'takeOffs', sf.id)?.lineName, '230KV_SB_L1', 'in the 230 kV yard of SF: 230KV_…')
    t.eq(defaultNamingFor(renamed, 'takeOffs', 'STO_SC_115KV_X')?.lineName, '115KV_SD_L1', 'in the 115 kV yard of SC: 115KV_…')
})
test('TN-2', 'the line wizard names an auxiliary take-off (circuit at 115 kV in a 230 kV yard) with the yard voltage, and the rule agrees', t => {
    const doc = lineFixture()
    const plan = buildNewLinePlan(doc, {from: `Y:${yardId('SE', '230KV')}`, to: `Y:${yardId('SC', '115KV')}`, circuits: 1, voltage: V.AC230KV, energizedVoltage: V.AC115KV})
    const after = applyOps(doc, plan.ops)
    const t0 = plan.circuits[0]?.fromTakeOff
    t.eq(t0?.lineName, '230KV_SC_L1', 'named 230KV_SC_L1')
    t.eq(t0 && takeOffVoltage(after, t0.id), V.AC115KV, 'its circuit at 115 kV')
    t.check(!!t0 && defaultNamingFor(after, 'takeOffs', t0.id)?.lineName === undefined, 'Regenerate leaves it as it is')
})
test('TN-3', 'the circuit wizard does the same', t => {
    const doc = lineFixture()
    const plan = buildNewCircuitPlan(doc, {from: {place: `G:${siteId('SE')}`, connect: {kind: 'newTakeOff', yardId: yardId('SE', '230KV')}}, to: {place: `G:${siteId('SC')}`}, voltage: V.AC230KV, bundle: 1, energizedVoltage: V.AC115KV})
    const after = applyOps(doc, plan.ops)
    const t0 = plan.from.takeOff
    t.eq(t0?.lineName, '230KV_SC_L1', 'named 230KV_SC_L1')
    t.eq(t0 && takeOffVoltage(after, t0.id), V.AC115KV, 'its circuit at 115 kV')
})
