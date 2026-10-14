/**
 * Verifiers shared by the test files: a line created by the wizard (`verifyLine`, `verifyRefused`), the records an
 * operation must leave as they were (`unchangedExcept`), and small lookups.
 */
import {TransmissionVoltage as V} from '@shared/models/transmission.voltage'
import {genericConductor} from '@shared/models/transmission.conductor'
import {applyOps} from '@shared/network/ops'
import {
    CIRCUIT_END_FROM,
    CIRCUIT_END_TO,
    CircuitEnd,
    ConnectionJunctionKind,
    ConnectionJunctionRef,
    ConnectionRecord,
    NetworkCollectionName,
    NetworkDocument,
    NetworkNodeKind,
    TransmissionCircuitRecord,
} from '@shared/network/records'
import {validateNetworkDocument} from '@shared/network/validation'
import {lineStatus} from '@shared/network/lines'
import {defaultNamingFor} from '@shared/network/naming'
import {voltageLabel} from '@shared/models/naming'
import {circuitEndConnection, connectionVoltage, takeOffVoltage} from '@shared/network/migrate'
import {buildNewLinePlan, NewLineSpec} from '../src/network/lineWizard'
import {buildRouteViaPlan, RouteVia, RouteViaOptions} from '../src/network/routeVia'
import {buildRouteEndPlan, RouteEndOptions} from '../src/network/routeEnd'
import {Checker} from './harness'

/** Collections an operation on the transmission side may touch; `unchangedExcept` compares them record by record. */
const TRANSMISSION_COLLECTIONS: NetworkCollectionName[] = ['junctions', 'takeOffs', 'paths', 'circuits', 'connections', 'lines']

/**
 * Every record of `before` is in `after` exactly as it was, except the ids in `changed` (records the operation may
 * rewrite or remove). New records are not checked here.
 */
export function unchangedExcept(t: Checker, before: NetworkDocument, after: NetworkDocument, changed: ReadonlySet<string> = new Set()) {
    for (const collection of TRANSMISSION_COLLECTIONS) {
        const now = new Map((after[collection] as { id: string }[]).map(r => [r.id, r]))
        const altered: string[] = []
        for (const r of before[collection] as { id: string }[]) {
            if (changed.has(r.id)) continue
            const x = now.get(r.id)
            if (!x || JSON.stringify(x) !== JSON.stringify(r)) altered.push(x ? r.id : `${r.id} (removed)`)
        }
        t.check(altered.length === 0, `existing ${collection} left as they were`, altered.slice(0, 6))
    }
}

/** The connection records new in `after`. */
export const newConnections = (before: NetworkDocument, after: NetworkDocument) => {
    const old = new Set(before.connections.map(c => c.id))
    return after.connections.filter(c => !old.has(c.id))
}

export const lineNamed = (doc: NetworkDocument, name: string) => {
    const line = doc.lines.find(l => l.name === name)
    if (!line) throw new Error(`the fixture has no line ${name}`)
    return line
}

/** Where a line end is expected: a yard (through a new take-off, or that existing one), a line junction, or a site's junction. */
export type EndExpect =
    | { yard: string; takeOff: 'new' | string; takeOffVoltage?: V }
    | { junction: string }
    | { siteJunction: string }

export interface LineExpect {
    /** The conductor's rated voltage (every section). */
    rated: V
    /** The voltage the line runs at: the line, its sections (energized) and the junction nodes. */
    line: V
    from: EndExpect
    to: EndExpect
    vias?: ({ junction: string } | { siteJunction: string })[]
    circuits?: number
    /** The plan's warnings and notes, each matched by exactly these patterns (nothing more, nothing less). */
    warnings?: RegExp[]
    notes?: RegExp[]
}

const conductor = genericConductor()
export const spec = (s: Partial<NewLineSpec>): NewLineSpec => ({circuits: 1, bundle: 2, conductor, reuseTakeOffs: true, ...s})

/** Every pattern matches some message and every message matches some pattern. */
export function matchSet(t: Checker, what: string, actual: string[], expected: RegExp[]) {
    for (const re of expected) t.check(actual.some(a => re.test(a)), `${what}: one matches ${re}`, actual)
    for (const a of actual) t.check(expected.some(re => re.test(a)), `${what}: unexpected "${a}"`)
}

export const circuitNodes = (c: ConnectionRecord) => c.nodes.filter(n => n.kind === NetworkNodeKind.TRANSMISSION_CIRCUIT)
export const endConnections = (doc: NetworkDocument, circuitId: string) =>
    [CIRCUIT_END_FROM, CIRCUIT_END_TO].map(e => circuitEndConnection(doc, circuitId, e)).filter((c): c is ConnectionRecord => !!c)

/** Builds the plan, applies it and checks it against `exp`; returns the document after. */
export function verifyLine(t: Checker, doc: NetworkDocument, s: NewLineSpec, exp: LineExpect): NetworkDocument | undefined {
    const plan = buildNewLinePlan(doc, s)
    t.check(plan.errors.length === 0, 'the plan has no errors', plan.errors)
    if (plan.errors.length) return undefined
    const after = applyOps(doc, plan.ops)
    const issues = validateNetworkDocument(after).filter(i => i.severity !== 'warning')
    t.check(issues.length === 0, 'the result validates', issues.slice(0, 3))
    // the wizard only adds: what existed (other lines, their circuits, nodes and take-offs, paths it reuses) stays as it was
    unchangedExcept(t, doc, after)
    matchSet(t, 'warnings', plan.warnings, exp.warnings ?? [])   // the line wizard refuses or notes: none expected anywhere
    matchSet(t, 'notes', plan.notes, exp.notes ?? [])
    t.eq(plan.energizedVoltage, exp.line, 'the plan runs the line at')
    const count = exp.circuits ?? 1
    t.eq(plan.circuits.length, count, 'circuits created')
    const junctionOf = (e: { junction: string } | { siteJunction: string }) => 'junction' in e ? e.junction : after.junctions.find(j => j.groupId === e.siteJunction)?.id
    const refOf = (e: EndExpect): ConnectionJunctionRef | undefined => 'yard' in e ? {kind: ConnectionJunctionKind.SUBSTATION, id: e.yard}
        : {kind: ConnectionJunctionKind.TRANSMISSION_JUNCTION, id: junctionOf(e)!}
    const vias = exp.vias ?? []
    t.eq(plan.legs.length, vias.length + 1, 'legs')
    for (const v of vias) t.check(!!junctionOf(v), `junction passed: ${JSON.stringify(v)}`)

    const checkEnd = (section: TransmissionCircuitRecord, e: EndExpect, side: string, takeOffId: string | undefined, reused: boolean) => {
        const conns = endConnections(after, section.id)
        if ('yard' in e) {
            const conn = conns.find(c => c.junction.kind === ConnectionJunctionKind.SUBSTATION && c.junction.id === e.yard)
            t.check(!!conn, `${side}: the section leaves yard ${e.yard}`, conns.map(c => c.junction))
            if (!conn) return
            const node = conn.nodes.find(n => n.kind === NetworkNodeKind.SUBSTATION_TAKE_OFF)
            t.check(!!node && node.id === takeOffId, `${side}: through the plan's take-off`, {node: node?.id, takeOffId})
            if (e.takeOff === 'new') t.check(!reused && !doc.takeOffs.some(x => x.id === node?.id), `${side}: a new take-off`, node?.id)
            else t.check(reused && node?.id === e.takeOff, `${side}: the existing take-off ${e.takeOff}`, {node: node?.id, reused})
            const yardVoltage = after.substations.find(y => y.id === e.yard)?.voltage
            const expected = e.takeOffVoltage ?? (exp.line === V.DE_ENERGIZED ? yardVoltage : exp.line)
            t.eq(node && takeOffVoltage(after, node.id), expected, `${side}: take-off voltage (its circuit's)`)
            t.eq(connectionVoltage(after, conn), expected, `${side}: take-off connection voltage`)
            t.eq(circuitNodes(conn).length, 1, `${side}: the take-off carries this section only`)
        } else {
            const jid = junctionOf(e)
            const conn = conns.find(c => c.junction.kind === ConnectionJunctionKind.TRANSMISSION_JUNCTION && c.junction.id === jid)
            t.check(!!conn, `${side}: the section ends at junction ${jid}`, conns.map(c => c.junction))
            if (!conn) return
            t.eq(circuitNodes(conn).length, 1, `${side}: a node of its own (open)`)
            t.eq(conn.voltage, exp.line, `${side}: node voltage`)
        }
    }

    const viaNodeIds = vias.map(() => new Set<string>())
    for (const [i, c] of plan.circuits.entries()) {
        const line = after.lines.find(l => l.id === c.line.id)
        t.check(!!line, `circuit ${i}: the line exists`)
        if (!line) continue
        t.eq(line.voltage, exp.line, `circuit ${i}: line voltage`)
        // named after the conductors' rated voltage, not the one it runs at, and as the rules (regenerate) name it
        t.check(line.name.startsWith(`${voltageLabel(exp.rated)}_`), `circuit ${i}: the line is named after the rated ${exp.rated}`, line.name)
        const rule = defaultNamingFor(after, 'lines', line.id)
        t.check(rule?.name === line.name && rule?.id === line.id, `circuit ${i}: the line's name and id are the rule ones`, {line: [line.id, line.name], rule})
        const from = refOf(exp.from), to = refOf(exp.to)
        t.check(line.from?.kind === from?.kind && line.from?.id === from?.id, `circuit ${i}: line FROM`, {line: line.from, expected: from})
        t.check(line.to?.kind === to?.kind && line.to?.id === to?.id, `circuit ${i}: line TO`, {line: line.to, expected: to})
        const st = lineStatus(after, line)
        t.check(!st.empty && !st.missing.length && !st.notContiguous && !st.fromMismatch && !st.toMismatch, `circuit ${i}: the line's sections run FROM → TO`, st)
        const sections = line.circuitIds.map(id => after.circuits.find(x => x.id === id)!)
        t.eq(sections.length, vias.length + 1, `circuit ${i}: sections`)
        sections.forEach((s, k) => {
            t.eq(s.voltage, exp.rated, `circuit ${i} section ${k}: rated voltage`)
            t.eq(s.energizedVoltage, exp.line, `circuit ${i} section ${k}: energized voltage`)
            t.eq(s.pathId, plan.legs[k].path.id, `circuit ${i} section ${k}: on its leg's path`)
        })
        checkEnd(sections[0], exp.from, `circuit ${i} FROM`, c.fromTakeOff?.id, c.reused.from)
        checkEnd(sections[sections.length - 1], exp.to, `circuit ${i} TO`, c.toTakeOff?.id, c.reused.to)
        vias.forEach((v, k) => {
            const a = endConnections(after, sections[k].id), b = endConnections(after, sections[k + 1].id)
            const node = a.find(x => b.some(y => y.id === x.id))
            t.check(!!node && node.junction.id === junctionOf(v), `circuit ${i}: sections ${k} and ${k + 1} meet at ${junctionOf(v)}`, node?.junction)
            if (!node) return
            t.eq(circuitNodes(node).length, 2, `circuit ${i}: the node at ${junctionOf(v)} joins the two sections only`)
            t.eq(node.voltage, exp.line, `circuit ${i}: node voltage at ${junctionOf(v)}`)
            viaNodeIds[k].add(node.id)
        })
    }
    viaNodeIds.forEach((ids, k) => t.eq(ids.size, count, `a node of its own per circuit at via ${k}`))
    t.check(after.takeOffs.every(x => !('voltage' in x)), 'no take-off carries a voltage of its own')
    return after
}

/** Refused: the plan has an error matching each pattern and no ops. */
export function verifyRefused(t: Checker, doc: NetworkDocument, s: NewLineSpec, errors: RegExp[]) {
    const plan = buildNewLinePlan(doc, s)
    for (const re of errors) t.check(plan.errors.some(e => re.test(e)), `refused: an error matches ${re}`, plan.errors)
    t.eq(plan.ops.length, 0, 'no ops')
}

/* ---------- route via / route to / route from ---------- */

/** Line names are unique, and take-off line names unique within each yard. */
export function namesUnique(t: Checker, doc: NetworkDocument) {
    const lineNames = doc.lines.map(l => l.name)
    t.check(new Set(lineNames).size === lineNames.length, 'line names are unique', lineNames.filter((n, i) => lineNames.indexOf(n) !== i))
    const keys = doc.takeOffs.map(x => `${x.substationId}/${x.lineName}`)
    t.check(new Set(keys).size === keys.length, 'take-off line names are unique within each yard', keys.filter((n, i) => keys.indexOf(n) !== i))
}

export function validates(t: Checker, doc: NetworkDocument) {
    const issues = validateNetworkDocument(doc).filter(i => i.severity !== 'warning')
    t.check(issues.length === 0, 'the result validates', issues.slice(0, 3))
}

/** The records a route of `circuitId` may rewrite: the circuit, its lines and path, and the connections at its ends. */
export function routeTouches(doc: NetworkDocument, circuitId: string, pathId: string): Set<string> {
    const ids = new Set([circuitId, pathId, ...doc.lines.filter(l => l.circuitIds.includes(circuitId)).map(l => l.id)])
    for (const e of [CIRCUIT_END_FROM, CIRCUIT_END_TO]) {
        const c = circuitEndConnection(doc, circuitId, e)
        if (c) ids.add(c.id)
    }
    return ids
}

/** The connection at `at` (a yard or a junction) holding an end of `circuitId`. */
const connectionAt = (doc: NetworkDocument, circuitId: string, at: string) =>
    doc.connections.find(c => c.junction.id === at && c.nodes.some(n => n.kind === NetworkNodeKind.TRANSMISSION_CIRCUIT && n.id === circuitId))

/** `circuitId` leaves yard `yard` through a new take-off of its own at `voltage` (named `lineName`, when given). */
export function checkNewTakeOff(t: Checker, before: NetworkDocument, after: NetworkDocument, yard: string, circuitId: string, voltage: V, label: string, lineName?: string) {
    const conn = connectionAt(after, circuitId, yard)
    t.check(conn?.junction.kind === ConnectionJunctionKind.SUBSTATION, `${label}: in yard ${yard}`, circuitEndConnections(after, circuitId).map(c => c.junction))
    if (!conn) return
    const node = conn.nodes.find(n => n.kind === NetworkNodeKind.SUBSTATION_TAKE_OFF)
    t.check(!!node && !before.takeOffs.some(x => x.id === node.id), `${label}: through a new take-off`, node?.id)
    t.eq(circuitNodes(conn).length, 1, `${label}: the take-off carries this circuit only`)
    t.eq(node && takeOffVoltage(after, node.id), voltage, `${label}: take-off voltage`)
    t.eq(connectionVoltage(after, conn), voltage, `${label}: connection voltage`)
    if (lineName) t.eq(after.takeOffs.find(x => x.id === node?.id)?.lineName, lineName, `${label}: take-off line name`)
}

/** At junction `junction` one new node of its own, holding exactly the ends of `circuitIds` there, at `voltage`. */
export function checkNewNode(t: Checker, before: NetworkDocument, after: NetworkDocument, junction: string, circuitIds: string[], voltage: V | undefined, label: string) {
    const added = newConnections(before, after).filter(c => c.junction.kind === ConnectionJunctionKind.TRANSMISSION_JUNCTION && c.junction.id === junction)
    t.eq(added.length, 1, `${label}: one new node at ${junction}`)
    const node = connectionAt(after, circuitIds[0], junction)
    t.check(!!node && added.includes(node), `${label}: in that new node`, node?.id)
    if (!node) return
    const held = circuitNodes(node).map(n => n.id).sort()
    t.eq(held.join(), [...circuitIds].sort().join(), `${label}: the node holds ${circuitIds.length === 1 ? 'this end only (open)' : 'these ends only'}`)
    t.eq(node.voltage, voltage, `${label}: node voltage`)
}

const circuitEndConnections = (doc: NetworkDocument, circuitId: string) =>
    [CIRCUIT_END_FROM, CIRCUIT_END_TO].map(e => circuitEndConnection(doc, circuitId, e)).filter((c): c is ConnectionRecord => !!c)

function lineContiguous(t: Checker, doc: NetworkDocument, lineId: string) {
    const line = doc.lines.find(l => l.id === lineId)!
    const st = lineStatus(doc, line)
    t.check(!st.missing.length && !st.notContiguous && !st.fromMismatch && !st.toMismatch, `${line.name} is contiguous, FROM → TO`, st)
}

/**
 * Where a route goes and what it gives there: spliced at (or ending at) a junction in a node of its own at `node`, into
 * a yard through new take-offs at `voltage` (with these line names, when given), or refused.
 */
export type RouteExpect =
    | { node: V }
    | { yard: string; voltage: V; takeOffs?: string[] }
    | { refused: RegExp }

export interface RouteCheckOptions {
    /** The plan's warnings (notes for the confirmation), each matched by exactly these patterns. */
    warnings?: RegExp[]
    /** Which section of the line to route (index in its sections); the first by default. */
    section?: number
}

const viaJunctionId = (doc: NetworkDocument, via: RouteVia) =>
    via.kind === 'junction' ? via.junctionId : via.kind === 'siteJunction' ? doc.junctions.find(j => j.groupId === via.groupId)?.id : undefined

/**
 * Routes a section of line `lineName` via `via` and checks the result: what is not the routed circuit, its line and
 * path, and the connections at its ends is left as it was; both parts keep the rated and energized voltage; spliced at
 * a junction, one new node holds exactly the two parts and the line runs on through both, its ends kept; looped into a
 * yard, each part leaves it through a new take-off and the line is split there, the new line named after the rated
 * voltage. Returns the document after, and the plan.
 */
export function verifyRouteVia(t: Checker, doc: NetworkDocument, lineName: string, via: RouteVia, exp: RouteExpect, opts: RouteViaOptions & RouteCheckOptions = {}) {
    const line = lineNamed(doc, lineName)
    const circuit = doc.circuits.find(c => c.id === line.circuitIds[opts.section ?? 0])!
    const pathId = circuit.pathId!
    const plan = buildRouteViaPlan(doc, pathId, [circuit.id], via, opts)
    if ('refused' in exp) {
        t.check(plan.errors.some(e => exp.refused.test(e)), `refused: ${exp.refused}`, plan.errors)
        t.eq(plan.ops.length, 0, 'no ops')
        return undefined
    }
    t.check(plan.errors.length === 0, 'the plan has no errors', plan.errors)
    if (plan.errors.length) return undefined
    const after = applyOps(doc, plan.ops)
    validates(t, after)
    namesUnique(t, after)
    unchangedExcept(t, doc, after, routeTouches(doc, circuit.id, pathId))
    if (opts.warnings) matchSet(t, 'warnings', plan.warnings, opts.warnings)
    const cont = plan.circuits[0]?.continuation
    t.check(!!cont, 'a continuation circuit')
    if (!cont) return undefined
    const c = after.circuits.find(x => x.id === circuit.id)!
    const k = after.circuits.find(x => x.id === cont.id)!
    for (const [x, label] of [[c, 'first part'], [k, 'continuation']] as const) {
        t.eq(x.voltage, circuit.voltage, `${label}: rated voltage kept`)
        t.eq(x.energizedVoltage, circuit.energizedVoltage, `${label}: energized voltage kept`)
    }
    if ('node' in exp) {
        const jid = viaJunctionId(after, via)!
        checkNewNode(t, doc, after, jid, [c.id, k.id], exp.node, 'via')
        const kept = after.lines.find(l => l.id === line.id)!
        const i = line.circuitIds.indexOf(circuit.id)
        t.eq(kept.circuitIds.join(), [...line.circuitIds.slice(0, i + 1), k.id, ...line.circuitIds.slice(i + 1)].join(), 'the line runs on through both parts')
        t.check(kept.from?.id === line.from?.id && kept.to?.id === line.to?.id, 'the line keeps its ends')
        lineContiguous(t, after, line.id)
    } else {
        checkNewTakeOff(t, doc, after, exp.yard, c.id, exp.voltage, 'first part', exp.takeOffs?.[0])
        checkNewTakeOff(t, doc, after, exp.yard, k.id, exp.voltage, 'continuation', exp.takeOffs?.[1])
        t.eq(plan.splitLines.length, 1, 'the line is split at the yard')
        const split = plan.splitLines[0]
        if (!split) return {after, plan}
        const kept = after.lines.find(l => l.id === line.id)!, added = after.lines.find(l => l.id === split.added.id)!
        t.check(kept.to?.kind === ConnectionJunctionKind.SUBSTATION && kept.to.id === exp.yard, 'the first line now ends at the yard', kept.to)
        t.check(added.from?.id === exp.yard && added.to?.id === line.to?.id, 'the second line runs from the yard to the old TO end', {from: added.from, to: added.to})
        t.check(added.name.startsWith(`${voltageLabel(circuit.voltage)}_`), 'the second line is named after the rated voltage', added.name)
        lineContiguous(t, after, kept.id)
        lineContiguous(t, after, added.id)
    }
    return {after, plan}
}

/**
 * Routes a section of line `lineName` at its path's `end` (TO: route to, FROM: route from) to `target`, on a new path
 * unless `opts.reusePathIds`, and checks the result: the circuit is spliced at the old end's junction with the new
 * sections (in a node holding just the two); consecutive new sections meet in a node of their own at each junction
 * passed; they keep the rated and energized voltage; the last ends in a new node of its own at a junction, or a new
 * take-off in a yard; the line now ends (starts) there, contiguous; what else was there is left as it was.
 */
export function verifyRouteEnd(t: Checker, doc: NetworkDocument, lineName: string, end: CircuitEnd, target: RouteVia, exp: RouteExpect, opts: RouteEndOptions & RouteCheckOptions & { sections?: number } = {}) {
    const line = lineNamed(doc, lineName)
    const circuit = doc.circuits.find(c => c.id === line.circuitIds[opts.section ?? 0])!
    const pathId = circuit.pathId!
    const plan = buildRouteEndPlan(doc, pathId, [circuit.id], end, target, opts)
    if ('refused' in exp) {
        t.check(plan.errors.some(e => exp.refused.test(e)), `refused: ${exp.refused}`, plan.errors)
        t.eq(plan.ops.length, 0, 'no ops')
        return undefined
    }
    t.check(plan.errors.length === 0, 'the plan has no errors', plan.errors)
    if (plan.errors.length) return undefined
    const after = applyOps(doc, plan.ops)
    validates(t, after)
    namesUnique(t, after)
    const touched = routeTouches(doc, circuit.id, pathId)
    if (opts.removeFreedTakeOffs) for (const x of plan.freedTakeOffs) touched.add(x.id)
    unchangedExcept(t, doc, after, touched)
    if (opts.warnings) matchSet(t, 'warnings', plan.warnings, opts.warnings)
    const sections = (plan.circuits[0]?.sections ?? []).map(s => after.circuits.find(x => x.id === s.id)!)
    t.eq(sections.length, opts.sections ?? 1, 'new sections, one per path of the route')
    if (!sections.length) return undefined
    for (const s of sections) {
        t.eq(s.voltage, circuit.voltage, `${s.name}: rated voltage copied`)
        t.eq(s.energizedVoltage, circuit.energizedVoltage, `${s.name}: energized voltage copied`)
    }
    // the old end: the circuit and the first new section in one node at the pass junction
    const pass = plan.passJunction
    t.check(!!pass, 'a junction at the old end to splice at', pass)
    if (pass) {
        const splice = circuitEndConnection(after, circuit.id, end)
        t.check(splice?.junction.id === pass.id, `spliced at ${pass.name ?? pass.id}`, splice?.junction)
        t.eq(splice && circuitNodes(splice).map(n => n.id).sort().join(), [circuit.id, sections[0].id].sort().join(), 'the splice holds the circuit and the first new section only')
    }
    plan.via.forEach((j, k) => {
        const node = connectionAt(after, sections[k].id, j.id)
        t.eq(node && circuitNodes(node).map(n => n.id).sort().join(), [sections[k].id, sections[k + 1]?.id].sort().join(), `sections ${k} and ${k + 1} meet in a node of their own at ${j.name ?? j.id}`)
    })
    // the new place
    const last = sections[sections.length - 1]
    const lineAfter = after.lines.find(l => l.id === line.id)!
    const newEnd = end === CIRCUIT_END_TO ? lineAfter.to : lineAfter.from
    const word = end === CIRCUIT_END_TO ? 'ends' : 'starts'
    if ('node' in exp) {
        const jid = viaJunctionId(after, target)!
        checkNewNode(t, doc, after, jid, [last.id], exp.node, 'at the new place')
        t.check(newEnd?.kind === ConnectionJunctionKind.TRANSMISSION_JUNCTION && newEnd.id === jid, `the line now ${word} at ${jid}`, newEnd)
    } else {
        checkNewTakeOff(t, doc, after, exp.yard, last.id, exp.voltage, 'at the new place', exp.takeOffs?.[0])
        t.check(newEnd?.kind === ConnectionJunctionKind.SUBSTATION && newEnd.id === exp.yard, `the line now ${word} at ${exp.yard}`, newEnd)
    }
    t.check(lineAfter.circuitIds.includes(circuit.id) && sections.every(s => lineAfter.circuitIds.includes(s.id)), 'the line takes the new sections', lineAfter.circuitIds)
    lineContiguous(t, after, line.id)
    return {after, plan}
}
