/**
 * Line creation (the "New line" wizard, `buildNewLinePlan`): every case of docs/testing.md section 2, on the fixture
 * network. Each case checks the plan (errors, warnings, notes: the exact set) and, applied, the document: the line, its
 * sections, the take-offs (new or reused, their yard and voltage), the junction nodes and the voltages throughout.
 */
import {TransmissionVoltage as V} from '@shared/models/transmission.voltage'
import {validateNetworkDocument} from '@shared/network/validation'
import {takeOffVoltage} from '@shared/network/migrate'
import {buildNewLinePlan} from '../src/network/lineWizard'
import {test} from './harness'
import {junctionId, lineFixture, siteId, yardId} from './fixture'
import {EndExpect, spec, verifyLine, verifyRefused} from './verify'

test('LC-00', 'the fixture is a valid network', t => {
    const issues = validateNetworkDocument(lineFixture()).filter(i => i.severity !== 'warning')
    t.check(issues.length === 0, 'no validation errors', issues)
})

/* ---------- 2.1 ends: FROM × TO ---------- */

type EndKind = 'NT' | 'ET' | 'SJ' | 'J'
const KINDS: EndKind[] = ['NT', 'ET', 'SJ', 'J']
const KIND_LABEL: Record<EndKind, string> = {NT: 'substation, new take-off', ET: 'substation, existing take-off', SJ: 'substation junction', J: 'junction'}
/** The place of each role, and the code a take-off toward it is named after. */
const FROM_END: Record<EndKind, { key: string; code: string }> = {
    NT: {key: `Y:${yardId('SA', '230KV')}`, code: 'SA'},
    ET: {key: `Y:${yardId('SF', '230KV')}`, code: 'SF'},
    SJ: {key: `G:${siteId('ST')}`, code: 'ST'},
    J: {key: `J:${junctionId('J1')}`, code: 'J1'},
}
const TO_END: Record<EndKind, { key: string; code: string }> = {
    NT: {key: `Y:${yardId('SB', '230KV')}`, code: 'SB'},
    ET: {key: `Y:${yardId('SG', '230KV')}`, code: 'SG'},
    SJ: {key: `G:${siteId('SS')}`, code: 'SS'},
    J: {key: `J:${junctionId('J2')}`, code: 'J2'},
}
const endExpect = (kind: EndKind, side: 'from' | 'to', otherCode: string): EndExpect => {
    const code = side === 'from' ? FROM_END[kind].code : TO_END[kind].code
    if (kind === 'NT') return {yard: yardId(code, '230KV'), takeOff: 'new'}
    if (kind === 'ET') return {yard: yardId(code, '230KV'), takeOff: `STO_${code}_230KV_230KV_${otherCode}_L1`}
    if (kind === 'SJ') return {siteJunction: siteId(code)}
    return {junction: junctionId(code)}
}
const isJunction = (k: EndKind) => k === 'SJ' || k === 'J'

for (const f of KINDS) for (const to of KINDS) {
    test(`LC-E-${f}-${to}`, `from ${KIND_LABEL[f]} to ${KIND_LABEL[to]} (230 kV conductor, 230 kV yards)`, t => {
        const open = isJunction(f) && isJunction(to)
        verifyLine(t, lineFixture(), spec({from: FROM_END[f].key, to: TO_END[to].key, voltage: V.AC230KV}), {
            rated: V.AC230KV,
            line: open ? V.DE_ENERGIZED : V.AC230KV,
            from: endExpect(f, 'from', TO_END[to].code),
            to: endExpect(to, 'to', FROM_END[f].code),
            notes: [
                ...(isJunction(f) ? [/^the line starts at .*: each circuit gets a node of its own there/] : []),
                ...(isJunction(to) ? [/^the line ends at .*: each circuit gets a node of its own there/] : []),
                ...(open ? [/^both ends are junctions, so no yard energizes it: the line is de-energized \(0 V\)/] : []),
            ],
        })
    })
}

/* ---------- 2.2 junctions in between ---------- */

const SA = yardId('SA', '230KV'), SB = yardId('SB', '230KV')
test('LC-V-1', 'via a line junction', t => {
    verifyLine(t, lineFixture(), spec({from: `Y:${SA}`, to: `Y:${SB}`, voltage: V.AC230KV, vias: [{junctionId: junctionId('J3')}]}), {
        rated: V.AC230KV, line: V.AC230KV, from: {yard: SA, takeOff: 'new'}, to: {yard: SB, takeOff: 'new'}, vias: [{junction: junctionId('J3')}],
    })
})
test('LC-V-2', 'via a substation junction (created)', t => {
    const doc = lineFixture()
    const plan = buildNewLinePlan(doc, spec({from: `Y:${SA}`, to: `Y:${SB}`, voltage: V.AC230KV, vias: [{groupId: siteId('SV')}]}))
    t.check(plan.newJunctions.length === 1 && plan.newJunctions[0].groupId === siteId('SV'), 'the site junction of SV is created', plan.newJunctions)
    verifyLine(t, doc, spec({from: `Y:${SA}`, to: `Y:${SB}`, voltage: V.AC230KV, vias: [{groupId: siteId('SV')}]}), {
        rated: V.AC230KV, line: V.AC230KV, from: {yard: SA, takeOff: 'new'}, to: {yard: SB, takeOff: 'new'}, vias: [{siteJunction: siteId('SV')}],
    })
})
test('LC-V-3', 'via a junction, then a substation junction, then a junction', t => {
    verifyLine(t, lineFixture(), spec({from: `Y:${SA}`, to: `Y:${SB}`, voltage: V.AC230KV, vias: [{junctionId: junctionId('J3')}, {groupId: siteId('SV')}, {junctionId: junctionId('J4')}]}), {
        rated: V.AC230KV, line: V.AC230KV, from: {yard: SA, takeOff: 'new'}, to: {yard: SB, takeOff: 'new'},
        vias: [{junction: junctionId('J3')}, {siteJunction: siteId('SV')}, {junction: junctionId('J4')}],
    })
})
test('LC-V-4', 'two parallel circuits via a junction: a node of their own each', t => {
    verifyLine(t, lineFixture(), spec({from: `Y:${SA}`, to: `Y:${SB}`, voltage: V.AC230KV, circuits: 2, vias: [{junctionId: junctionId('J3')}]}), {
        rated: V.AC230KV, line: V.AC230KV, circuits: 2, from: {yard: SA, takeOff: 'new'}, to: {yard: SB, takeOff: 'new'}, vias: [{junction: junctionId('J3')}],
    })
})
test('LC-V-5', 'junction to junction via a junction: de-energized throughout', t => {
    verifyLine(t, lineFixture(), spec({from: `J:${junctionId('J1')}`, to: `J:${junctionId('J2')}`, voltage: V.AC230KV, vias: [{junctionId: junctionId('J3')}]}), {
        rated: V.AC230KV, line: V.DE_ENERGIZED, from: {junction: junctionId('J1')}, to: {junction: junctionId('J2')}, vias: [{junction: junctionId('J3')}],
        notes: [/^the line starts at/, /^the line ends at/, /^both ends are junctions/],
    })
})

/* ---------- 2.3 voltages ---------- */

const SC = yardId('SC', '115KV'), SD = yardId('SD', '115KV')
test('LC-O-1', 'yards below the conductor (230 kV conductor, 115 kV yards): runs at 115 kV, a note', t => {
    verifyLine(t, lineFixture(), spec({from: `Y:${SC}`, to: `Y:${SD}`, voltage: V.AC230KV}), {
        rated: V.AC230KV, line: V.AC115KV, from: {yard: SC, takeOff: 'new'}, to: {yard: SD, takeOff: 'new'},
        notes: [/^the circuits are rated AC230KV, .* is at AC115KV: they run at AC115KV/],
    })
})
test('LC-O-2', 'yards matching the conductor: runs at 230 kV, nothing to report', t => {
    verifyLine(t, lineFixture(), spec({from: `Y:${SA}`, to: `Y:${SB}`, voltage: V.AC230KV}), {
        rated: V.AC230KV, line: V.AC230KV, from: {yard: SA, takeOff: 'new'}, to: {yard: SB, takeOff: 'new'},
    })
})
test('LC-O-3a', 'energized voltage given, matching the yards: below the rating, a note', t => {
    verifyLine(t, lineFixture(), spec({from: `Y:${SC}`, to: `Y:${SD}`, voltage: V.AC230KV, energizedVoltage: V.AC115KV}), {
        rated: V.AC230KV, line: V.AC115KV, from: {yard: SC, takeOff: 'new'}, to: {yard: SD, takeOff: 'new'},
        notes: [/^the sections are energized at AC115KV, below their rated AC230KV/],
    })
})
test('LC-O-3b', 'energized voltage given, equal to the rating and the yards: nothing to report', t => {
    verifyLine(t, lineFixture(), spec({from: `Y:${SA}`, to: `Y:${SB}`, voltage: V.AC230KV, energizedVoltage: V.AC230KV}), {
        rated: V.AC230KV, line: V.AC230KV, from: {yard: SA, takeOff: 'new'}, to: {yard: SB, takeOff: 'new'},
    })
})
test('LC-O-3c', 'energized voltage given, the picked yard at another voltage, the site has one at it: refused (pick that one)', t => {
    verifyRefused(t, lineFixture(), spec({from: `Y:${yardId('SH', '230KV')}`, to: `Y:${SC}`, voltage: V.AC230KV, energizedVoltage: V.AC115KV}),
        [/^SH 230KV is at AC230KV, the line runs at AC115KV: pick its AC115KV yard 115KV/])
})
test('LC-O-3c2', 'energized voltage given, the site\'s yard at it picked: runs there, a below-rating note', t => {
    verifyLine(t, lineFixture(), spec({from: `Y:${yardId('SH', '115KV')}`, to: `Y:${SC}`, voltage: V.AC230KV, energizedVoltage: V.AC115KV}), {
        rated: V.AC230KV, line: V.AC115KV, from: {yard: yardId('SH', '115KV'), takeOff: 'new'}, to: {yard: SC, takeOff: 'new'},
        notes: [/^the sections are energized at AC115KV, below their rated AC230KV/],
    })
})
test('LC-O-3d', 'energized voltage given, below the picked yard, no yard at it at the site: an auxiliary take-off, a note', t => {
    const after = verifyLine(t, lineFixture(), spec({from: `Y:${yardId('SE', '230KV')}`, to: `Y:${SC}`, voltage: V.AC230KV, energizedVoltage: V.AC115KV}), {
        rated: V.AC230KV, line: V.AC115KV, from: {yard: yardId('SE', '230KV'), takeOff: 'new', takeOffVoltage: V.AC115KV}, to: {yard: SC, takeOff: 'new'},
        notes: [/is at AC230KV and SE has no AC115KV yard: new take-offs there carry AC115KV on their circuit \(a secondary \/ auxiliary line\)/,
            /^the sections are energized at AC115KV, below their rated AC230KV/],
    })
    const t0 = after?.takeOffs.find(x => x.substationId === yardId('SE', '230KV'))
    // named with its yard's voltage; its circuit carries 115 kV (checked by verifyLine: takeOffVoltage)
    t.check(!!t0 && /^230KV_SC_L\d+$/.test(t0.lineName), "the auxiliary take-off is named with its yard's 230 kV", t0?.lineName)
})
test('LC-O-3e', 'energized voltage given above a 115 kV yard (no yard at it): refused', t => {
    verifyRefused(t, lineFixture(), spec({from: `Y:${SC}`, to: `Y:${SD}`, voltage: V.AC230KV, energizedVoltage: V.AC230KV}), [/cannot feed a line energized at AC230KV/])
})
test('LC-O-3f', 'energized voltage given above the conductor\'s rating: refused', t => {
    verifyRefused(t, lineFixture(), spec({from: `Y:${SA}`, to: `Y:${SB}`, voltage: V.AC115KV, energizedVoltage: V.AC230KV}), [/above the conductor's rated AC115KV/])
})
test('LC-O-3g', 'energized voltage given of another current type (DC on an AC conductor): refused', t => {
    verifyRefused(t, lineFixture(), spec({from: `Y:${SA}`, to: `Y:${SB}`, voltage: V.AC230KV, energizedVoltage: V.DC300KV}), [/AC and DC do not mix/])
})
test('LC-O-3h', 'energized at 0 V between yards: de-energized, take-offs at their yard\'s voltage, a note', t => {
    verifyLine(t, lineFixture(), spec({from: `Y:${SA}`, to: `Y:${SB}`, voltage: V.AC230KV, energizedVoltage: V.DE_ENERGIZED}), {
        rated: V.AC230KV, line: V.DE_ENERGIZED, from: {yard: SA, takeOff: 'new'}, to: {yard: SB, takeOff: 'new'},
        notes: [/^the sections are de-energized \(0 V\)/],
    })
})
test('LC-O-4a', 'both ends open at junctions: de-energized automatically, a note, no warning', t => {
    verifyLine(t, lineFixture(), spec({from: `J:${junctionId('J1')}`, to: `J:${junctionId('J2')}`, voltage: V.AC230KV}), {
        rated: V.AC230KV, line: V.DE_ENERGIZED, from: {junction: junctionId('J1')}, to: {junction: junctionId('J2')},
        notes: [/^the line starts at/, /^the line ends at/, /^both ends are junctions, so no yard energizes it/],
    })
})
test('LC-O-4b', 'both ends open at junctions, energized at 230 kV on request: refused (nothing feeds it)', t => {
    verifyRefused(t, lineFixture(), spec({from: `J:${junctionId('J1')}`, to: `J:${junctionId('J2')}`, voltage: V.AC230KV, energizedVoltage: V.AC230KV}),
        [/^both ends are open at junctions, so nothing feeds it: it cannot be energized at AC230KV/])
})
test('LC-O-4c', 'both ends open at junctions, 0 V on request: de-energized, no warning', t => {
    verifyLine(t, lineFixture(), spec({from: `J:${junctionId('J1')}`, to: `J:${junctionId('J2')}`, voltage: V.AC230KV, energizedVoltage: V.DE_ENERGIZED}), {
        rated: V.AC230KV, line: V.DE_ENERGIZED, from: {junction: junctionId('J1')}, to: {junction: junctionId('J2')},
        notes: [/^the line starts at/, /^the line ends at/, /^the sections are de-energized \(0 V\)/],
    })
})
test('LC-O-5a', 'one end open at a junction (energized from the yard): a note on the open end, no warning', t => {
    verifyLine(t, lineFixture(), spec({from: `Y:${SA}`, to: `J:${junctionId('J2')}`, voltage: V.AC230KV}), {
        rated: V.AC230KV, line: V.AC230KV, from: {yard: SA, takeOff: 'new'}, to: {junction: junctionId('J2')},
        notes: [/^the line ends at .*: each circuit gets a node of its own there, open/],
    })
})
test('LC-O-5b', 'one end open at a junction, a 115 kV yard below the conductor: runs at 115 kV, notes only', t => {
    verifyLine(t, lineFixture(), spec({from: `J:${junctionId('J1')}`, to: `Y:${SC}`, voltage: V.AC230KV}), {
        rated: V.AC230KV, line: V.AC115KV, from: {junction: junctionId('J1')}, to: {yard: SC, takeOff: 'new'},
        notes: [/^the line starts at/, /they run at AC115KV/],
    })
})
test('LC-O-6', 'yards at two voltages (230 kV and 115 kV) for a 230 kV conductor: refused', t => {
    verifyRefused(t, lineFixture(), spec({from: `Y:${SA}`, to: `Y:${SC}`, voltage: V.AC230KV}), [/the ends are at different voltages/])
})
test('LC-O-7', 'conductor rated below the picked yard, the site has a yard at its rating: refused (pick that one)', t => {
    verifyRefused(t, lineFixture(), spec({from: `Y:${yardId('SH', '230KV')}`, to: `Y:${SC}`, voltage: V.AC115KV}), [/pick its AC115KV yard 115KV/])
})
test('LC-O-8', 'a DC conductor between AC yards: refused', t => {
    verifyRefused(t, lineFixture(), spec({from: `Y:${SA}`, to: `Y:${SB}`, voltage: V.DC300KV}), [/AC and DC do not mix/])
})
test('LC-O-9', 'a free take-off at another voltage than the line is not reused', t => {
    // SE's free take-off toward SC is at SE's 230 kV; the line runs at 115 kV through an auxiliary take-off
    const doc = lineFixture()
    doc.takeOffs.push({id: 'STO_SE_230KV_115KV_SC_L1', name: '115KV_SC_L1', substationId: yardId('SE', '230KV'), lineName: '115KV_SC_L1', takeOffColumn: true})
    verifyLine(t, doc, spec({from: `Y:${yardId('SE', '230KV')}`, to: `Y:${SC}`, voltage: V.AC230KV, energizedVoltage: V.AC115KV}), {
        rated: V.AC230KV, line: V.AC115KV, from: {yard: yardId('SE', '230KV'), takeOff: 'new', takeOffVoltage: V.AC115KV}, to: {yard: SC, takeOff: 'new'},
        notes: [/secondary \/ auxiliary line/, /below their rated AC230KV/],
    })
})
test('LC-O-10', 'both ends in one site (a yard and its site junction): refused', t => {
    verifyRefused(t, lineFixture(), spec({from: `Y:${SA}`, to: `G:${siteId('SA')}`, voltage: V.AC230KV}), [/^both ends belong to the same site/])
})
