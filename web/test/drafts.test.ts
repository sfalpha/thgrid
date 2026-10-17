/**
 * Map drafts of "+ Path", "+ Circuit" and "+ Line" (docs/testing.md section 4): what is picked, and taking a picked
 * place out again, as a right-click on the map does (`draftPickedPlaces`, `dropDraftPlace`); and the New line ends, where the
 * yard picked last leads (`lineDraftSetEnd`).
 */
import {draftPickedPlaces, dropDraftPlace, lineDraftSetEnd, lineDraftSiteClick} from '../src/network/mapUtil'
import {test} from './harness'
import {junctionId, lineFixture, siteId, yardId} from './fixture'

const G = (code: string) => `G:${siteId(code)}`
const J = (name: string) => `J:${junctionId(name)}`

test('DR-1', 'the places picked: ends, then stops; a line end at a yard counts as its site', t => {
    const doc = lineFixture()
    t.eq(draftPickedPlaces(doc, {from: G('SA'), to: J('J2')}).join(), [G('SA'), J('J2')].join(), 'a path or circuit draft')
    t.eq(draftPickedPlaces(doc, {from: `Y:${yardId('MA', '230KV')}`, to: G('ST'), vias: [J('JX'), G('MS'), '']}).join(), [G('MA'), G('ST'), J('JX'), G('MS')].join(), 'a line draft')
    t.eq(draftPickedPlaces(doc, {from: '', to: ''}).length, 0, 'nothing picked')
})
test('DR-2', 'taking a picked place out of a path or circuit draft: that end only', t => {
    const doc = lineFixture()
    const d = {from: G('SA'), to: J('J2'), name: 'x', id: ''}
    t.check(JSON.stringify(dropDraftPlace(doc, d, J('J2'))) === JSON.stringify({...d, to: ''}), 'the TO end', dropDraftPlace(doc, d, J('J2')))
    t.check(JSON.stringify(dropDraftPlace(doc, d, G('SA'))) === JSON.stringify({...d, from: ''}), 'the FROM end')
    t.check(dropDraftPlace(doc, d, G('SB')) === d, 'a place not picked: unchanged')
})
test('DR-3', 'taking a picked place out of a line draft: an end (by its site, also at a yard) or a stop in between', t => {
    const doc = lineFixture()
    const d = {from: `Y:${yardId('MA', '230KV')}`, to: G('ST'), vias: [J('JX'), G('MS')]}
    t.eq(dropDraftPlace(doc, d, G('MA')).from, '', 'the FROM end at a yard of MA')
    t.eq(dropDraftPlace(doc, d, G('ST')).to, '', 'the TO end at the site junction of ST')
    t.eq(dropDraftPlace(doc, d, J('JX')).vias.join(), G('MS'), 'a junction in between')
    t.eq(dropDraftPlace(doc, d, G('MS')).vias.join(), J('JX'), 'a site in between')
})

/* ---------- New line: the yard picked last leads ---------- */

const Yd = (code: string, kv: string) => `Y:${yardId(code, kv)}`

test('DR-4', 'New line: the yard picked last leads, the other end moves to its yard at that voltage', t => {
    const doc = lineFixture()
    const d = {from: Yd('MA', '500KV'), to: '', vias: []}
    t.eq(lineDraftSetEnd(doc, d, 'to', Yd('MC', '230KV')).from, Yd('MA', '230KV'), 'MC 230 kV picked: MA follows to its 230 kV yard')
    const both = {from: Yd('MA', '230KV'), to: Yd('SH', '230KV'), vias: []}
    t.eq(lineDraftSetEnd(doc, both, 'from', Yd('MA', '115KV')).to, Yd('SH', '115KV'), 'MA changed to 115 kV: SH follows to its 115 kV yard')
    t.eq(lineDraftSetEnd(doc, both, 'to', Yd('SH', '115KV')).from, Yd('MA', '115KV'), 'SH changed to 115 kV: MA follows')
})
test('DR-5', 'New line: the other end stays when its site has no yard at that voltage, or it is not a yard', t => {
    const doc = lineFixture()
    t.eq(lineDraftSetEnd(doc, {from: Yd('MB', '500KV'), to: '', vias: []}, 'to', Yd('MC', '230KV')).from, Yd('MB', '500KV'), 'MB has no 230 kV yard: it stays at 500 kV')
    t.eq(lineDraftSetEnd(doc, {from: G('MS'), to: '', vias: []}, 'to', Yd('MD', '115KV')).from, G('MS'), 'a site junction end stays')
    t.eq(lineDraftSetEnd(doc, {from: J('JX'), to: '', vias: []}, 'to', Yd('MD', '115KV')).from, J('JX'), 'a line junction end stays')
})
test('DR-6', 'New line on the map: the second site clicked leads too', t => {
    const doc = lineFixture()
    const first = lineDraftSiteClick(doc, {from: '', to: '', vias: []}, siteId('MA')).draft!
    t.eq(first.from, Yd('MA', '500KV'), 'MA alone: its highest yard')
    const second = lineDraftSiteClick(doc, first, siteId('MC')).draft!
    t.check(second.to === Yd('MC', '230KV') && second.from === Yd('MA', '230KV'), 'then MC (230 kV only): MA follows to 230 kV', second)
})
