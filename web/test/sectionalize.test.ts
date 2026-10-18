/**
 * Sectionalizing lines at a junction (docs/testing.md section 6, `buildSectionalizePlan`): a line through the junction is
 * cut there and both sides run to a site (into the yard at its energized voltage through new take-offs, the line split
 * there; a site without such a yard: spliced at its site junction, warned) or to a junction (spliced, the line keeps
 * running), on one path between the two.
 */
import {TransmissionVoltage as V} from '@shared/models/transmission.voltage'
import {haversineKm} from '@shared/models/coordinates'
import {applyOps} from '@shared/network/ops'
import {lineStatus} from '@shared/network/lines'
import {circuitEndConnection} from '@shared/network/migrate'
import {CIRCUIT_END_FROM, CIRCUIT_END_TO, ConnectionJunctionKind, NetworkDocument, NetworkNodeKind, TransmissionLineRecord} from '@shared/network/records'
import {passThroughs} from '../src/network/bypassJunction'
import {buildSectionalizePlan, SectionalizePlan, SectionTarget} from '../src/network/sectionalize'
import {buildRouteViaPlan} from '../src/network/routeVia'
import {Checker, test} from './harness'
import {junctionId, lineFixture, siteId, yardId} from './fixture'
import {checkNewNode, checkNewTakeOff, circuitNodes, lineNamed, namesUnique, newConnections, validates} from './verify'

const JP = junctionId('JP'), JX = junctionId('JX'), JQ = junctionId('JQ')
const MS = siteId('MS')

/** The pass-through at the junction of `line` (a line name), or holding the circuit with that id. */
const through = (doc: NetworkDocument, junction: string, line: string) => passThroughs(doc, junction).find(i => i.lines.some(l => l.name === line) || i.circuits.some(c => c.id === line))!

/** Runs the plan for the lines and checks it went through: the result validates, names stay unique. */
function sectionalize(t: Checker, doc: NetworkDocument, junction: string, lineNames: string[], target: SectionTarget, opts: { pathId?: string } = {}): { plan: SectionalizePlan; after: NetworkDocument } {
    const plan = buildSectionalizePlan(doc, junction, lineNames.map(n => through(doc, junction, n).key), target, opts)
    t.eq(plan.errors.join('; '), '', 'no errors')
    const after = applyOps(doc, plan.ops)
    validates(t, after)
    namesUnique(t, after)
    return {plan, after}
}

function contiguous(t: Checker, doc: NetworkDocument, line: TransmissionLineRecord) {
    const st = lineStatus(doc, doc.lines.find(l => l.id === line.id)!)
    t.check(!st.missing.length && !st.notContiguous && !st.fromMismatch && !st.toMismatch, `${line.name} is contiguous, FROM → TO`, st)
}

test('SC-1', 'a 230 kV line through JP into site MS: the 230 kV yard, a take-off toward each far end, the line split there', t => {
    const doc = lineFixture()
    const item = through(doc, JP, '230KV_MA_MC_L1')
    const [maSide, mcSide] = item.circuits[0].name.includes('MA-JP') ? item.circuits : [item.circuits[1], item.circuits[0]]
    const {plan, after} = sectionalize(t, doc, JP, ['230KV_MA_MC_L1'], {kind: 'site', groupId: MS})
    t.eq(plan.warnings.length, 0, 'no warnings')
    t.check(plan.pathCreated && plan.path?.name === 'JP-MS', 'a new path JP-MS', plan.path?.name)
    const x = plan.lines[0]
    t.eq(x.yard?.id, yardId('MS', '230KV'), 'into the 230 kV yard of MS')
    const [nMA, nMC] = maSide.id === x.circuits[0].id ? x.added : [x.added[1], x.added[0]]
    checkNewTakeOff(t, doc, after, yardId('MS', '230KV'), nMA.id, V.AC230KV, 'the MA side', '230KV_MA_L1')
    checkNewTakeOff(t, doc, after, yardId('MS', '230KV'), nMC.id, V.AC230KV, 'the MC side', '230KV_MC_L1')
    // at JP: the MA side stays in its node with its new circuit, the MC side in a new node with its own
    const kept = circuitEndConnection(after, maSide.id, CIRCUIT_END_TO)!
    t.eq(kept.id, item.connection.id, 'the MA side stays in its node')
    t.eq(circuitNodes(kept).map(n => n.id).sort().join(), [maSide.id, nMA.id].sort().join(), 'that node: the MA side and its new circuit')
    checkNewNode(t, doc, after, JP, [mcSide.id, nMC.id], V.AC230KV, 'the MC side')
    // the new circuits: on the path, FROM at JP, as long as the path, made like the side they continue
    const km = Number(haversineKm({latitude: 13.3, longitude: 101.2}, {latitude: 13.6, longitude: 101.0}).toFixed(2))
    for (const [c, side] of [[nMA, maSide], [nMC, mcSide]] as const) {
        const rec = after.circuits.find(r => r.id === c.id)!
        t.check(rec.pathId === plan.path?.id && rec.lengthKm === km, `${c.name}: on the path, ${km} km`, rec)
        t.check(rec.voltage === side.voltage && rec.energizedVoltage === V.AC230KV && rec.bundle === side.bundle && JSON.stringify(rec.conductor) === JSON.stringify(side.conductor), `${c.name}: made like ${side.name}`, rec)
        t.eq(circuitEndConnection(after, c.id, CIRCUIT_END_FROM)?.junction.id, JP, `${c.name}: FROM at JP`)
    }
    // the line: MA → MS yard, and a new one MS yard → MC
    const first = after.lines.find(l => l.id === lineNamed(doc, '230KV_MA_MC_L1').id)!
    t.eq(first.circuitIds.join(), [maSide.id, nMA.id].join(), 'the line keeps the MA side and its new circuit')
    t.eq(first.to?.id, yardId('MS', '230KV'), 'the line ends at the MS yard')
    const second = x.splitLines[0].added
    t.eq(second.name, '230KV_MS_MC_L1', 'the second part is a new line MS – MC')
    t.eq(second.circuitIds.join(), [nMC.id, mcSide.id].join(), 'the new line: the MC side new circuit, then the MC side')
    contiguous(t, after, first)
    contiguous(t, after, second)
    t.eq(JSON.stringify(after.lines.find(l => l.name === '230KV_MA_MC_L2')), JSON.stringify(lineNamed(doc, '230KV_MA_MC_L2')), 'the other line through JP is left as it is')
})

test('SC-2', 'the 500 kV line through JX into MS (no 500 kV yard): spliced at its site junction, warned, no take-off', t => {
    const doc = lineFixture()
    const {plan, after} = sectionalize(t, doc, JX, ['500KV_MB_ME_L1'], {kind: 'site', groupId: MS})
    t.check(plan.warnings.some(w => /500KV_MB_ME_L1 runs at AC500KV: MS has no yard at it, so it is spliced at the site junction MS and not connected to any take-off/.test(w)), 'warned: spliced at the site junction, no take-off', plan.warnings)
    const x = plan.lines[0]
    t.check(!x.yard && x.fellBack && x.junction?.id === junctionId('MS'), 'spliced at the site junction MS', x)
    t.eq(after.takeOffs.length, doc.takeOffs.length, 'no take-off is made')
    checkNewNode(t, doc, after, junctionId('MS'), x.added.map(c => c.id), V.AC500KV, 'at MS')
    const line = after.lines.find(l => l.name === '500KV_MB_ME_L1')!
    t.eq(line.circuitIds.length, 4, 'the line keeps running, two sections longer')
    contiguous(t, after, line)
    t.eq(x.splitLines.length, 0, 'no line is split')
})

test('SC-3', 'into the site junction asked for, though MS has a 230 kV yard: spliced, no warning', t => {
    const doc = lineFixture()
    const {plan, after} = sectionalize(t, doc, JP, ['230KV_MA_MC_L1'], {kind: 'site', groupId: MS, siteJunction: true})
    t.eq(plan.warnings.length, 0, 'no warnings')
    t.check(!plan.lines[0].yard && !plan.lines[0].fellBack, 'spliced on purpose', plan.lines[0])
    checkNewNode(t, doc, after, junctionId('MS'), plan.lines[0].added.map(c => c.id), V.AC230KV, 'at MS')
    contiguous(t, after, after.lines.find(l => l.name === '230KV_MA_MC_L1')!)
})

test('SC-4', 'both JP lines into line junction JQ: one path, a node of its own per line at JQ, the lines keep running', t => {
    const doc = lineFixture()
    const {plan, after} = sectionalize(t, doc, JP, ['230KV_MA_MC_L1', '230KV_MA_MC_L2'], {kind: 'junction', junctionId: JQ})
    t.check(plan.pathCreated && after.circuits.filter(c => c.pathId === plan.path?.id).length === 4, 'one new path JP-JQ with four circuits', plan.path?.name)
    const atJQ = newConnections(doc, after).filter(c => c.junction.kind === ConnectionJunctionKind.TRANSMISSION_JUNCTION && c.junction.id === JQ)
    t.eq(atJQ.length, 2, 'two new nodes at JQ')
    for (const x of plan.lines) {
        const node = atJQ.find(c => c.nodes.some(n => n.id === x.added[0].id))
        t.eq(node && circuitNodes(node).map(n => n.id).sort().join(), x.added.map(c => c.id).sort().join(), `${x.label}: its two new circuits spliced in a node of their own`)
        const line = after.lines.find(l => l.name === x.label)!
        t.eq(line.circuitIds.length, 4, `${x.label}: two sections longer`)
        contiguous(t, after, line)
    }
    t.check(plan.lines.every(x => x.added[1].name === `${x.added[0].name}_2`), 'the second new circuit of a line on the path is told apart by _2', plan.lines.map(x => x.added.map(c => c.name)))
})

test('SC-5', 'on an existing path running the other way (MD → JX): the new circuits follow it, FROM at MD; MD has no 500 kV yard', t => {
    const doc = lineFixture()
    const existing = doc.paths.find(p => p.from?.id === siteId('MD') && p.to?.id === JX)!
    const {plan, after} = sectionalize(t, doc, JX, ['500KV_MB_ME_L1'], {kind: 'site', groupId: siteId('MD')}, {pathId: existing.id})
    t.check(!plan.pathCreated && plan.path?.id === existing.id, 'on the existing path', plan.path?.name)
    t.check(plan.warnings.some(w => /follow its direction/.test(w)) && plan.warnings.some(w => /MD has no yard at it/.test(w)), 'warned: the direction, and no 500 kV yard at MD', plan.warnings)
    t.check(!!plan.createdJunction && plan.createdJunction.groupId === siteId('MD'), 'the site junction of MD is created', plan.createdJunction)
    for (const c of plan.lines[0].added) {
        t.eq(circuitEndConnection(after, c.id, CIRCUIT_END_FROM)?.junction.id, plan.createdJunction?.id, `${c.name}: FROM at MD`)
        t.eq(circuitEndConnection(after, c.id, CIRCUIT_END_TO)?.junction.id, JX, `${c.name}: TO at JX`)
    }
    contiguous(t, after, after.lines.find(l => l.name === '500KV_MB_ME_L1')!)
})

test('SC-6', 'a line split at JP into two lines meeting there: each end moves to the MS yard with its side', t => {
    const base = lineFixture()
    const line = lineNamed(base, '230KV_MA_MC_L1')
    const [a, b] = line.circuitIds
    const jp = {kind: ConnectionJunctionKind.TRANSMISSION_JUNCTION, id: JP}
    const doc = applyOps(base, [
        {type: 'upsert', collection: 'lines', record: {...line, to: jp, circuitIds: [a]}},
        {type: 'upsert', collection: 'lines', record: {id: 'TLN_JP_MC', name: '230KV_JP_MC_L1', voltage: line.voltage, from: jp, to: line.to, circuitIds: [b]}},
    ])
    const {plan, after} = sectionalize(t, doc, JP, [a], {kind: 'site', groupId: MS})
    const yard = yardId('MS', '230KV')
    const first = after.lines.find(l => l.id === line.id)!, second = after.lines.find(l => l.id === 'TLN_JP_MC')!
    t.check(first.to?.id === yard && first.circuitIds.length === 2 && first.circuitIds[0] === a, 'the MA – JP line now ends at the MS yard, its new circuit last', first)
    t.check(second.from?.id === yard && second.circuitIds.length === 2 && second.circuitIds[1] === b, 'the JP – MC line now starts at the MS yard, its new circuit first', second)
    contiguous(t, after, first)
    contiguous(t, after, second)
    t.eq(plan.lines[0].splitLines.length, 0, 'nothing to split: two lines already')
})

test('SC-7', 'a de-energized line into MS: the yard at its rated voltage (230 kV); warned, it stays de-energized', t => {
    const base = lineFixture()
    const line = lineNamed(base, '230KV_MA_MC_L2')
    const doc = applyOps(base, line.circuitIds.map(id => ({type: 'upsert' as const, collection: 'circuits' as const, record: {...base.circuits.find(c => c.id === id)!, energizedVoltage: V.DE_ENERGIZED}})))
    const {plan, after} = sectionalize(t, doc, JP, ['230KV_MA_MC_L2'], {kind: 'site', groupId: MS})
    t.eq(plan.lines[0].yard?.id, yardId('MS', '230KV'), 'into the 230 kV yard')
    t.check(plan.warnings.some(w => /de-energized \(0 V\): entering yard MS 230KV/.test(w)), 'warned: it stays de-energized', plan.warnings)
    t.check(plan.lines[0].added.every(c => after.circuits.find(r => r.id === c.id)?.energizedVoltage === V.DE_ENERGIZED), 'the new circuits stay de-energized')
})

test('SC-8', 'refused: into a site the line already runs to, into the junction itself, a line through a tee', t => {
    const doc = lineFixture()
    const key = through(doc, JP, '230KV_MA_MC_L1').key
    const refused = (d: NetworkDocument, junction: string, keys: string[], target: SectionTarget, error: RegExp, label: string) => {
        const plan = buildSectionalizePlan(d, junction, keys, target)
        t.check(plan.ops.length === 0 && plan.errors.some(e => error.test(e)), label, plan.errors)
    }
    refused(doc, JP, [key], {kind: 'site', groupId: siteId('MC')}, /already runs to MC/, 'into MC, where the line runs already')
    refused(doc, JP, [key], {kind: 'junction', junctionId: JP}, /that is this junction/, 'into JP itself')
    // JQ: put the 115 kV line's open end into the 230 kV splice node, a tee
    const nodes = doc.connections.filter(c => c.junction.id === JQ)
    const splice = nodes.find(c => circuitNodes(c).length === 2)!, open = nodes.find(c => circuitNodes(c).length === 1)!
    const tee = applyOps(doc, [{type: 'delete', collection: 'connections', id: open.id}, {type: 'upsert', collection: 'connections', record: {...splice, nodes: [...splice.nodes, ...open.nodes.filter(n => n.kind === NetworkNodeKind.TRANSMISSION_CIRCUIT)]}}])
    refused(tee, JQ, [through(tee, JQ, '230KV_MS_ME_L1').key], {kind: 'site', groupId: siteId('MD')}, /a tee/, 'a line through a tee')
    // nothing checked
    refused(doc, JP, [], {kind: 'site', groupId: MS}, /check at least one line/, 'nothing checked')
    // the other end of a circuit stays as it was (the MC side keeps its TO end)
    t.check(!!circuitEndConnection(doc, through(doc, JP, '230KV_MA_MC_L1').circuits[0].id, CIRCUIT_END_TO), 'the fixture is untouched')
})

test('SC-9', 'at the site junction of MS, 230KV_MA_ME_L1 into MS itself: its 230 kV yard through a take-off per side, no new circuit or path', t => {
    const doc = lineFixture()
    const item = through(doc, junctionId('MS'), '230KV_MA_ME_L1')
    const {plan, after} = sectionalize(t, doc, junctionId('MS'), ['230KV_MA_ME_L1'], {kind: 'site', groupId: MS})
    t.check(plan.intoOwnSite && !plan.path && plan.lines[0].added.length === 0, 'into its own site: no path, no new circuit', plan)
    t.eq(after.circuits.length, doc.circuits.length, 'no circuit added')
    t.eq(after.paths.length, doc.paths.length, 'no path added')
    const [maSide, meSide] = item.circuits[0].name.includes('MA-MS') ? item.circuits : [item.circuits[1], item.circuits[0]]
    checkNewTakeOff(t, doc, after, yardId('MS', '230KV'), maSide.id, V.AC230KV, 'the MA side', '230KV_MA_L1')
    checkNewTakeOff(t, doc, after, yardId('MS', '230KV'), meSide.id, V.AC230KV, 'the ME side', '230KV_ME_L2')
    t.check(!after.connections.some(c => c.id === item.connection.id), 'the splice at the site junction is gone')
    t.check(!plan.removedJunction && after.junctions.some(j => j.id === junctionId('MS')), 'the site junction stays: other lines end there')
    const split = plan.lines[0].splitLines[0]
    t.eq(`${split?.line.name} → ${split?.line.to?.id}; ${split?.added.name} ← ${split?.added.from?.id}`, `230KV_MA_ME_L1 → ${yardId('MS', '230KV')}; 230KV_MS_ME_L2 ← ${yardId('MS', '230KV')}`, 'the line split at the yard (MS – ME L1 is the line through JQ)')
    contiguous(t, after, split.line)
    contiguous(t, after, split.added)
})

test('SC-10', 'a line spliced at the site junction of SV (routed via it) into SV: a free take-off toward QA used, a new one toward QB; the empty junction removed', t => {
    const base = lineFixture()
    const circuit = lineNamed(base, '230KV_QA_QB_L1').circuitIds[0]
    const routed = buildRouteViaPlan(base, base.circuits.find(c => c.id === circuit)!.pathId!, [circuit], {kind: 'siteJunction', groupId: siteId('SV')})
    t.eq(routed.errors.join('; '), '', 'routed via the site junction of SV (created)')
    const sv = yardId('SV', '230KV')
    const doc = applyOps(base, [...routed.ops, {type: 'upsert', collection: 'takeOffs', record: {id: 'STO_SV_FREE_QA', name: '230KV_QA_L1', substationId: sv, lineName: '230KV_QA_L1', takeOffColumn: true}}])
    const svJunction = routed.createdJunction!.id
    const {plan, after} = sectionalize(t, doc, svJunction, ['230KV_QA_QB_L1'], {kind: 'site', groupId: siteId('SV')})
    const x = plan.lines[0]
    t.eq(x.takeOffs.map(tk => `${tk.lineName}${x.reusedTakeOffs.includes(tk) ? ' (free)' : ''}`).sort().join(', '), '230KV_QA_L1 (free), 230KV_QB_L1', 'the free take-off toward QA used, a new one toward QB')
    t.check(after.connections.some(c => c.nodes.some(n => n.id === 'STO_SV_FREE_QA') && c.nodes.some(n => x.circuits.some(s => s.id === n.id))), 'the QA side leaves through the free take-off')
    t.eq(plan.removedJunction?.id, svJunction, 'the site junction of SV is removed: nothing is left at it')
    t.check(!after.junctions.some(j => j.id === svJunction), 'gone from the network')
    t.eq(x.splitLines.map(s => `${s.line.name} + ${s.added.name}`).join(), '230KV_QA_QB_L1 + 230KV_SV_QB_L1', 'the line split at SV')
    for (const s of x.splitLines) {
        contiguous(t, after, s.line)
        contiguous(t, after, s.added)
    }
})

test('SC-11', 'refused into its own site: no yard at the line voltage (it stays spliced), or its site junction asked for', t => {
    const base = lineFixture()
    // the 500 kV line spliced at the site junction of MS first (MS has no 500 kV yard)
    const first = buildSectionalizePlan(base, JX, [through(base, JX, '500KV_MB_ME_L1').key], {kind: 'site', groupId: MS})
    const doc = applyOps(base, first.ops)
    const key = through(doc, junctionId('MS'), '500KV_MB_ME_L1').key
    const plan = buildSectionalizePlan(doc, junctionId('MS'), [key], {kind: 'site', groupId: MS})
    t.check(plan.ops.length === 0 && plan.errors.some(e => /runs at AC500KV: MS has no yard at it, so it stays spliced at the site junction/.test(e)), 'no 500 kV yard at MS: refused', plan.errors)
    const asked = buildSectionalizePlan(base, junctionId('MS'), [through(base, junctionId('MS'), '230KV_MA_ME_L1').key], {kind: 'site', groupId: MS, siteJunction: true})
    t.check(asked.ops.length === 0 && asked.errors.some(e => /spliced at the site junction of MS already/.test(e)), 'its site junction asked for: refused', asked.errors)
})
