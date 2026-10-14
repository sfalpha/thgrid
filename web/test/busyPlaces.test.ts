/**
 * Busy places (docs/testing.md section 3): New line, Route via, Route to and Route from at sites, a site junction and
 * line junctions that already carry lines from de-energized to 500 kV (the busy area of the fixture). Besides where the
 * new or moved sections connect and at what voltage, every case checks that what was there is left exactly as it was:
 * the other lines, their circuits, nodes and take-offs (a new node of its own, never an existing one; take-off and line
 * names numbered past the ones in use).
 */
import {TransmissionVoltage as V} from '@shared/models/transmission.voltage'
import {voltageLabel} from '@shared/models/naming'
import {CIRCUIT_END_FROM, CIRCUIT_END_TO, NetworkDocument} from '@shared/network/records'
import {regenerateNamingOps, RegenerateTarget} from '@shared/network/naming'
import {takeOffVoltage} from '@shared/network/migrate'
import {RouteVia, yardChoices} from '../src/network/routeVia'
import {test} from './harness'
import {G, J, junctionId, lineFixture, QUIET, siteId, Y, yardId} from './fixture'
import {circuitNodes, lineNamed, namesUnique, RouteExpect, spec, validates, verifyLine, verifyRefused, verifyRouteEnd, verifyRouteVia} from './verify'

const MS_JUNCTION = junctionId('MS')
const busy = lineFixture
type Quiet = keyof typeof QUIET

/** The quiet line `q` and its only section. */
function quiet(doc: NetworkDocument, q: Quiet) {
    const line = lineNamed(doc, QUIET[q])
    const circuit = doc.circuits.find(c => c.id === line.circuitIds[0])!
    return {line, circuit, pathId: circuit.pathId!}
}

/* ---------- FX: the busy area itself ---------- */

test('FX-1', 'the busy area: nodes at the junctions, take-offs in the yards, as docs/testing.md lists them', t => {
    const doc = busy()
    validates(t, doc)
    const nodes = (j: string) => doc.connections.filter(c => c.junction.id === j).map(c => `${c.voltage}/${circuitNodes(c).length}`).sort()
    const eqList = (a: string[], b: string[], label: string) => t.check(JSON.stringify([...a].sort()) === JSON.stringify([...b].sort()), label, {actual: a, expected: b})
    eqList(nodes(junctionId('JP')), ['AC230KV/2', 'AC230KV/2'], 'JP: two 230 kV splices')
    eqList(nodes(junctionId('JQ')), ['AC230KV/2', 'AC115KV/1'], 'JQ: a 230 kV splice, a 115 kV open end')
    eqList(nodes(junctionId('JX')), ['AC500KV/2', 'AC230KV/1', 'AC115KV/1', '0V/1'], 'JX: a 500 kV splice, open ends at 230 kV, 115 kV and 0 V')
    eqList(nodes(MS_JUNCTION), ['AC230KV/2', 'AC115KV/1', '0V/1'], 'site junction MS: a 230 kV splice, open ends at 115 kV and 0 V')
    const takeOffs = (code: string, kv: string) => doc.takeOffs.filter(x => x.substationId === yardId(code, kv)).map(x => `${x.lineName}@${takeOffVoltage(doc, x.id)}`).sort()
    eqList(takeOffs('MA', '230KV'), ['230KV_MC_L1@AC230KV', '230KV_MC_L2@AC230KV', '230KV_MC_L3@AC230KV', '230KV_ME_L1@AC230KV'], 'MA 230 kV: three to MC (one de-energized), one to ME')
    eqList(takeOffs('MA', '115KV'), ['115KV_MD_L1@AC115KV', '115KV_MD_L2@AC115KV'], 'MA 115 kV: 115 kV and 230 kV-rated lines to MD')
    eqList(takeOffs('MD', '115KV'), ['115KV_MA_L1@AC115KV', '115KV_MA_L2@AC115KV', '115KV_JQ_L1@AC115KV', '115KV_JX_L1@AC115KV', '115KV_MS_L1@AC115KV'], 'MD 115 kV: five lines')
    eqList(takeOffs('MS', '115KV'), [], 'MS 115 kV: none')
    const kinds = Object.values(QUIET).map(n => {
        const l = lineNamed(doc, n)
        const c = doc.circuits.find(x => x.id === l.circuitIds[0])!
        return `${n}:${c.voltage}/${c.energizedVoltage}`
    })
    eqList(kinds, ['500KV_QA_QB_L1:AC500KV/AC500KV', '230KV_QA_QB_L1:AC230KV/AC230KV', '115KV_QA_QB_L1:AC115KV/AC115KV', '230KV_QA_QB_L2:AC230KV/AC115KV', '230KV_QA_QB_L3:AC230KV/0V'], 'the quiet lines QA-QB')
})

test('FX-2', 'the fixture is named by the rules: regenerating paths, circuits, lines and take-offs changes nothing', t => {
    const doc = busy()
    namesUnique(t, doc)
    const targets: RegenerateTarget[] = [
        ...doc.paths.map(r => ({collection: 'paths' as const, id: r.id})),
        ...doc.circuits.map(r => ({collection: 'circuits' as const, id: r.id})),
        ...doc.lines.map(r => ({collection: 'lines' as const, id: r.id})),
        ...doc.takeOffs.map(r => ({collection: 'takeOffs' as const, id: r.id})),
    ]
    const plan = regenerateNamingOps(doc, targets, {id: true, name: true})
    t.check(plan.changes.length === 0, 'no renames', plan.changes.slice(0, 6))
})

/* ---------- BN: New line at busy places ---------- */

const line230 = {voltage: V.AC230KV}
const nodeNote = (side: 'starts' | 'ends') => new RegExp(`^the line ${side} at .*: each circuit gets a node of its own there`)
const bothOpen = /^both ends are junctions, so no yard energizes it/

test('BN-Y1', 'from the 500 kV yard of a three-yard site (MA) to QB', t => {
    verifyLine(t, busy(), spec({from: Y('MA', '500KV'), to: Y('QB', '500KV'), voltage: V.AC500KV}), {
        rated: V.AC500KV, line: V.AC500KV, from: {yard: yardId('MA', '500KV'), takeOff: 'new'}, to: {yard: yardId('QB', '500KV'), takeOff: 'new'},
    })
})
test('BN-Y2', 'a fourth line MA-MC: shares the path MA-MC that carries the de-energized line (any voltage shares a route), and says so', t => {
    verifyLine(t, busy(), spec({from: Y('MA', '230KV'), to: Y('MC', '230KV'), ...line230}), {
        rated: V.AC230KV, line: V.AC230KV, from: {yard: yardId('MA', '230KV'), takeOff: 'new'}, to: {yard: yardId('MC', '230KV'), takeOff: 'new'},
        notes: [/^MA 230KV → MC 230KV: shares the existing path "MA-MC" \(it carries 0V circuits\)/],
    })
})
test('BN-Y3', 'the same on a new path, by choice: "MA-MC (2)" beside the existing one, said so; the take-offs and the line take L4', t => {
    const doc = busy()
    const after = verifyLine(t, doc, spec({from: Y('MA', '230KV'), to: Y('MC', '230KV'), ...line230, legs: [{createPath: true}]}), {
        rated: V.AC230KV, line: V.AC230KV, from: {yard: yardId('MA', '230KV'), takeOff: 'new'}, to: {yard: yardId('MC', '230KV'), takeOff: 'new'},
        notes: [/^MA 230KV → MC 230KV: a new path "MA-MC \(2\)", beside the existing "MA-MC"/],
    })
    if (!after) return
    const added = after.lines.find(l => !doc.lines.some(x => x.id === l.id))
    t.eq(added?.name, '230KV_MA_MC_L4', 'the line is numbered past L1-L3')
    const names = (y: string) => after.takeOffs.filter(x => x.substationId === y && !doc.takeOffs.some(o => o.id === x.id)).map(x => x.lineName)
    t.eq(names(yardId('MA', '230KV')).join(), '230KV_MC_L4', 'MA take-off numbered past L1-L3')
    t.eq(names(yardId('MC', '230KV')).join(), '230KV_MA_L4', 'MC take-off numbered past L1-L3')
    namesUnique(t, after)
})
test('BN-Y4', 'a 230 kV conductor from the busy 115 kV yard MD to QB: runs at 115 kV, a note', t => {
    verifyLine(t, busy(), spec({from: Y('MD', '115KV'), to: Y('QB', '115KV'), ...line230}), {
        rated: V.AC230KV, line: V.AC115KV, from: {yard: yardId('MD', '115KV'), takeOff: 'new'}, to: {yard: yardId('QB', '115KV'), takeOff: 'new'},
        notes: [/they run at AC115KV/],
    })
})
test('BN-Y5', 'the 500 kV yard of MA picked for a 230 kV line: refused (pick its 230 kV yard)', t => {
    verifyRefused(t, busy(), spec({from: Y('MA', '500KV'), to: Y('QB', '230KV'), ...line230}), [/MA 500KV is at AC500KV, the line runs at AC230KV: pick its AC230KV yard 230KV/])
})
test('BN-Y6', 'from the empty 115 kV yard of MS to MD, which already has a line to the site junction of MS: numbered L2', t => {
    const doc = busy()
    const after = verifyLine(t, doc, spec({from: Y('MS', '115KV'), to: Y('MD', '115KV'), voltage: V.AC115KV}), {
        rated: V.AC115KV, line: V.AC115KV, from: {yard: yardId('MS', '115KV'), takeOff: 'new'}, to: {yard: yardId('MD', '115KV'), takeOff: 'new'},
        // the path MD-MS (to the site junction of MS) is shared: it runs the other way
        notes: [/^MS 115KV → MD 115KV: shares the existing path "MD-MS"$/, /^the existing path "MD-MS" runs .*: the sections on it follow its direction/],
    })
    if (!after) return
    t.eq(after.lines.find(l => !doc.lines.some(x => x.id === l.id))?.name, '115KV_MS_MD_L2', 'L1 is taken by 115KV_MD_MS_L1 (the same name, between MD and the site junction of MS)')
    t.eq(after.takeOffs.find(x => x.substationId === yardId('MD', '115KV') && !doc.takeOffs.some(o => o.id === x.id))?.lineName, '115KV_MS_L2', 'MD take-off numbered past 115KV_MS_L1')
})
for (const [id, title, from, kv, rated, junction] of [
    ['BN-J1', 'from QA to JX (nodes at 500, 230, 115 kV and 0 V), 230 kV: a node of its own', Y('QA', '230KV'), '230KV', V.AC230KV, 'JX'],
    ['BN-J2', 'from QA to JX, 500 kV: a node of its own', Y('QA', '500KV'), '500KV', V.AC500KV, 'JX'],
    ['BN-J3', 'from QA to JQ (230 and 115 kV nodes), 115 kV: a node of its own, not the 115 kV open end', Y('QA', '115KV'), '115KV', V.AC115KV, 'JQ'],
] as const) {
    test(id, title, t => {
        verifyLine(t, busy(), spec({from, to: J(junction), voltage: rated}), {
            rated, line: rated, from: {yard: yardId('QA', kv), takeOff: 'new'}, to: {junction: junctionId(junction)}, notes: [nodeNote('ends')],
        })
    })
}
test('BN-J4', 'between two busy junctions, JX to JQ: de-energized, nodes of their own', t => {
    verifyLine(t, busy(), spec({from: J('JX'), to: J('JQ'), ...line230}), {
        rated: V.AC230KV, line: V.DE_ENERGIZED, from: {junction: junctionId('JX')}, to: {junction: junctionId('JQ')}, notes: [nodeNote('starts'), nodeNote('ends'), bothOpen],
    })
})
test('BN-J5', 'from JP (230 kV only) to the busy site junction of MS: de-energized, nodes of their own', t => {
    verifyLine(t, busy(), spec({from: J('JP'), to: G('MS'), ...line230}), {
        rated: V.AC230KV, line: V.DE_ENERGIZED, from: {junction: junctionId('JP')}, to: {siteJunction: siteId('MS')}, notes: [nodeNote('starts'), nodeNote('ends'), bothOpen],
    })
})
for (const [id, kv, rated] of [['BN-S1', '230KV', V.AC230KV], ['BN-S2', '115KV', V.AC115KV]] as const) {
    test(id, `from QA to the busy site junction of MS (230, 115 kV and 0 V nodes), ${voltageLabel(rated)}: a node of its own`, t => {
        verifyLine(t, busy(), spec({from: Y('QA', kv), to: G('MS'), voltage: rated}), {
            rated, line: rated, from: {yard: yardId('QA', kv), takeOff: 'new'}, to: {siteJunction: siteId('MS')}, notes: [nodeNote('ends')],
        })
    })
}
for (const [id, title, kv, rated, vias, energized] of [
    ['BN-V1', 'QA to QB via JX, 230 kV: spliced in a node of its own', '230KV', V.AC230KV, [{junctionId: junctionId('JX')}], undefined],
    ['BN-V2', 'QA to QB via JP (230 kV only), 500 kV: spliced in a node of its own', '500KV', V.AC500KV, [{junctionId: junctionId('JP')}], undefined],
    ['BN-V3', 'QA to QB via the site MS, 115 kV: a node of its own beside the 115 kV open end', '115KV', V.AC115KV, [{groupId: siteId('MS')}], undefined],
    ['BN-V4', 'QA to QB via JX, JQ and the site MS, 230 kV: four sections, a node of its own at each', '230KV', V.AC230KV, [{junctionId: junctionId('JX')}, {junctionId: junctionId('JQ')}, {groupId: siteId('MS')}], undefined],
    ['BN-V5', 'QA to QB via JP, de-energized: a 0 V node of its own', '230KV', V.AC230KV, [{junctionId: junctionId('JP')}], V.DE_ENERGIZED],
] as const) {
    test(id, title, t => {
        const line = energized ?? rated
        verifyLine(t, busy(), spec({from: Y('QA', kv), to: Y('QB', kv), voltage: rated, energizedVoltage: energized, vias: [...vias]}), {
            rated, line, from: {yard: yardId('QA', kv), takeOff: 'new'}, to: {yard: yardId('QB', kv), takeOff: 'new'},
            vias: vias.map(v => 'junctionId' in v ? {junction: v.junctionId!} : {siteJunction: v.groupId!}),
            notes: [
                ...(energized === V.DE_ENERGIZED ? [/^the sections are de-energized \(0 V\)/] : []),
                // JQ → MS reuses the path MS-JQ of the 230 kV line MS-ME, which runs the other way
                ...(id === 'BN-V4' ? [/^Junction JQ → Junction MS: shares the existing path "MS-JQ"$/, /^the existing path "MS-JQ" runs .*: the sections on it follow its direction/] : []),
            ],
        })
    })
}

/* ---------- BV: Route via busy places ---------- */

const viaJ = (name: string): RouteVia => ({kind: 'junction', junctionId: junctionId(name)})
const viaS = (code: string): RouteVia => ({kind: 'siteJunction', groupId: siteId(code)})
const viaY = (code: string, kv: string): RouteVia => ({kind: 'yard', yardId: yardId(code, kv)})
const notAt = (code: string, kv: string, v: string) => new RegExp(`yard ${code} ${kv}: not at ${v} \\(the voltage the circuits are energized at\\)`)

for (const [id, title, q, via, exp] of [
    ['BV-J1', '230 kV via JX: a 230 kV node of its own beside the 230 kV open end', 'q230', viaJ('JX'), {node: V.AC230KV}],
    ['BV-J2', '500 kV via JX: a node of its own beside the 500 kV splice', 'q500', viaJ('JX'), {node: V.AC500KV}],
    ['BV-J3', '230 kV-rated at 115 kV via JX: a 115 kV node of its own beside the 115 kV open end', 'q230at115', viaJ('JX'), {node: V.AC115KV}],
    ['BV-J4', 'de-energized via JX: a 0 V node of its own beside the 0 V open end', 'q0', viaJ('JX'), {node: V.DE_ENERGIZED}],
    ['BV-J5', '115 kV via JQ, its path shared with the 230 kV-rated line: that one stays', 'q115', viaJ('JQ'), {node: V.AC115KV}],
    ['BV-J6', '500 kV via JP (230 kV only): a 500 kV node of its own', 'q500', viaJ('JP'), {node: V.AC500KV}],
    ['BV-S1', '230 kV via the site junction of MS: a node of its own beside the 230 kV splice', 'q230', viaS('MS'), {node: V.AC230KV}],
    ['BV-S2', '115 kV via the site junction of MS: a node of its own beside the 115 kV open end', 'q115', viaS('MS'), {node: V.AC115KV}],
    ['BV-S3', 'de-energized via the site junction of MS: a 0 V node of its own beside the 0 V open end', 'q0', viaS('MS'), {node: V.DE_ENERGIZED}],
    ['BV-Y1', '230 kV into the 230 kV yard of MA (four lines there)', 'q230', viaY('MA', '230KV'), {yard: yardId('MA', '230KV'), voltage: V.AC230KV}],
    ['BV-Y2', '500 kV into the 500 kV yard of MA', 'q500', viaY('MA', '500KV'), {yard: yardId('MA', '500KV'), voltage: V.AC500KV}],
    ['BV-Y3', '115 kV into MD (five lines in its 115 kV yard)', 'q115', viaY('MD', '115KV'), {yard: yardId('MD', '115KV'), voltage: V.AC115KV}],
    ['BV-Y4', '230 kV-rated at 115 kV into the 115 kV yard of MA', 'q230at115', viaY('MA', '115KV'), {yard: yardId('MA', '115KV'), voltage: V.AC115KV}],
    ['BV-Y5', '500 kV into the 500 kV yard of ME (500 / 230 kV)', 'q500', viaY('ME', '500KV'), {yard: yardId('ME', '500KV'), voltage: V.AC500KV}],
    ['BV-Y6', '230 kV into the 230 kV yard of ME', 'q230', viaY('ME', '230KV'), {yard: yardId('ME', '230KV'), voltage: V.AC230KV}],
    ['BV-R1', '230 kV-rated at 115 kV into the 230 kV yard of MA: refused', 'q230at115', viaY('MA', '230KV'), {refused: notAt('MA', '230KV', 'AC115KV')}],
    ['BV-R2', '500 kV into MC (230 kV only): refused', 'q500', viaY('MC', '230KV'), {refused: notAt('MC', '230KV', 'AC500KV')}],
    ['BV-R3', 'de-energized (230 kV-rated) into MB (500 kV, beyond its rating): refused', 'q0', viaY('MB', '500KV'), {refused: /yard MB 500KV: beyond the rating of the de-energized .* \(AC230KV\)/}],
    ['BV-R4', '115 kV into MB (500 kV only): refused', 'q115', viaY('MB', '500KV'), {refused: notAt('MB', '500KV', 'AC115KV')}],
] as const) {
    test(id, title, t => verifyRouteVia(t, busy(), QUIET[q], via, exp as RouteExpect))
}

/** The yards each quiet line may be looped into, per busy site: only the yard at the voltage it runs at (none for 0 V). */
const OFFERED: Record<Quiet, Record<string, string[]>> = {
    q500: {MA: ['500KV'], MB: ['500KV'], MC: [], MD: [], ME: ['500KV'], MS: []},
    q230: {MA: ['230KV'], MB: [], MC: ['230KV'], MD: [], ME: ['230KV'], MS: ['230KV']},
    q115: {MA: ['115KV'], MB: [], MC: [], MD: ['115KV'], ME: [], MS: ['115KV']},
    q230at115: {MA: ['115KV'], MB: [], MC: [], MD: ['115KV'], ME: [], MS: ['115KV']},
    q0: {MA: ['115KV', '230KV'], MB: [], MC: ['230KV'], MD: ['115KV'], ME: ['230KV'], MS: ['115KV', '230KV']},
}
test('BV-C', 'the yards offered to each quiet line at each busy site (yardChoices)', t => {
    const doc = busy()
    for (const q of Object.keys(OFFERED) as Quiet[]) {
        const {circuit} = quiet(doc, q)
        for (const [code, yards] of Object.entries(OFFERED[q])) {
            const ok = yardChoices(doc, siteId(code), [circuit]).filter(c => !c.reason).map(c => c.yard.yardName)
            t.eq(ok.join(), yards.join(), `${QUIET[q]} at ${code}`)
        }
    }
})

/* ---------- BT / BF: Route to / Route from busy places ---------- */

for (const [id, title, q, end, target, exp] of [
    ['BT-J1', '230 kV to JX: an open 230 kV node of its own beside the 230 kV open end', 'q230', CIRCUIT_END_TO, viaJ('JX'), {node: V.AC230KV}],
    ['BT-J2', '500 kV to JX', 'q500', CIRCUIT_END_TO, viaJ('JX'), {node: V.AC500KV}],
    ['BT-J3', 'de-energized to JX: a 0 V node of its own', 'q0', CIRCUIT_END_TO, viaJ('JX'), {node: V.DE_ENERGIZED}],
    ['BT-J4', '230 kV-rated at 115 kV to JQ: a 115 kV node of its own beside the 115 kV open end', 'q230at115', CIRCUIT_END_TO, viaJ('JQ'), {node: V.AC115KV}],
    ['BT-S1', '115 kV to the site junction of MS', 'q115', CIRCUIT_END_TO, viaS('MS'), {node: V.AC115KV}],
    ['BT-Y1', '230 kV to the 230 kV yard of MA', 'q230', CIRCUIT_END_TO, viaY('MA', '230KV'), {yard: yardId('MA', '230KV'), voltage: V.AC230KV}],
    ['BT-Y2', '230 kV-rated at 115 kV to MD (115 kV, five lines)', 'q230at115', CIRCUIT_END_TO, viaY('MD', '115KV'), {yard: yardId('MD', '115KV'), voltage: V.AC115KV}],
    ['BT-Y3', '500 kV to MB (500 kV only)', 'q500', CIRCUIT_END_TO, viaY('MB', '500KV'), {yard: yardId('MB', '500KV'), voltage: V.AC500KV}],
    ['BT-R1', '230 kV-rated at 115 kV to the 230 kV yard of MA: refused', 'q230at115', CIRCUIT_END_TO, viaY('MA', '230KV'), {refused: notAt('MA', '230KV', 'AC115KV')}],
    ['BT-R2', 'de-energized (230 kV-rated) to MB (500 kV, beyond its rating): refused', 'q0', CIRCUIT_END_TO, viaY('MB', '500KV'), {refused: /yard MB 500KV: beyond the rating of the de-energized/}],
    ['BF-J1', '230 kV from JX: the line now starts at a node of its own there', 'q230', CIRCUIT_END_FROM, viaJ('JX'), {node: V.AC230KV}],
    ['BF-J2', '500 kV from JP (230 kV only)', 'q500', CIRCUIT_END_FROM, viaJ('JP'), {node: V.AC500KV}],
    ['BF-S1', '230 kV from the site junction of MS', 'q230', CIRCUIT_END_FROM, viaS('MS'), {node: V.AC230KV}],
    ['BF-Y1', '115 kV from MD (five lines in its yard)', 'q115', CIRCUIT_END_FROM, viaY('MD', '115KV'), {yard: yardId('MD', '115KV'), voltage: V.AC115KV}],
    ['BF-Y2', '500 kV from the 500 kV yard of ME', 'q500', CIRCUIT_END_FROM, viaY('ME', '500KV'), {yard: yardId('ME', '500KV'), voltage: V.AC500KV}],
    ['BF-R1', '115 kV from the 230 kV yard of ME: refused', 'q115', CIRCUIT_END_FROM, viaY('ME', '230KV'), {refused: notAt('ME', '230KV', 'AC115KV')}],
] as const) {
    test(id, title, t => verifyRouteEnd(t, busy(), QUIET[q], end, target, exp as RouteExpect))
}

/* ---------- de-energized circuits into a yard: within the rating, warned ---------- */

const enters = (yard: string, v: string) => new RegExp(`^230KV_QA_QB_L3.* is de-energized \\(0 V\\): entering yard ${yard} at ${v}, it stays de-energized; the take-offs are at the yard's voltage`)

test('BV-Y7', 'de-energized into the 230 kV yard of MA: allowed, warned; it stays 0 V, its take-offs at 230 kV', t => {
    verifyRouteVia(t, busy(), QUIET.q0, viaY('MA', '230KV'), {yard: yardId('MA', '230KV'), voltage: V.AC230KV, takeOffs: ['230KV_QA_L1', '230KV_QB_L1']}, {warnings: [enters('MA 230KV', 'AC230KV')]})
})
test('BV-Y8', 'de-energized (230 kV-rated) into the 115 kV yard of MA, below its rating: allowed, warned', t => {
    verifyRouteVia(t, busy(), QUIET.q0, viaY('MA', '115KV'), {yard: yardId('MA', '115KV'), voltage: V.AC115KV, takeOffs: ['115KV_QA_L1', '115KV_QB_L1']}, {warnings: [enters('MA 115KV', 'AC115KV')]})
})
test('BT-Y4', 'de-energized to the 230 kV yard of MC: allowed, warned; a take-off at 230 kV', t => {
    verifyRouteEnd(t, busy(), QUIET.q0, CIRCUIT_END_TO, viaY('MC', '230KV'), {yard: yardId('MC', '230KV'), voltage: V.AC230KV, takeOffs: ['230KV_QA_L1']},
        {warnings: [enters('MC 230KV', 'AC230KV'), /^take-off .* is left without a circuit \(kept\)/]})
})
