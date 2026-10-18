/**
 * A part of a network around a site (`extractAround`, what `npm run sample:grid` takes from the EGAT network), on the
 * fixture's busy area (docs/testing.md section 7).
 */
import {extractAround} from '@shared/network/extract'
import {test} from './harness'
import {junctionId, lineFixture, siteId} from './fixture'
import {validates} from './verify'

const codes = (ids: string[]) => ids.map(id => id.replace(/^SSG_/, '')).sort().join(', ')

test('EX-1', 'MA and one line away: its lines, the sites they reach, the junctions on the way; nothing else', t => {
    const doc = lineFixture()
    const {doc: part, sitesByHop} = extractAround(doc, siteId('MA'), 1)
    validates(t, part)
    t.eq(codes(sitesByHop[1]), 'MB, MC, MD, ME, MS', 'the sites one line away')
    t.eq(codes(part.substationGroups.map(g => g.id)), 'MA, MB, MC, MD, ME, MS', 'the sites kept')
    t.eq(part.lines.map(l => l.name).sort().join(', '), doc.lines.filter(l => /^\d+KV_MA_/.test(l.name)).map(l => l.name).sort().join(', '), 'every line from MA, and only those')
    t.check(part.junctions.some(j => j.id === junctionId('JP')) && part.junctions.some(j => j.id === junctionId('MS')), 'JP (on the way to MC) and the site junction of MS (MA – ME through it) are kept', part.junctions.map(j => j.name))
    t.check(!part.junctions.some(j => j.id === junctionId('JQ') || j.id === junctionId('JX')), 'JQ and JX (no line from MA) are left out', part.junctions.map(j => j.name))
    const kept = new Set(part.circuits.map(c => c.id))
    t.check(part.connections.every(c => c.nodes.every(n => n.kind !== 'TRANSMISSION_CIRCUIT' || kept.has(n.id))), 'connections hold kept circuit ends only')
    t.eq(part.yardConnections.length, 0, 'no yard links')
    t.check(part.substations.every(y => part.substationGroups.some(g => g.id === y.groupId)) && part.substations.filter(y => y.groupId === siteId('MS')).length === 2, 'every yard of the kept sites (MS: 230 and 115 kV)')
})

test('EX-2', 'two lines away from MB: the lines of the sites one line away too', t => {
    const doc = lineFixture()
    const one = extractAround(doc, siteId('MB'), 1)
    t.eq(codes(one.sitesByHop[1]), 'MA, ME', 'one line away from MB')
    validates(t, one.doc)
    const two = extractAround(doc, siteId('MB'), 2)
    validates(t, two.doc)
    t.eq(codes(two.sitesByHop[2]), 'MC, MD, MS', 'two lines away: what MA and ME reach besides')
    t.check(two.doc.lines.length > one.doc.lines.length && two.doc.substationGroups.every(g => g.groupName.startsWith('M')), 'more lines, still only the busy area (none of the Q and S sites)', two.doc.substationGroups.map(g => g.groupName))
})
