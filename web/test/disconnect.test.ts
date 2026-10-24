/**
 * Disconnecting lines from a site's take-offs (docs/testing.md section 8, `buildDisconnectPlan`), on the busy area: the
 * end goes to the site junction as an open end; a line then fed from no yard is de-energized (circuits, junction nodes,
 * the line at 0 V); the take-offs left free can be removed.
 */
import {TransmissionVoltage as V} from '@shared/models/transmission.voltage'
import {applyOps} from '@shared/network/ops'
import {circuitEndConnection} from '@shared/network/migrate'
import {ConnectionJunctionKind, NetworkDocument, NetworkNodeKind} from '@shared/network/records'
import {buildDisconnectPlan, DisconnectOptions, linesThroughTakeOffs} from '../src/network/disconnectLines'
import {Checker, test} from './harness'
import {junctionId, lineFixture, siteId} from './fixture'
import {circuitNodes, lineNamed, namesUnique, validates} from './verify'

function disconnect(t: Checker, doc: NetworkDocument, site: string, lineNames: string[], opts: DisconnectOptions = {}) {
    const plan = buildDisconnectPlan(doc, siteId(site), lineNames.map(n => lineNamed(doc, n).id), opts)
    t.eq(plan.errors.join('; '), '', 'no errors')
    const after = applyOps(doc, plan.ops)
    validates(t, after)
    namesUnique(t, after)
    return {plan, after}
}

/** The line's end at `site` is open at that site's junction: a node holding only this circuit end; the line ends there. */
function openAtSiteJunction(t: Checker, after: NetworkDocument, lineName: string, site: string, lineEnd: 'from' | 'to') {
    const line = after.lines.find(l => l.name === lineName)!
    const j = after.junctions.find(x => x.groupId === siteId(site))
    t.check(!!j && line[lineEnd]?.kind === ConnectionJunctionKind.TRANSMISSION_JUNCTION && line[lineEnd]?.id === j.id, `${lineName}: its ${lineEnd} end is the site junction of ${site}`, line[lineEnd])
    const node = j && after.connections.find(c => c.junction.id === j.id && line.circuitIds.some(id => c.nodes.some(n => n.id === id)))
    t.check(!!node && circuitNodes(node).length === 1, `${lineName}: open at ${site}'s junction, a node of its own`, node)
}

test('DL-1', 'the site lists the lines leaving through its take-offs; MC: the three from MA', t => {
    const doc = lineFixture()
    t.eq(linesThroughTakeOffs(doc, siteId('MC')).map(x => x.line.name).join(', '), '230KV_MA_MC_L1, 230KV_MA_MC_L2, 230KV_MA_MC_L3', 'the lines at MC')
    t.check(linesThroughTakeOffs(doc, siteId('MC')).every(x => x.others.length === 1 && x.others[0].site.id === siteId('MA')), 'each still leaves MA through a take-off too')
})

test('DL-2', 'at MC, 230KV_MA_MC_L1 off its take-off: open at the site junction of MC (created); fed from MA, it stays energized', t => {
    const doc = lineFixture()
    const takeOff = linesThroughTakeOffs(doc, siteId('MC')).find(x => x.line.name === '230KV_MA_MC_L1')!.here[0].takeOff
    const {plan, after} = disconnect(t, doc, 'MC', ['230KV_MA_MC_L1'])
    t.check(plan.createdJunctions.length === 1 && plan.createdJunctions[0].groupId === siteId('MC'), 'the site junction of MC is created', plan.createdJunctions)
    openAtSiteJunction(t, after, '230KV_MA_MC_L1', 'MC', 'to')
    t.check(!plan.lines[0].deEnergized && plan.deEnergized.circuits.length === 0, 'still fed from MA: not de-energized', plan.deEnergized)
    t.check(after.lines.find(l => l.name === '230KV_MA_MC_L1')!.circuitIds.every(id => after.circuits.find(c => c.id === id)?.energizedVoltage === V.AC230KV), 'the sections stay at 230 kV')
    t.check(after.takeOffs.some(x => x.id === takeOff.id), `the take-off ${takeOff.lineName} stays (free)`)
})

test('DL-3', 'the same, removing the take-off left free', t => {
    const doc = lineFixture()
    const takeOff = linesThroughTakeOffs(doc, siteId('MC')).find(x => x.line.name === '230KV_MA_MC_L1')!.here[0].takeOff
    const {plan, after} = disconnect(t, doc, 'MC', ['230KV_MA_MC_L1'], {removeTakeOffs: true})
    t.eq(plan.removedTakeOffs.map(x => x.id).join(), takeOff.id, 'the take-off is removed')
    t.check(!after.takeOffs.some(x => x.id === takeOff.id) && !after.connections.some(c => c.nodes.some(n => n.id === takeOff.id)), 'gone, with every connection that held it')
})

test('DL-4', 'both ends at once: open at the junctions of MC and MA; fed from nowhere, the line, its sections and the node at JP at 0 V', t => {
    const doc = lineFixture()
    const {plan, after} = disconnect(t, doc, 'MC', ['230KV_MA_MC_L1'], {bothEnds: true})
    openAtSiteJunction(t, after, '230KV_MA_MC_L1', 'MC', 'to')
    openAtSiteJunction(t, after, '230KV_MA_MC_L1', 'MA', 'from')
    t.check(plan.lines[0].deEnergized, 'de-energized')
    const line = after.lines.find(l => l.name === '230KV_MA_MC_L1')!
    t.eq(line.voltage, V.DE_ENERGIZED, 'the line at 0 V')
    t.check(line.circuitIds.every(id => after.circuits.find(c => c.id === id)?.energizedVoltage === V.DE_ENERGIZED), 'its sections energized at 0 V')
    t.check(line.circuitIds.every(id => after.circuits.find(c => c.id === id)?.voltage === V.AC230KV), 'still rated 230 kV')
    const jp = circuitEndConnection(after, line.circuitIds[0], 'TO')!
    t.check(jp.junction.id === junctionId('JP') && jp.voltage === V.DE_ENERGIZED, 'the splice at JP at 0 V', jp)
    t.check(after.lines.filter(l => l.name === '230KV_MA_MC_L2').every(l => l.voltage === V.AC230KV), 'the other JP line stays at 230 kV')
})

test('DL-5', 'the other end already open: MD – JQ (open at JQ) off its take-off at MD is fed from nowhere: 0 V, the open node at JQ too', t => {
    const doc = lineFixture()
    const {plan, after} = disconnect(t, doc, 'MD', ['115KV_MD_JQ_L1'])
    t.check(plan.lines[0].deEnergized && !plan.lines[0].stillAt, 'de-energized: no take-off left at either end', plan.lines[0])
    const line = after.lines.find(l => l.name === '115KV_MD_JQ_L1')!
    t.eq(line.voltage, V.DE_ENERGIZED, 'the line at 0 V')
    const atJQ = circuitEndConnection(after, line.circuitIds[0], 'TO')!
    t.check(atJQ.junction.id === junctionId('JQ') && atJQ.voltage === V.DE_ENERGIZED, 'its open node at JQ at 0 V', atJQ)
})

test('DL-6', 'a tee keeps it fed: MD – JQ teed into the 230 kV splice at JQ stays energized when taken off MD', t => {
    const base = lineFixture()
    const md = lineNamed(base, '115KV_MD_JQ_L1').circuitIds[0]
    const open = circuitEndConnection(base, md, 'TO')!
    const splice = base.connections.find(c => c.junction.id === junctionId('JQ') && circuitNodes(c).length === 2)!
    const doc = applyOps(base, [{type: 'delete', collection: 'connections', id: open.id}, {type: 'upsert', collection: 'connections', record: {...splice, nodes: [...splice.nodes, ...open.nodes.filter(n => n.kind === NetworkNodeKind.TRANSMISSION_CIRCUIT)]}}])
    const {plan} = disconnect(t, doc, 'MD', ['115KV_MD_JQ_L1'])
    t.check(!plan.lines[0].deEnergized && plan.deEnergized.circuits.length === 0, 'still fed through the tee: nothing at 0 V', plan.deEnergized)
})

test('DL-7', 'an already de-energized line (230KV_MA_MC_L3) taken off both ends: nothing to flip; refused without a line', t => {
    const doc = lineFixture()
    const {plan} = disconnect(t, doc, 'MC', ['230KV_MA_MC_L3'], {bothEnds: true})
    t.check(plan.lines[0].deEnergized && plan.deEnergized.circuits.length === 0, 'fed from nowhere, already at 0 V', plan.deEnergized)
    const none = buildDisconnectPlan(doc, siteId('MC'), [])
    t.check(none.ops.length === 0 && /check at least one line/.test(none.errors.join()), 'nothing checked: refused', none.errors)
})
