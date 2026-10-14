/**
 * The other map operations (docs/testing.md section 5): Create circuit, Create path, Form a line, Route via and Route
 * to / from on the base fixture. The expected results are what the code gives today (to be refined); each case also
 * checks that the result validates and that what was there and is not part of the operation is left as it was.
 */
import {TransmissionVoltage as V} from '@shared/models/transmission.voltage'
import {genericConductor} from '@shared/models/transmission.conductor'
import {voltageLabel} from '@shared/models/naming'
import {applyOps} from '@shared/network/ops'
import {
    CIRCUIT_END_FROM,
    CIRCUIT_END_TO,
    ConnectionJunctionKind,
    ConnectionJunctionRef,
    NetworkDocument,
    TransmissionLineRecord,
} from '@shared/network/records'
import {buildCircuitGraph, FormedLine, formedLineVoltageOps, formLine, lineEndCandidates, lineStatus} from '@shared/network/lines'
import {defaultNamingFor, lineNameVoltage, lineNaming} from '@shared/network/naming'
import {circuitEndConnection, connectionVoltage} from '@shared/network/migrate'
import {buildNewCircuitPlan, NewCircuitEndSpec, NewCircuitSpec} from '../src/network/circuitWizard'
import {buildNewLinePlan, NewLineSpec} from '../src/network/lineWizard'
import {buildNewPathPlan} from '../src/network/newPath'
import {RouteVia, yardChoices} from '../src/network/routeVia'
import {Checker, test} from './harness'
import {G, J, junctionId, lineFixture, siteId, Y, yardId} from './fixture'
import {circuitNodes, lineNamed, matchSet, namesUnique, newConnections, spec, unchangedExcept, validates, verifyRouteEnd, verifyRouteVia} from './verify'

const base = lineFixture
const conductor = genericConductor()
const site = (code: string): ConnectionJunctionRef => ({kind: ConnectionJunctionKind.SUBSTATION_GROUP, id: siteId(code)})
const yard = (code: string, kv: string): ConnectionJunctionRef => ({kind: ConnectionJunctionKind.SUBSTATION, id: yardId(code, kv)})
const junction = (name: string): ConnectionJunctionRef => ({kind: ConnectionJunctionKind.TRANSMISSION_JUNCTION, id: junctionId(name)})

/** `doc` with a line made by the line wizard. */
function withLine(doc: NetworkDocument, s: Partial<NewLineSpec>): NetworkDocument {
    const plan = buildNewLinePlan(doc, spec(s))
    if (plan.errors.length) throw new Error(`setup line: ${plan.errors.join('; ')}`)
    return applyOps(doc, plan.ops)
}
const SA_SB = {from: Y('SA', '230KV'), to: Y('SB', '230KV'), voltage: V.AC230KV}

/* ---------- CC: Create circuit (buildNewCircuitPlan) ---------- */

/** Where a circuit end is expected: a yard (through a new take-off, or that existing one), or a node at a junction (a new one of its own, or that existing one). */
type CircuitEndExpect = { yard: string; voltage: V; takeOff?: string } | { node: string; voltage: V; joins?: string }

interface CircuitExpect {
    rated: V
    energized: V
    from: CircuitEndExpect
    to: CircuitEndExpect
    reversed?: boolean
    /** The plan's warnings and notes, each matched by exactly these patterns. */
    warnings?: RegExp[]
    notes?: RegExp[]
}

const at = (place: string, connect?: NewCircuitEndSpec['connect']): NewCircuitEndSpec => ({place, ...(connect ? {connect} : {})})

function verifyCircuit(t: Checker, doc: NetworkDocument, s: Partial<NewCircuitSpec> & Pick<NewCircuitSpec, 'from' | 'to'>, exp: CircuitExpect) {
    const plan = buildNewCircuitPlan(doc, {voltage: V.AC230KV, bundle: 1, conductor, ...s})
    t.check(plan.errors.length === 0, 'the plan has no errors', plan.errors)
    if (plan.errors.length || !plan.circuit) return
    const after = applyOps(doc, plan.ops)
    validates(t, after)
    namesUnique(t, after)
    const joined = [exp.from, exp.to].flatMap(e => 'joins' in e && e.joins ? [e.joins] : [])
    unchangedExcept(t, doc, after, new Set(joined))
    matchSet(t, 'warnings', plan.warnings, exp.warnings ?? [])
    matchSet(t, 'notes', plan.notes, exp.notes ?? [])
    const c = after.circuits.find(x => x.id === plan.circuit!.id)!
    t.eq(c.voltage, exp.rated, 'rated voltage')
    t.eq(c.energizedVoltage, exp.energized, 'energized voltage')
    t.eq(!!plan.reversed, !!exp.reversed, 'runs the other way (follows the path)')
    for (const [e, side] of [[exp.from, CIRCUIT_END_FROM], [exp.to, CIRCUIT_END_TO]] as const) {
        const conn = circuitEndConnection(after, c.id, side)
        if ('yard' in e) {
            t.check(conn?.junction.kind === ConnectionJunctionKind.SUBSTATION && conn.junction.id === e.yard, `${side}: in yard ${e.yard}`, conn?.junction)
            if (!conn) continue
            t.eq(connectionVoltage(after, conn), e.voltage, `${side}: connection voltage`)
            const takeOff = conn.nodes.find(n => n.kind === 'SUBSTATION_TAKE_OFF')
            if (e.takeOff) t.eq(takeOff?.id, e.takeOff, `${side}: the existing take-off`)
            else t.check(!!takeOff && !doc.takeOffs.some(x => x.id === takeOff.id), `${side}: a new take-off`, takeOff?.id)
        } else {
            t.check(conn?.junction.kind === ConnectionJunctionKind.TRANSMISSION_JUNCTION && conn.junction.id === e.node, `${side}: at junction ${e.node}`, conn?.junction)
            if (!conn) continue
            t.eq(conn.voltage, e.voltage, `${side}: node voltage`)
            if (e.joins) t.eq(conn.id, e.joins, `${side}: joins the existing node`)
            else t.check(!doc.connections.some(x => x.id === conn.id) && circuitNodes(conn).length === 1, `${side}: a node of its own`, conn.id)
        }
    }
}

/** An open end is a note (not a voltage mismatch); both ends open yet energized stays a warning. */
const openEnd = (side: 'FROM' | 'TO') => new RegExp(`^the ${side} end is open: a node of its own at`)
const sharesPath = (name: string) => new RegExp(`^shares the existing path "${name}"`)
const belowRating = /^energized at AC115KV, below its rated AC230KV/
const SA230 = yardId('SA', '230KV'), SB230 = yardId('SB', '230KV')

test('CC-E-1', 'site to site, default connections: new take-offs, 230 kV, nothing reported', t => {
    verifyCircuit(t, base(), {from: at(G('SA').replace('G:', 'G:')), to: at(G('SB'))}, {
        rated: V.AC230KV, energized: V.AC230KV, from: {yard: SA230, voltage: V.AC230KV}, to: {yard: SB230, voltage: V.AC230KV},
    })
})
test('CC-E-2', 'site junction ST (a node of its own) to line junction J2: open both ends, 0 V', t => {
    verifyCircuit(t, base(), {from: at(G('ST'), {kind: 'junction'}), to: at(J('J2'))}, {
        rated: V.AC230KV, energized: V.DE_ENERGIZED, from: {node: junctionId('ST'), voltage: V.DE_ENERGIZED}, to: {node: junctionId('J2'), voltage: V.DE_ENERGIZED},
        notes: [openEnd('FROM'), openEnd('TO'), /^both ends are open: the circuit is de-energized \(0 V\) until it is connected/],
    })
})
test('CC-E-3', 'on an existing path running the other way: the circuit follows it, FROM and TO swapped', t => {
    const doc = applyOps(base(), [{type: 'upsert', collection: 'paths', record: {id: 'TPA_SB_SA', name: 'SB-SA', from: site('SB'), to: site('SA'), waypoints: []}}])
    verifyCircuit(t, doc, {from: at(G('SA')), to: at(G('SB'))}, {
        rated: V.AC230KV, energized: V.AC230KV, from: {yard: SB230, voltage: V.AC230KV}, to: {yard: SA230, voltage: V.AC230KV}, reversed: true,
        notes: [/^shares the existing path "SB-SA", which runs SB → SA: the circuit follows its direction \(FROM and TO swapped\)/],
    })
})
test('CC-O-1', '230 kV conductor between 115 kV-only sites: 115 kV, a warning (below the rating)', t => {
    verifyCircuit(t, base(), {from: at(G('SC')), to: at(G('SD'))}, {
        rated: V.AC230KV, energized: V.AC115KV, from: {yard: yardId('SC', '115KV'), voltage: V.AC115KV}, to: {yard: yardId('SD', '115KV'), voltage: V.AC115KV}, warnings: [belowRating],
    })
})
test('CC-O-2', 'energized 115 kV given, SH (230 and 115 kV) to SC: the 115 kV yard by default', t => {
    verifyCircuit(t, base(), {from: at(G('SH')), to: at(G('SC')), energizedVoltage: V.AC115KV}, {
        rated: V.AC230KV, energized: V.AC115KV, from: {yard: yardId('SH', '115KV'), voltage: V.AC115KV}, to: {yard: yardId('SC', '115KV'), voltage: V.AC115KV}, warnings: [belowRating],
    })
})
test('CC-O-3', 'energized 115 kV given, a new take-off picked in the 230 kV yard of SH: allowed, warned', t => {
    verifyCircuit(t, base(), {from: at(G('SH'), {kind: 'newTakeOff', yardId: yardId('SH', '230KV')}), to: at(G('SC')), energizedVoltage: V.AC115KV}, {
        rated: V.AC230KV, energized: V.AC115KV, from: {yard: yardId('SH', '230KV'), voltage: V.AC230KV}, to: {yard: yardId('SC', '115KV'), voltage: V.AC115KV},
        warnings: [/^the FROM end: SH 230KV · new take-off .* is at AC230KV, the circuit is energized at AC115KV/, belowRating],
    })
})
const auxiliary = (at: string) => new RegExp(`^${at} · new take-off .*: its circuit is set to AC115KV, below the yard's AC230KV \\(a secondary / auxiliary line\\)`)
test('CC-O-4', 'energized 115 kV given, a new take-off at SE (230 kV only): an auxiliary take-off at 115 kV, as the line wizard makes it; warned', t => {
    verifyCircuit(t, base(), {from: at(G('SE'), {kind: 'newTakeOff', yardId: yardId('SE', '230KV')}), to: at(G('SC')), energizedVoltage: V.AC115KV}, {
        rated: V.AC230KV, energized: V.AC115KV, from: {yard: yardId('SE', '230KV'), voltage: V.AC115KV}, to: {yard: yardId('SC', '115KV'), voltage: V.AC115KV},
        warnings: [auxiliary('SE 230KV'), belowRating],
    })
})
test('CC-O-5', 'energized 115 kV given, the free 230 kV take-off of SF toward SB: allowed, warned; the new take-off at SB (230 kV only) auxiliary', t => {
    verifyCircuit(t, base(), {from: at(G('SF'), {kind: 'takeOff', takeOffId: 'STO_SF_230KV_230KV_SB_L1'}), to: at(G('SB')), energizedVoltage: V.AC115KV}, {
        rated: V.AC230KV, energized: V.AC115KV, from: {yard: yardId('SF', '230KV'), voltage: V.AC230KV, takeOff: 'STO_SF_230KV_230KV_SB_L1'}, to: {yard: SB230, voltage: V.AC115KV},
        warnings: [/^the FROM end: take-off 230KV_SB_L1 is at AC230KV, the circuit is energized at AC115KV/, auxiliary('SB 230KV'), belowRating],
    })
})
test('CC-O-6', 'energized 115 kV given, joining a node whose circuits run at 230 kV: allowed, warned; the node stays 230 kV', t => {
    const doc = withLine(base(), {...SA_SB, vias: [{junctionId: junctionId('J3')}]})
    const node = doc.connections.find(c => c.junction.id === junctionId('J3'))!
    verifyCircuit(t, doc, {from: at(J('J3'), {kind: 'junction', connectionId: node.id}), to: at(G('SC')), energizedVoltage: V.AC115KV}, {
        rated: V.AC230KV, energized: V.AC115KV, from: {node: junctionId('J3'), voltage: V.AC230KV, joins: node.id}, to: {yard: yardId('SC', '115KV'), voltage: V.AC115KV},
        warnings: [/^the FROM end: node J3_1 runs at AC230KV, the circuit is energized at AC115KV/, belowRating],
    })
})
test('CC-O-7', 'ends at two voltages, none given: energized at the FROM yard, the TO end warned', t => {
    verifyCircuit(t, base(), {from: at(G('SA')), to: at(G('SC'))}, {
        rated: V.AC230KV, energized: V.AC230KV, from: {yard: SA230, voltage: V.AC230KV}, to: {yard: yardId('SC', '115KV'), voltage: V.AC115KV},
        warnings: [/^the TO end: SC 115KV · new take-off .* is at AC115KV, the circuit is energized at AC230KV/],
    })
})
test('CC-O-8a', 'energized above the rating: allowed, warned', t => {
    verifyCircuit(t, base(), {from: at(G('SA')), to: at(G('SB')), voltage: V.AC115KV, energizedVoltage: V.AC230KV}, {
        rated: V.AC115KV, energized: V.AC230KV, from: {yard: SA230, voltage: V.AC230KV}, to: {yard: SB230, voltage: V.AC230KV},
        warnings: [/^energized at AC230KV, above its rated AC115KV/],
    })
})
test('CC-O-8b', 'energized DC on an AC conductor: allowed, warned', t => {
    verifyCircuit(t, base(), {from: at(G('SA')), to: at(G('SB')), energizedVoltage: V.DC300KV}, {
        rated: V.AC230KV, energized: V.DC300KV, from: {yard: SA230, voltage: V.AC230KV}, to: {yard: SB230, voltage: V.AC230KV},
        warnings: [/^the FROM end: .* is at AC230KV, the circuit is energized at DC300KV/, /^the TO end: .* is at AC230KV, the circuit is energized at DC300KV/, /AC and DC do not mix/],
    })
})
test('CC-O-9a', 'both ends open: 0 V automatically', t => {
    verifyCircuit(t, base(), {from: at(J('J1')), to: at(J('J2'))}, {
        rated: V.AC230KV, energized: V.DE_ENERGIZED, from: {node: junctionId('J1'), voltage: V.DE_ENERGIZED}, to: {node: junctionId('J2'), voltage: V.DE_ENERGIZED},
        notes: [openEnd('FROM'), openEnd('TO'), /^both ends are open: the circuit is de-energized/],
    })
})
test('CC-O-9b', 'both ends open, energized 230 kV given: warned (nothing feeds it)', t => {
    verifyCircuit(t, base(), {from: at(J('J1')), to: at(J('J2')), energizedVoltage: V.AC230KV}, {
        rated: V.AC230KV, energized: V.AC230KV, from: {node: junctionId('J1'), voltage: V.AC230KV}, to: {node: junctionId('J2'), voltage: V.AC230KV},
        warnings: [/^both ends are open, yet it is energized at AC230KV: nothing feeds it/], notes: [openEnd('FROM'), openEnd('TO')],
    })
})
test('CC-O-9c', 'both ends open, 0 V given: a note', t => {
    verifyCircuit(t, base(), {from: at(J('J1')), to: at(J('J2')), energizedVoltage: V.DE_ENERGIZED}, {
        rated: V.AC230KV, energized: V.DE_ENERGIZED, from: {node: junctionId('J1'), voltage: V.DE_ENERGIZED}, to: {node: junctionId('J2'), voltage: V.DE_ENERGIZED},
        notes: [openEnd('FROM'), openEnd('TO'), /^de-energized \(0 V\)/],
    })
})
test('CC-O-10', 'one end open: energized from the yard, the open end a note (as in the line wizard)', t => {
    verifyCircuit(t, base(), {from: at(G('SA')), to: at(J('J2'))}, {
        rated: V.AC230KV, energized: V.AC230KV, from: {yard: SA230, voltage: V.AC230KV}, to: {node: junctionId('J2'), voltage: V.AC230KV}, notes: [openEnd('TO')],
    })
})
test('CC-O-11', 'joining a node whose circuits run at the same voltage: a note, no warning', t => {
    const doc = withLine(base(), {...SA_SB, vias: [{junctionId: junctionId('J3')}]})
    const node = doc.connections.find(c => c.junction.id === junctionId('J3'))!
    verifyCircuit(t, doc, {from: at(J('J3'), {kind: 'junction', connectionId: node.id}), to: at(G('SB'))}, {
        rated: V.AC230KV, energized: V.AC230KV, from: {node: junctionId('J3'), voltage: V.AC230KV, joins: node.id}, to: {yard: SB230, voltage: V.AC230KV},
        notes: [/^the FROM end joins .* at node J3_1, all at AC230KV/, sharesPath('J3-SB')],
    })
})

/* ---------- CP: Create path (buildNewPathPlan) ---------- */

test('CP-1', 'between sites, a site and a line junction, two junctions: the rule name, no circuits', t => {
    const doc = base()
    for (const [from, to, name, id] of [
        [site('SA'), site('SB'), 'SA-SB', 'TPA_SA_SB'],
        [yard('SA', '230KV'), junction('J1'), 'SA-J1', 'TPA_SA_J1'],
        [junction('J1'), junction('J2'), 'J1-J2', 'TPA_J1_J2'],
        [junction('ST'), site('SB'), 'ST-SB', 'TPA_ST_SB'],
    ] as const) {
        const plan = buildNewPathPlan(doc, from, to)
        t.check(plan.errors.length === 0 && plan.record?.name === name && plan.record.id === id, `${name}`, {errors: plan.errors, record: plan.record})
    }
    const p = buildNewPathPlan(doc, yard('SA', '230KV'), junction('ST'))
    t.check(p.record?.from?.kind === ConnectionJunctionKind.SUBSTATION_GROUP && p.record.from.id === siteId('SA') && p.record.to?.kind === ConnectionJunctionKind.SUBSTATION_GROUP && p.record.to.id === siteId('ST'),
        'a yard and a site junction stand for their sites', p.record)
    t.check(!!p.record && p.record.waypoints.length === 0 && !('voltage' in p.record), 'no waypoints, no voltage', p.record)
    const after = applyOps(doc, [{type: 'upsert', collection: 'paths', record: p.record!}])
    validates(t, after)
    unchangedExcept(t, doc, after)
})
test('CP-2', 'both ends the same place (a site and its junction or yard count as one): refused', t => {
    const doc = base()
    for (const [from, to, label] of [[site('ST'), junction('ST'), 'ST and its junction'], [site('SA'), yard('SA', '230KV'), 'SA and its yard']] as const) {
        const plan = buildNewPathPlan(doc, from, to)
        t.check(plan.same && plan.errors.includes('both ends are the same place') && !plan.record, label, plan)
    }
    t.check(buildNewPathPlan(doc, site('SA'), undefined).errors.includes('pick both ends'), 'one end missing: refused')
})
test('CP-3', 'a path already runs between the places: listed, the new one numbered', t => {
    const doc = applyOps(base(), [{type: 'upsert', collection: 'paths', record: {id: 'TPA_SA_SB', name: 'SA-SB', from: site('SA'), to: site('SB'), waypoints: []}}])
    const plan = buildNewPathPlan(doc, site('SA'), site('SB'))
    t.eq(plan.existing.map(p => p.id).join(), 'TPA_SA_SB', 'the existing path is listed')
    t.check(plan.errors.length === 0 && plan.record?.name === 'SA-SB (2)' && plan.record.id === 'TPA_SA_SB_2', 'created, numbered', plan.record)
    const back = buildNewPathPlan(doc, site('SB'), site('SA'))
    t.eq(back.existing.map(p => p.id).join(), 'TPA_SA_SB', 'also listed the other way round')
    t.check(back.record?.name === 'SB-SA', 'the other way round: SB-SA', back.record)
})
test('CP-4', 'swapping the ends exchanges them and the name', t => {
    const plan = buildNewPathPlan(base(), site('SB'), junction('J1'))
    t.check(plan.record?.from?.id === siteId('SB') && plan.record.to?.id === junctionId('J1') && plan.record.name === 'SB-J1', 'SB-J1', plan.record)
})
test('CP-5', 'a typed id: kept when free; refused when in use or invalid; a typed name kept', t => {
    const doc = applyOps(base(), [{type: 'upsert', collection: 'paths', record: {id: 'TPA_SA_SB', name: 'SA-SB', from: site('SA'), to: site('SB'), waypoints: []}}])
    t.check(buildNewPathPlan(doc, site('SA'), site('SC'), {id: 'TPA_MY_ROUTE', name: 'my route'}).record?.id === 'TPA_MY_ROUTE', 'a free id is used')
    t.check(buildNewPathPlan(doc, site('SA'), site('SC'), {name: 'my route'}).record?.name === 'my route', 'the typed name is kept')
    t.check(buildNewPathPlan(doc, site('SA'), site('SC'), {id: 'TPA_SA_SB'}).errors.some(e => /already used/.test(e)), 'an id in use: refused')
    t.check(buildNewPathPlan(doc, site('SA'), site('SC'), {id: 'bad id!'}).errors.some(e => /id must match/.test(e)), 'an invalid id: refused')
})

/* ---------- FL: Form a line (lineEndCandidates, formLine, formedLineVoltageOps) ---------- */

/** `a` → junction `mid` → `b`, two circuits made by the circuit wizard and joined at `mid` (no line). */
function chain(doc: NetworkDocument, a: string, b: string, mid: string, rated: V, second: Partial<NewCircuitSpec> = {}) {
    const p1 = buildNewCircuitPlan(doc, {from: at(a), to: at(J(mid)), voltage: rated, bundle: 1, conductor})
    const d1 = applyOps(doc, p1.ops)
    const node = d1.connections.find(c => c.junction.id === junctionId(mid) && c.nodes.some(n => n.id === p1.circuit!.id))!
    const p2 = buildNewCircuitPlan(d1, {from: at(J(mid), {kind: 'junction', connectionId: node.id}), to: at(b), voltage: rated, bundle: 1, conductor, ...second})
    if (p1.errors.length || p2.errors.length) throw new Error(`setup circuits: ${[...p1.errors, ...p2.errors].join('; ')}`)
    return {doc: applyOps(d1, p2.ops), first: p1.circuit!.id, second: p2.circuit!.id}
}

/** Every pair of ends offered for a line through `circuitId`. */
function formPairs(doc: NetworkDocument, circuitId: string): FormedLine[] {
    const graph = buildCircuitGraph(doc)
    const cand = lineEndCandidates(doc, circuitId, graph)
    return cand.from.flatMap(a => cand.to.map(b => formLine(doc, circuitId, a, b, graph)))
}

interface PairExpect { from: string; to: string; sections: number; voltage?: V; problem?: RegExp }

const pairKey = (f: { from?: { id: string }; to?: { id: string }; circuitIds: string[] }) => `${f.from?.id ?? '-'} → ${f.to?.id ?? '-'} (${f.circuitIds.length})`

/** The pairs offered are exactly `exp` (by ends and sections), each at the voltage given or refused as given. */
function checkPairs(t: Checker, doc: NetworkDocument, circuitId: string, exp: PairExpect[]): FormedLine[] {
    const pairs = formPairs(doc, circuitId)
    t.eq(pairs.map(pairKey).sort().join(' | '), exp.map(e => `${e.from} → ${e.to} (${e.sections})`).sort().join(' | '), 'the pairs offered')
    for (const e of exp) {
        const p = pairs.find(x => pairKey(x) === `${e.from} → ${e.to} (${e.sections})`)
        if (!p) continue
        if (e.problem) t.check(!!p.problem && e.problem.test(p.problem), `${pairKey(p)}: refused ${e.problem}`, p.problem)
        else {
            t.check(!p.problem, `${pairKey(p)}: offered`, p.problem)
            t.eq(p.voltage, e.voltage, `${pairKey(p)}: voltage`)
        }
    }
    return pairs
}

/** Forms the line the panel would (its rule name, `formedLineVoltageOps`) and checks the result. */
function formAndCheck(t: Checker, doc: NetworkDocument, pair: FormedLine | undefined, voltage: V) {
    t.check(!!pair && !pair.problem, 'the pair to form', pair?.problem)
    if (!pair || pair.problem) return undefined
    const naming = lineNaming(doc, undefined, pair.from, pair.to, lineNameVoltage(doc, pair.circuitIds, pair.voltage))
    const record: TransmissionLineRecord = {id: naming.id, name: naming.name, voltage: pair.voltage!, circuitIds: pair.circuitIds, ...(pair.from ? {from: pair.from} : {}), ...(pair.to ? {to: pair.to} : {})}
    const after = applyOps(doc, [{type: 'upsert', collection: 'lines', record}, ...formedLineVoltageOps(doc, pair)])
    validates(t, after)
    unchangedExcept(t, doc, after, new Set([...pair.circuitIds, ...pair.junctionNodeIds]))
    const line = after.lines.find(l => l.id === record.id)!
    t.eq(line.voltage, voltage, 'line voltage')
    for (const id of pair.circuitIds) t.eq(after.circuits.find(c => c.id === id)?.energizedVoltage, voltage, `${id}: energized at the line voltage`)
    for (const id of pair.junctionNodeIds) t.eq(after.connections.find(c => c.id === id)?.voltage, voltage, `${id}: node at the line voltage`)
    const rated = after.circuits.find(c => c.id === pair.circuitIds[0])?.voltage
    t.check(line.name.startsWith(`${voltageLabel(rated)}_`) && defaultNamingFor(after, 'lines', line.id)?.name === line.name, 'named after the rated voltage, by the rules', line.name)
    const st = lineStatus(after, line)
    t.check(!st.missing.length && !st.notContiguous && !st.fromMismatch && !st.toMismatch, 'the line is contiguous, FROM → TO', st)
    return after
}

const SA230Y = yardId('SA', '230KV'), SB230Y = yardId('SB', '230KV')

test('FL-1', 'yard to yard at one voltage (SA → J3 → SB): offered at 230 kV; formed, the node along it at 230 kV', t => {
    const c = chain(base(), G('SA'), G('SB'), 'J3', V.AC230KV)
    const pairs = checkPairs(t, c.doc, c.first, [
        {from: SA230Y, to: junctionId('J3'), sections: 1, voltage: V.AC230KV},
        {from: SA230Y, to: SB230Y, sections: 2, voltage: V.AC230KV},
    ])
    formAndCheck(t, c.doc, pairs.find(p => p.circuitIds.length === 2), V.AC230KV)
})
test('FL-2', '230 kV-rated sections between 115 kV yards: at 115 kV, named after the rated 230 kV', t => {
    const c = chain(base(), G('SC'), G('SD'), 'J4', V.AC230KV)
    const pairs = checkPairs(t, c.doc, c.first, [
        {from: yardId('SC', '115KV'), to: junctionId('J4'), sections: 1, voltage: V.AC115KV},
        {from: yardId('SC', '115KV'), to: yardId('SD', '115KV'), sections: 2, voltage: V.AC115KV},
    ])
    formAndCheck(t, c.doc, pairs.find(p => p.circuitIds.length === 2), V.AC115KV)
})
test('FL-3', 'yards at different voltages (made by hand): refused; the open end at J3 offered', t => {
    const c = chain(base(), G('SA'), G('SC'), 'J3', V.AC230KV)
    checkPairs(t, c.doc, c.first, [
        {from: SA230Y, to: junctionId('J3'), sections: 1, voltage: V.AC230KV},
        {from: SA230Y, to: yardId('SC', '115KV'), sections: 2, problem: /^the ends are at different voltages: AC230KV \(SA_230KV\) and AC115KV \(SC_115KV\)/},
    ])
})
test('FL-4', 'yard to an open junction end (SA → J3): formed at the yard voltage, the line open at J3', t => {
    const c = chain(base(), G('SA'), G('SB'), 'J3', V.AC230KV)
    const after = formAndCheck(t, c.doc, formPairs(c.doc, c.first).find(p => p.circuitIds.length === 1), V.AC230KV)
    const line = after?.lines.find(l => l.circuitIds.length === 1 && l.circuitIds[0] === c.first)
    t.check(line?.to?.kind === ConnectionJunctionKind.TRANSMISSION_JUNCTION && line.to.id === junctionId('J3'), 'the line ends at J3', line?.to)
})
test('FL-5', 'a section rated below the voltage reaching it: refused', t => {
    const c = chain(base(), G('SA'), G('SB'), 'J3', V.AC230KV, {voltage: V.AC115KV})
    checkPairs(t, c.doc, c.first, [
        {from: SA230Y, to: junctionId('J3'), sections: 1, voltage: V.AC230KV},
        {from: SA230Y, to: SB230Y, sections: 2, problem: /^AC230KV is beyond the rating of section .* \(AC115KV\)/},
    ])
})
test('FL-6', 'junction to junction, nothing reaching it: 0 V, de-energized throughout', t => {
    const doc = base()
    const p = buildNewCircuitPlan(doc, {from: at(J('J1')), to: at(J('J2')), voltage: V.AC230KV, bundle: 1, conductor})
    const d = applyOps(doc, p.ops)
    const pairs = checkPairs(t, d, p.circuit!.id, [{from: junctionId('J1'), to: junctionId('J2'), sections: 1, voltage: V.DE_ENERGIZED}])
    formAndCheck(t, d, pairs[0], V.DE_ENERGIZED)
})
test('FL-7', 'a junction end tied in to live circuits (J3, 230 kV): their voltage; another voltage at a yard end refused', t => {
    const doc = withLine(base(), {...SA_SB, vias: [{junctionId: junctionId('J3')}]})
    const node = doc.connections.find(c => c.junction.id === junctionId('J3'))!
    const tie = (to: string, extra: Partial<NewCircuitSpec> = {}) => {
        const p = buildNewCircuitPlan(doc, {from: at(J('J3'), {kind: 'junction', connectionId: node.id}), to: at(to), voltage: V.AC230KV, bundle: 1, conductor, ...extra})
        return {doc: applyOps(doc, p.ops), id: p.circuit!.id}
    }
    const open = tie(J('J4'))
    checkPairs(t, open.doc, open.id, [
        {from: junctionId('J3'), to: junctionId('J4'), sections: 1, voltage: V.AC230KV},
        {from: SA230Y, to: junctionId('J4'), sections: 2, voltage: V.AC230KV},
        {from: SB230Y, to: junctionId('J4'), sections: 2, voltage: V.AC230KV},
    ])
    const sc = tie(G('SC'), {energizedVoltage: V.AC115KV})
    const different = /^the ends are at different voltages: AC230KV .* and AC115KV \(SC_115KV\)/
    checkPairs(t, sc.doc, sc.id, [
        {from: junctionId('J3'), to: yardId('SC', '115KV'), sections: 1, problem: different},
        {from: SA230Y, to: yardId('SC', '115KV'), sections: 2, problem: different},
        {from: SB230Y, to: yardId('SC', '115KV'), sections: 2, problem: different},
    ])
})
test('FL-8', 'a line already formed through the circuit: refused ("already line …")', t => {
    const c = chain(base(), G('SA'), G('SB'), 'J3', V.AC230KV)
    const formed = formAndCheck(t, c.doc, formPairs(c.doc, c.first).find(p => p.circuitIds.length === 2), V.AC230KV)
    if (!formed) return
    const again = formPairs(formed, c.first).find(p => p.circuitIds.length === 2)
    t.check(!!again?.problem && /^already line /.test(again.problem), 'the same pair again: refused', again?.problem)
})

/* ---------- RV: Route via (on a line SA → SB at 230 kV made by the line wizard) ---------- */

const viaJ = (name: string): RouteVia => ({kind: 'junction', junctionId: junctionId(name)})
const viaS = (code: string): RouteVia => ({kind: 'siteJunction', groupId: siteId(code)})
const viaY = (code: string, kv: string): RouteVia => ({kind: 'yard', yardId: yardId(code, kv)})
const LINE_SA_SB = '230KV_SA_SB_L1'
const lineSaSb = (energizedVoltage?: V) => withLine(base(), {...SA_SB, energizedVoltage})
const freed = (lineName: string, at: string) => new RegExp(`^take-off ${lineName} \\(${at}\\) is left without a circuit \\(kept\\)`)

test('RV-1', 'via J3: spliced in a node of its own at 230 kV, the line runs on', t => {
    verifyRouteVia(t, lineSaSb(), LINE_SA_SB, viaJ('J3'), {node: V.AC230KV}, {warnings: []})
})
test('RV-2', 'via the site SV: its junction created, spliced there', t => {
    const r = verifyRouteVia(t, lineSaSb(), LINE_SA_SB, viaS('SV'), {node: V.AC230KV}, {warnings: []})
    t.check(!!r?.after.junctions.some(j => j.groupId === siteId('SV')), 'the site junction of SV is created')
})
test('RV-3', 'into the 230 kV yard of SH (loop in): a take-off each way, the line split', t => {
    verifyRouteVia(t, lineSaSb(), LINE_SA_SB, viaY('SH', '230KV'), {yard: yardId('SH', '230KV'), voltage: V.AC230KV, takeOffs: ['230KV_SA_L1', '230KV_SB_L1']})
})
test('RV-4', '230 kV-rated at 115 kV: at SH only the 115 kV yard is offered', t => {
    const doc = withLine(base(), {from: Y('SC', '115KV'), to: Y('SD', '115KV'), voltage: V.AC230KV})
    const c = doc.circuits.find(x => x.id === lineNamed(doc, '230KV_SC_SD_L1').circuitIds[0])!
    const choices = yardChoices(doc, siteId('SH'), [c]).map(x => `${x.yard.yardName}: ${x.reason ?? 'ok'}`)
    t.eq(choices.join(' | '), '115KV: ok | 230KV: not at AC115KV (the voltage the circuits are energized at)', 'the yards of SH')
})
test('RV-5', 'circuits at 230 and 115 kV checked: no yard offered', t => {
    const doc = withLine(lineSaSb(), {from: Y('SC', '115KV'), to: Y('SD', '115KV'), voltage: V.AC230KV})
    const circuits = [LINE_SA_SB, '230KV_SC_SD_L1'].map(n => doc.circuits.find(x => x.id === lineNamed(doc, n).circuitIds[0])!)
    t.check(yardChoices(doc, siteId('SH'), circuits).every(x => /^the checked circuits run at different voltages \(AC230KV, AC115KV\)/.test(x.reason ?? '')), 'every yard of SH refused',
        yardChoices(doc, siteId('SH'), circuits))
})
test('RV-6', 'de-energized: the yards within its rating offered; looped into SH 230 kV it stays 0 V, warned, take-offs at 230 kV', t => {
    const doc = lineSaSb(V.DE_ENERGIZED)
    const c = doc.circuits.find(x => x.id === lineNamed(doc, LINE_SA_SB).circuitIds[0])!
    t.eq(yardChoices(doc, siteId('SH'), [c]).map(x => `${x.yard.yardName}: ${x.reason ?? 'ok'}`).join(' | '), '115KV: ok | 230KV: ok', 'both yards of SH (within the 230 kV rating)')
    verifyRouteVia(t, doc, LINE_SA_SB, viaY('SH', '230KV'), {yard: yardId('SH', '230KV'), voltage: V.AC230KV, takeOffs: ['230KV_SA_L1', '230KV_SB_L1']},
        {warnings: [/^230KV_SA_SB_L1_SA-SB is de-energized \(0 V\): entering yard SH 230KV at AC230KV, it stays de-energized/]})
})
test('RV-7', 'de-energized via J3: the parts stay 0 V, the node at 0 V (its energized voltage)', t => {
    verifyRouteVia(t, lineSaSb(V.DE_ENERGIZED), LINE_SA_SB, viaJ('J3'), {node: V.DE_ENERGIZED}, {warnings: []})
})
test('RV-8', 'the first part on an existing path running the other way (J3-SA): it follows that path, a note', t => {
    const doc = applyOps(lineSaSb(), [{type: 'upsert', collection: 'paths', record: {id: 'TPA_J3_SA', name: 'J3-SA', from: junction('J3'), to: site('SA'), waypoints: []}}])
    const r = verifyRouteVia(t, doc, LINE_SA_SB, viaJ('J3'), {node: V.AC230KV}, {reuseBeforeId: 'TPA_J3_SA', warnings: [/^path J3-SA runs .*: .* follow its direction \(FROM and TO swap\)/]})
    const first = r?.after.circuits.find(c => c.id === lineNamed(doc, LINE_SA_SB).circuitIds[0])
    t.eq(first?.pathId, 'TPA_J3_SA', 'the first part runs on J3-SA')
})

/* ---------- RT / RF: Route to / Route from (on the same line) ---------- */

test('RT-1', 'to J2: spliced at the junction of SB (created), on to a node of its own at J2; the take-off at SB left free', t => {
    const r = verifyRouteEnd(t, lineSaSb(), LINE_SA_SB, CIRCUIT_END_TO, viaJ('J2'), {node: V.AC230KV}, {warnings: [freed('230KV_SA_L1', 'SB 230KV')]})
    t.check(!!r?.after.junctions.some(j => j.groupId === siteId('SB')), 'the site junction of SB is created')
})
test('RF-1', 'from J1: the mirror at SA', t => {
    verifyRouteEnd(t, lineSaSb(), LINE_SA_SB, CIRCUIT_END_FROM, viaJ('J1'), {node: V.AC230KV}, {warnings: [freed('230KV_SB_L1', 'SA 230KV')]})
})
test('RT-2', 'to the site SS: its junction created, a node of its own there', t => {
    verifyRouteEnd(t, lineSaSb(), LINE_SA_SB, CIRCUIT_END_TO, viaS('SS'), {node: V.AC230KV}, {warnings: [freed('230KV_SA_L1', 'SB 230KV')]})
})
test('RT-3', 'to the 230 kV yard of SH: a new take-off there, the line ends there', t => {
    verifyRouteEnd(t, lineSaSb(), LINE_SA_SB, CIRCUIT_END_TO, viaY('SH', '230KV'), {yard: yardId('SH', '230KV'), voltage: V.AC230KV, takeOffs: ['230KV_SA_L1']}, {warnings: [freed('230KV_SA_L1', 'SB 230KV')]})
})
test('RT-4', '230 kV-rated at 115 kV: to the 230 kV yard of SH refused, to its 115 kV yard allowed', t => {
    const doc = withLine(base(), {from: Y('SC', '115KV'), to: Y('SD', '115KV'), voltage: V.AC230KV})
    verifyRouteEnd(t, doc, '230KV_SC_SD_L1', CIRCUIT_END_TO, viaY('SH', '230KV'), {refused: /^yard SH 230KV: not at AC115KV \(the voltage the circuits are energized at\)/})
    verifyRouteEnd(t, doc, '230KV_SC_SD_L1', CIRCUIT_END_TO, viaY('SH', '115KV'), {yard: yardId('SH', '115KV'), voltage: V.AC115KV, takeOffs: ['115KV_SC_L1']}, {warnings: [freed('115KV_SC_L1', 'SD 115KV')]})
})
test('RT-5', 'over existing paths through a line junction (SB → J4, then J4 ← SS): two sections, spliced at J4; the second follows its path', t => {
    const doc = applyOps(lineSaSb(), [
        {type: 'upsert', collection: 'paths', record: {id: 'TPA_SB_J4', name: 'SB-J4', from: site('SB'), to: junction('J4'), waypoints: []}},
        {type: 'upsert', collection: 'paths', record: {id: 'TPA_SS_J4', name: 'SS-J4', from: site('SS'), to: junction('J4'), waypoints: []}},
    ])
    verifyRouteEnd(t, doc, LINE_SA_SB, CIRCUIT_END_TO, viaS('SS'), {node: V.AC230KV}, {
        reusePathIds: ['TPA_SB_J4', 'TPA_SS_J4'], sections: 2,
        warnings: [freed('230KV_SA_L1', 'SB 230KV'), /^path SS-J4 runs .*: the new sections on it follow its direction \(FROM and TO swap\)/],
    })
})
test('RT-6', 'the take-off left free at the old end: removed on request, with its wiring', t => {
    const doc = lineSaSb()
    const takeOff = doc.takeOffs.find(x => x.substationId === SB230Y && x.lineName === '230KV_SA_L1')!
    // removed: listed in the plan (freedTakeOffs, takeOffsRemoved) for the confirmation, no "left without a circuit" note
    const r = verifyRouteEnd(t, doc, LINE_SA_SB, CIRCUIT_END_TO, viaJ('J2'), {node: V.AC230KV}, {removeFreedTakeOffs: true, warnings: []})
    t.check(!!r && r.plan.takeOffsRemoved && r.plan.freedTakeOffs.map(x => x.id).join() === takeOff.id, 'the plan lists it as removed', r?.plan.freedTakeOffs.map(x => x.id))
    t.check(!!r && !r.after.takeOffs.some(x => x.id === takeOff.id), 'the take-off is removed')
    t.check(!!r && !r.after.connections.some(c => c.nodes.some(n => n.id === takeOff.id)), 'and every connection that held it')
})
test('RT-7', 'de-energized: to the 230 kV yard of SH allowed, warned; to J2 the sections and the node at 0 V', t => {
    const doc = lineSaSb(V.DE_ENERGIZED)
    verifyRouteEnd(t, doc, LINE_SA_SB, CIRCUIT_END_TO, viaY('SH', '230KV'), {yard: yardId('SH', '230KV'), voltage: V.AC230KV, takeOffs: ['230KV_SA_L1']},
        {warnings: [/is de-energized \(0 V\): entering yard SH 230KV at AC230KV, it stays de-energized/, freed('230KV_SA_L1', 'SB 230KV')]})
    verifyRouteEnd(t, doc, LINE_SA_SB, CIRCUIT_END_TO, viaJ('J2'), {node: V.DE_ENERGIZED}, {warnings: [freed('230KV_SA_L1', 'SB 230KV')]})
})
test('RT-8', 'a line through the circuit (SA → J3 → SB): routed at J3 to J4, it now ends at J4; the section beyond J3 leaves it', t => {
    const doc = withLine(base(), {...SA_SB, vias: [{junctionId: junctionId('J3')}]})
    const line = lineNamed(doc, LINE_SA_SB)
    const beyond = line.circuitIds[1]
    const r = verifyRouteEnd(t, doc, LINE_SA_SB, CIRCUIT_END_TO, viaJ('J4'), {node: V.AC230KV}, {
        warnings: [/no longer belongs to a line/],
    })
    if (!r) return
    t.eq(r.plan.lines[0]?.dropped.map(c => c.id).join(), beyond, 'the section beyond J3 is dropped from the line')
    t.check(!r.after.lines.some(l => l.circuitIds.includes(beyond)), 'it belongs to no line now')
    t.check(newConnections(doc, r.after).some(c => c.junction.id === junctionId('J3')), 'spliced at J3 in a new node')
})
