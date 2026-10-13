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
