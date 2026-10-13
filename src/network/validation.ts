/**
 * Validation of network documents and journal ops. Shared by backend and UI.
 *
 * `validateNetworkDocument` checks shape, id uniqueness, referential integrity
 * and the connection rules:
 *  - SUBSTATION scope: junction is a yard; nodes are buses / equipment terminals / take-offs of that yard; ≥ 2 nodes.
 *  - TRANSMISSION scope at a yard: exactly one take-off of that yard plus ≥ 1 circuit end; nothing else.
 *  - TRANSMISSION scope at a junction: ≥ 1 circuit end, nothing else.
 *  - every equipment terminal, take-off and circuit end is used by at most one connection per scope.
 */
import {ValidationIssue} from "../templates/validation";
import {TransmissionVoltage} from "../models/transmission.voltage";
import {TransmissionWireType, TransmissionWireUnit} from "../models/transmission.conductor";
import {GenerationType} from "../models/generation";
import {SubstationArrangement} from "../models/substation";
import {SubstationBusType} from "../models/substation.bus";
import {SubstationEquipmentType} from "../models/substation.equipment";
import {TemplateKind} from "../templates/template";
import {validateTransformerWindings} from "../templates/validation";
import {atPathEnd} from "./refs";
import {
    AnyNetworkRecord,
    CIRCUIT_END_FROM,
    CIRCUIT_END_TO,
    ConnectionJunctionKind,
    ConnectionScope,
    NETWORK_DOCUMENT_FORMAT,
    NETWORK_DOCUMENT_VERSION,
    NETWORK_ID_PATTERN,
    NetworkCollectionName,
    networkCollectionNames,
    NetworkDocument,
    NetworkNodeKind,
    NetworkNodeRef,
    nodeKey,
    ConnectionRecord,
    isTransformerType,
    SubstationGroupRecord,
} from "./records";
import {NetworkOp} from "./ops";

type Issues = ValidationIssue[]
type Rec = Record<string, unknown>

const isRecord = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const enumValues = (e: Record<string, string>) => Object.values(e)

function checkCoords(issues: Issues, v: unknown, path: string, required: boolean) {
    if (v === undefined || v === null) {
        if (required) issues.push({path, message: 'coords are required'})
        return
    }
    if (!isRecord(v) || !isFiniteNumber(v.latitude) || !isFiniteNumber(v.longitude)) {
        issues.push({path, message: 'coords must be { latitude, longitude }'})
        return
    }
    if (v.latitude < -90 || v.latitude > 90 || v.longitude < -180 || v.longitude > 180) issues.push({path, message: 'coords out of range'})
}

function checkEnum(issues: Issues, v: unknown, path: string, allowed: string[], required: boolean) {
    if (v === undefined || v === null) {
        if (required) issues.push({path, message: `${path.split('.').pop()} is required (${allowed.join(', ')})`})
        return
    }
    if (typeof v !== 'string' || !allowed.includes(v)) issues.push({path, message: `must be one of: ${allowed.join(', ')}`})
}

function checkOptionalNumber(issues: Issues, v: unknown, path: string, opts: { min?: number; max?: number; integer?: boolean } = {}) {
    if (v === undefined || v === null) return
    if (!isFiniteNumber(v)) {
        issues.push({path, message: 'must be a number'})
        return
    }
    if (opts.integer && !Number.isInteger(v)) issues.push({path, message: 'must be an integer'})
    if (opts.min !== undefined && v < opts.min) issues.push({path, message: `must be >= ${opts.min}`})
    if (opts.max !== undefined && v > opts.max) issues.push({path, message: `must be <= ${opts.max}`})
}

function checkRequiredNumber(issues: Issues, v: unknown, path: string, opts: { min?: number; integer?: boolean } = {}) {
    if (!isFiniteNumber(v)) {
        issues.push({path, message: 'is required and must be a number'})
        return
    }
    checkOptionalNumber(issues, v, path, opts)
}

function checkOptionalString(issues: Issues, v: unknown, path: string, max = 200) {
    if (v === undefined || v === null) return
    if (typeof v !== 'string') issues.push({path, message: 'must be a string'})
    else if (v.length > max) issues.push({path, message: `must be at most ${max} characters`})
}

function checkTemplateRef(issues: Issues, v: unknown, path: string, kind: TemplateKind) {
    if (v === undefined || v === null) return
    if (!isRecord(v) || v.kind !== kind || !isNonEmptyString(v.id)) issues.push({path, message: `must be a template reference of kind ${kind}`})
}

/* ---------- per-record shape validators (no cross references) ---------- */

export function validateNetworkRecordShape(collection: NetworkCollectionName, record: unknown, path = ''): ValidationIssue[] {
    const issues: Issues = []
    const p = (k: string) => (path ? `${path}.${k}` : k)
    if (!isRecord(record)) return [{path, message: 'record must be an object'}]
    if (!isNonEmptyString(record.id) || !NETWORK_ID_PATTERN.test(record.id)) issues.push({path: p('id'), message: `id must match ${NETWORK_ID_PATTERN.source}`})
    checkOptionalString(issues, record.name, p('name'))
    if (record.planned !== undefined && typeof record.planned !== 'boolean') issues.push({path: p('planned'), message: 'planned must be true or false'})
    switch (collection) {
        case 'substationGroups': {
            if (!isNonEmptyString(record.groupName)) issues.push({path: p('groupName'), message: 'groupName is required'})
            checkCoords(issues, record.coords, p('coords'), true)
            if (record.generation !== undefined && typeof record.generation !== 'boolean') issues.push({path: p('generation'), message: 'generation must be true or false'})
            checkOptionalString(issues, record.extensionOf, p('extensionOf'))
            const gt = record.generationTypes
            if (gt !== undefined && gt !== null) {
                if (!Array.isArray(gt)) issues.push({path: p('generationTypes'), message: 'generationTypes must be an array'})
                else {
                    const seen = new Set<string>()
                    gt.forEach((t, i) => {
                        checkEnum(issues, t, p(`generationTypes.${i}`), enumValues(GenerationType), true)
                        if (typeof t === 'string' && seen.has(t)) issues.push({path: p(`generationTypes.${i}`), message: `duplicate generation type ${t}`})
                        if (typeof t === 'string') seen.add(t)
                    })
                }
            }
            break
        }
        case 'substations':
            if (!isNonEmptyString(record.groupId)) issues.push({path: p('groupId'), message: 'groupId is required'})
            if (!isNonEmptyString(record.yardName)) issues.push({path: p('yardName'), message: 'yardName is required'})
            checkEnum(issues, record.voltage, p('voltage'), enumValues(TransmissionVoltage), true)
            checkEnum(issues, record.arrangement, p('arrangement'), enumValues(SubstationArrangement), false)
            checkCoords(issues, record.coords, p('coords'), false)
            break
        case 'buses':
            if (!isNonEmptyString(record.substationId)) issues.push({path: p('substationId'), message: 'substationId is required'})
            checkEnum(issues, record.busType, p('busType'), enumValues(SubstationBusType), true)
            checkOptionalString(issues, record.busNumber, p('busNumber'), 20)
            checkOptionalString(issues, record.bayNumber, p('bayNumber'), 20)
            checkRequiredNumber(issues, record.row, p('row'), {integer: true, min: 0})
            checkEnum(issues, record.voltage, p('voltage'), enumValues(TransmissionVoltage), false)
            checkOptionalNumber(issues, record.current, p('current'), {min: 0})
            break
        case 'bays':
            if (!isNonEmptyString(record.substationId)) issues.push({path: p('substationId'), message: 'substationId is required'})
            if (!isNonEmptyString(record.bayNumber)) issues.push({path: p('bayNumber'), message: 'bayNumber is required'})
            checkRequiredNumber(issues, record.column, p('column'), {integer: true, min: 0})
            checkEnum(issues, record.voltage, p('voltage'), enumValues(TransmissionVoltage), false)
            checkOptionalNumber(issues, record.current, p('current'), {min: 0})
            break
        case 'equipments': {
            if (!isNonEmptyString(record.substationId)) issues.push({path: p('substationId'), message: 'substationId is required'})
            if (!isNonEmptyString(record.bayId)) issues.push({path: p('bayId'), message: 'bayId is required'})
            if (!isNonEmptyString(record.code)) issues.push({path: p('code'), message: 'code is required'})
            checkEnum(issues, record.equipmentType, p('equipmentType'), enumValues(SubstationEquipmentType), true)
            checkOptionalString(issues, record.brand, p('brand'))
            checkOptionalString(issues, record.model, p('model'))
            checkTemplateRef(issues, record.template, p('template'), TemplateKind.POWER_TRANSFORMER)
            checkRequiredNumber(issues, record.row, p('row'), {integer: true, min: 0})
            checkOptionalString(issues, record.takeOffId, p('takeOffId'))
            if (record.lineSide !== undefined && typeof record.lineSide !== 'boolean') issues.push({path: p('lineSide'), message: 'lineSide must be true or false'})
            if (record.busTie !== undefined && typeof record.busTie !== 'boolean') issues.push({path: p('busTie'), message: 'busTie must be true or false'})
            const terminals = record.terminals
            if (!Array.isArray(terminals) || terminals.length === 0) issues.push({path: p('terminals'), message: 'at least one terminal is required'})
            else {
                const keys = new Set<string>()
                terminals.forEach((t, i) => {
                    if (!isRecord(t) || !isNonEmptyString(t.key)) {
                        issues.push({path: p(`terminals.${i}`), message: 'terminal must have a key'})
                        return
                    }
                    if (keys.has(t.key)) issues.push({path: p(`terminals.${i}.key`), message: `duplicate terminal key ${t.key}`})
                    keys.add(t.key)
                    checkEnum(issues, t.voltage, p(`terminals.${i}.voltage`), enumValues(TransmissionVoltage), false)
                })
            }
            if (record.attributes !== undefined && !isRecord(record.attributes)) issues.push({path: p('attributes'), message: 'attributes must be an object'})
            if (record.windings !== undefined) {
                for (const i of validateTransformerWindings(record.windings)) issues.push({...i, path: p(i.path)})
                if (isRecord(record.windings) && Array.isArray(terminals)) {
                    const keys = Object.keys(record.windings), termKeys = terminals.map(t => isRecord(t) ? t.key : undefined)
                    if (keys.length !== termKeys.length || keys.some(k => !termKeys.includes(k))) issues.push({path: p('terminals'), message: `terminals must be one per winding (${keys.join(', ')}): they are derived from the windings`})
                }
            }
            break
        }
        case 'takeOffs':
            if (!isNonEmptyString(record.substationId)) issues.push({path: p('substationId'), message: 'substationId is required'})
            if (!isNonEmptyString(record.lineName)) issues.push({path: p('lineName'), message: 'lineName is required'})
            checkOptionalString(issues, record.bayId, p('bayId'))
            checkOptionalNumber(issues, record.row, p('row'), {integer: true, min: 0})
            if (record.takeOffColumn !== undefined && typeof record.takeOffColumn !== 'boolean') issues.push({path: p('takeOffColumn'), message: 'takeOffColumn must be true or false'})
            checkEnum(issues, record.voltage, p('voltage'), enumValues(TransmissionVoltage), false)
            break
        case 'junctions':
            checkCoords(issues, record.coords, p('coords'), true)
            checkOptionalString(issues, record.groupId, p('groupId'))
            break
        case 'circuits':
            if (!isNonEmptyString(record.name)) issues.push({path: p('name'), message: 'name is required'})
            checkEnum(issues, record.voltage, p('voltage'), enumValues(TransmissionVoltage), false)
            checkEnum(issues, record.energizedVoltage, p('energizedVoltage'), enumValues(TransmissionVoltage), false)
            checkOptionalNumber(issues, record.bundle, p('bundle'), {integer: true, min: 1})
            checkOptionalNumber(issues, record.lineGroup, p('lineGroup'), {integer: true, min: 1})
            checkOptionalNumber(issues, record.groupCircuit, p('groupCircuit'), {integer: true, min: 1})
            checkOptionalString(issues, record.conductorTemplateId, p('conductorTemplateId'))
            if (record.conductor !== undefined && record.conductor !== null) {
                const cd = record.conductor
                if (!isRecord(cd)) issues.push({path: p('conductor'), message: 'conductor must be { size, unit, type, code? }'})
                else {
                    checkRequiredNumber(issues, cd.size, p('conductor.size'), {min: 0})
                    checkEnum(issues, cd.unit, p('conductor.unit'), enumValues(TransmissionWireUnit), true)
                    checkEnum(issues, cd.type, p('conductor.type'), enumValues(TransmissionWireType), true)
                    checkOptionalString(issues, cd.code, p('conductor.code'), 50)
                }
            }
            checkOptionalNumber(issues, record.current, p('current'), {min: 0})
            checkOptionalNumber(issues, record.lengthKm, p('lengthKm'), {min: 0})
            checkOptionalString(issues, record.lineId, p('lineId'))
            if (record.pathId !== undefined && !isNonEmptyString(record.pathId)) issues.push({path: p('pathId'), message: 'pathId must be a non-empty string when set (a circuit may have no path)'})
            break
        case 'paths':
            if (!isNonEmptyString(record.name)) issues.push({path: p('name'), message: 'name is required'})
            for (const end of ['from', 'to'] as const) {
                const r = record[end]
                if (r === undefined || r === null) continue
                if (!isRecord(r) || !enumValues(ConnectionJunctionKind).includes(String(r.kind)) || !isNonEmptyString(r.id)) issues.push({path: p(end), message: `${end} must be { kind: SUBSTATION_GROUP | TRANSMISSION_JUNCTION, id } (a route runs between sites and junctions)`})
            }
            if (!Array.isArray(record.waypoints)) issues.push({path: p('waypoints'), message: 'waypoints must be an array of coords'})
            else record.waypoints.forEach((c, i) => checkCoords(issues, c, p(`waypoints.${i}`), true))
            break
        case 'lines': {
            if (!isNonEmptyString(record.name)) issues.push({path: p('name'), message: 'name is required'})
            checkEnum(issues, record.voltage, p('voltage'), enumValues(TransmissionVoltage), false)
            for (const end of ['from', 'to'] as const) {
                const r = record[end]
                if (r === undefined || r === null) continue
                if (!isRecord(r) || (r.kind !== ConnectionJunctionKind.SUBSTATION && r.kind !== ConnectionJunctionKind.TRANSMISSION_JUNCTION) || !isNonEmptyString(r.id)) {
                    issues.push({path: p(end), message: `${end} must be { kind: SUBSTATION | TRANSMISSION_JUNCTION, id } (a line ends at a yard, or at a junction where it stays open or ties in)`})
                }
            }
            const ids = record.circuitIds
            if (!Array.isArray(ids)) issues.push({path: p('circuitIds'), message: 'circuitIds must be an array of circuit ids'})
            else {
                const seen = new Set<string>()
                ids.forEach((id, i) => {
                    if (!isNonEmptyString(id)) issues.push({path: p(`circuitIds.${i}`), message: 'circuit id must be a string'})
                    else if (seen.has(id)) issues.push({path: p(`circuitIds.${i}`), message: `duplicate circuit "${id}" in line`})
                    seen.add(String(id))
                })
            }
            break
        }
        case 'yardConnections': {
            if (!isNonEmptyString(record.name)) issues.push({path: p('name'), message: 'name is required'})
            if (!isNonEmptyString(record.yardAId)) issues.push({path: p('yardAId'), message: 'yardAId is required'})
            if (!isNonEmptyString(record.yardBId)) issues.push({path: p('yardBId'), message: 'yardBId is required'})
            checkEnum(issues, record.voltage, p('voltage'), enumValues(TransmissionVoltage), false)
            const nodes = record.nodes
            if (!Array.isArray(nodes)) issues.push({path: p('nodes'), message: 'nodes must be an array'})
            else {
                const seen = new Set<string>()
                nodes.forEach((n, i) => {
                    if (!isRecord(n) || !enumValues(NetworkNodeKind).includes(String(n.kind)) || !isNonEmptyString(n.id)) {
                        issues.push({path: p(`nodes.${i}`), message: 'node must be { kind, id, terminal? }'})
                        return
                    }
                    if (n.kind === NetworkNodeKind.TRANSMISSION_CIRCUIT) issues.push({path: p(`nodes.${i}`), message: 'a yard link joins buses, equipment terminals and take-offs only'})
                    if (n.kind === NetworkNodeKind.EQUIPMENT_TERMINAL && !isNonEmptyString(n.terminal)) issues.push({path: p(`nodes.${i}.terminal`), message: 'equipment terminal key is required'})
                    const key = nodeKey(n as unknown as NetworkNodeRef)
                    if (seen.has(key)) issues.push({path: p(`nodes.${i}`), message: 'duplicate node in yard link'})
                    seen.add(key)
                })
            }
            break
        }
        case 'connections': {
            checkEnum(issues, record.scope, p('scope'), enumValues(ConnectionScope), true)
            checkEnum(issues, record.voltage, p('voltage'), enumValues(TransmissionVoltage), false)
            checkOptionalNumber(issues, record.current, p('current'), {min: 0})
            const j = record.junction
            if (!isRecord(j) || !enumValues(ConnectionJunctionKind).includes(String(j.kind)) || !isNonEmptyString(j.id)) {
                issues.push({path: p('junction'), message: 'junction must be { kind: SUBSTATION | TRANSMISSION_JUNCTION, id }'})
            }
            const nodes = record.nodes
            if (!Array.isArray(nodes) || nodes.length < 1) issues.push({path: p('nodes'), message: 'nodes must be a non-empty array'})
            else {
                const seen = new Set<string>()
                nodes.forEach((n, i) => {
                    if (!isRecord(n) || !enumValues(NetworkNodeKind).includes(String(n.kind)) || !isNonEmptyString(n.id)) {
                        issues.push({path: p(`nodes.${i}`), message: 'node must be { kind, id, terminal? }'})
                        return
                    }
                    if (n.kind === NetworkNodeKind.EQUIPMENT_TERMINAL && !isNonEmptyString(n.terminal)) issues.push({path: p(`nodes.${i}.terminal`), message: 'equipment terminal key is required'})
                    if (n.kind === NetworkNodeKind.TRANSMISSION_CIRCUIT && n.terminal !== CIRCUIT_END_FROM && n.terminal !== CIRCUIT_END_TO) issues.push({path: p(`nodes.${i}.terminal`), message: 'circuit end must be FROM or TO'})
                    const key = nodeKey(n as unknown as NetworkNodeRef)
                    if (seen.has(key)) issues.push({path: p(`nodes.${i}`), message: 'duplicate node in connection'})
                    seen.add(key)
                })
            }
            break
        }
        default:
            issues.push({path, message: `unknown collection ${String(collection)}`})
    }
    return issues
}

/* ---------- whole document ---------- */

export interface NetworkIndex {
    byId: Map<string, { collection: NetworkCollectionName; record: AnyNetworkRecord }>
}

export function indexNetwork(doc: NetworkDocument): NetworkIndex {
    const byId = new Map<string, { collection: NetworkCollectionName; record: AnyNetworkRecord }>()
    for (const c of networkCollectionNames) for (const r of doc[c]) if (!byId.has(r.id)) byId.set(r.id, {collection: c, record: r})
    return {byId}
}

export function validateNetworkDocument(doc: unknown): ValidationIssue[] {
    const issues: Issues = []
    if (!isRecord(doc)) return [{path: '', message: 'document must be an object'}]
    if (doc.format !== NETWORK_DOCUMENT_FORMAT) issues.push({path: 'format', message: `format must be "${NETWORK_DOCUMENT_FORMAT}"`})
    if (doc.version !== NETWORK_DOCUMENT_VERSION) issues.push({path: 'version', message: `version must be ${NETWORK_DOCUMENT_VERSION}`})
    if (!isNonEmptyString(doc.name)) issues.push({path: 'name', message: 'name is required'})
    checkOptionalString(issues, doc.description, 'description', 2000)

    // shapes + id uniqueness
    const ids = new Map<string, string>()
    for (const c of networkCollectionNames) {
        const list = doc[c]
        if (!Array.isArray(list)) {
            issues.push({path: c, message: `${c} must be an array`})
            continue
        }
        list.forEach((r, i) => {
            issues.push(...validateNetworkRecordShape(c, r, `${c}.${i}`))
            if (isRecord(r) && typeof r.id === 'string') {
                const prev = ids.get(r.id)
                if (prev) issues.push({path: `${c}.${i}.id`, message: `duplicate id "${r.id}" (also in ${prev})`})
                else ids.set(r.id, `${c}.${i}`)
            }
        })
    }
    if (issues.length) return issues  // references are only meaningful on well-formed documents

    const d = doc as unknown as NetworkDocument
    const index = indexNetwork(d)
    const ref = (path: string, id: string | undefined, collection: NetworkCollectionName, what: string, required = true) => {
        if (id === undefined) return undefined
        const hit = index.byId.get(id)
        if (!hit || hit.collection !== collection) {
            issues.push({path, message: `${what} "${id}" does not exist`})
            return undefined
        }
        return hit.record as AnyNetworkRecord
    }

    d.substations.forEach((s, i) => ref(`substations.${i}.groupId`, s.groupId, 'substationGroups', 'substation group'))
    // A site may extend another one, one level deep.
    d.substationGroups.forEach((g, i) => {
        if (!g.extensionOf) return
        const path = `substationGroups.${i}.extensionOf`
        if (g.extensionOf === g.id) return void issues.push({path, message: 'a site cannot be an extension of itself'})
        const parent = ref(path, g.extensionOf, 'substationGroups', 'substation group') as SubstationGroupRecord | undefined
        if (parent?.extensionOf) issues.push({path, message: `site ${parent.groupName} is an extension of another site itself: extensions are one level deep`})
    })
    // A site owns at most one junction (its site junction).
    const siteJunctionSeen = new Map<string, string>()
    d.junctions.forEach((j, i) => {
        if (!j.groupId) return
        ref(`junctions.${i}.groupId`, j.groupId, 'substationGroups', 'substation group')
        const first = siteJunctionSeen.get(j.groupId)
        if (first) issues.push({path: `junctions.${i}.groupId`, message: `site ${j.groupId} already has the junction "${first}": a site has at most one junction`})
        else siteJunctionSeen.set(j.groupId, j.id)
    })
    d.buses.forEach((b, i) => ref(`buses.${i}.substationId`, b.substationId, 'substations', 'substation'))
    d.bays.forEach((b, i) => ref(`bays.${i}.substationId`, b.substationId, 'substations', 'substation'))
    d.equipments.forEach((e, i) => {
        ref(`equipments.${i}.substationId`, e.substationId, 'substations', 'substation')
        const bay = ref(`equipments.${i}.bayId`, e.bayId, 'bays', 'bay') as NetworkDocument['bays'][number] | undefined
        if (bay && bay.substationId !== e.substationId) issues.push({path: `equipments.${i}.bayId`, message: 'bay belongs to another substation'})
        if (e.takeOffId) {
            const t = ref(`equipments.${i}.takeOffId`, e.takeOffId, 'takeOffs', 'take-off') as NetworkDocument['takeOffs'][number] | undefined
            if (t && t.substationId !== e.substationId) issues.push({path: `equipments.${i}.takeOffId`, message: 'take-off belongs to another substation'})
        }
    })
    d.takeOffs.forEach((t, i) => {
        ref(`takeOffs.${i}.substationId`, t.substationId, 'substations', 'substation')
        const bay = ref(`takeOffs.${i}.bayId`, t.bayId, 'bays', 'bay') as NetworkDocument['bays'][number] | undefined
        if (bay && bay.substationId !== t.substationId) issues.push({path: `takeOffs.${i}.bayId`, message: 'bay belongs to another substation'})
    })
    d.paths.forEach((pth, i) => {
        for (const end of ['from', 'to'] as const) {
            const r = pth[end]
            if (!r) continue
            // Path ends name sites (SUBSTATION_GROUP) or junctions; a yard (SUBSTATION) is a legacy end that `migrateNetworkDocument` lifts to its site.
            const target = r.kind === ConnectionJunctionKind.SUBSTATION_GROUP ? ['substationGroups', 'site'] as const
                : r.kind === ConnectionJunctionKind.SUBSTATION ? ['substations', 'substation'] as const : ['junctions', 'junction'] as const
            ref(`paths.${i}.${end}.id`, r.id, target[0], target[1])
        }
    })
    d.lines.forEach((l, i) => {
        for (const end of ['from', 'to'] as const) {
            const r = l[end]
            if (!r) continue
            if (r.kind === ConnectionJunctionKind.TRANSMISSION_JUNCTION) ref(`lines.${i}.${end}.id`, r.id, 'junctions', 'junction')
            else ref(`lines.${i}.${end}.id`, r.id, 'substations', 'substation')
        }
        l.circuitIds.forEach((id, k) => ref(`lines.${i}.circuitIds.${k}`, id, 'circuits', 'circuit'))
    })
    d.circuits.forEach((c, i) => {
        if (c.pathId === undefined) {
            // Without a path the map draws a circuit as a dashed line between its attached ends; with one end (or none) it cannot be drawn.
            const attached = [CIRCUIT_END_FROM, CIRCUIT_END_TO].filter(end => d.connections.some(x => x.scope === ConnectionScope.TRANSMISSION
                && x.nodes.some(n => n.kind === NetworkNodeKind.TRANSMISSION_CIRCUIT && n.id === c.id && n.terminal === end))).length
            if (attached < 2) issues.push({
                path: `circuits.${i}`, severity: 'warning',
                message: `has no path and ${attached ? 'only one end' : 'no end'} attached: it cannot be drawn on the map (attach ${attached ? 'the other end' : 'both ends'} or give it a path)`,
            })
            return
        }
        const pth = ref(`circuits.${i}.pathId`, c.pathId, 'paths', 'transmission path') as NetworkDocument['paths'][number] | undefined
        if (!pth) return
        // A circuit end that is connected somewhere must be connected where its path ends.
        for (const [end, pathEnd] of [[CIRCUIT_END_FROM, pth.from], [CIRCUIT_END_TO, pth.to]] as const) {
            if (!pathEnd) continue
            const conn = d.connections.find(x => x.scope === ConnectionScope.TRANSMISSION && x.nodes.some(n => n.kind === NetworkNodeKind.TRANSMISSION_CIRCUIT && n.id === c.id && n.terminal === end))
            if (conn && !atPathEnd(d, conn.junction, pathEnd)) {
                issues.push({path: `circuits.${i}`, message: `${end} end is connected at ${conn.junction.id} but the path "${pth.name}" ${end === CIRCUIT_END_FROM ? 'starts' : 'ends'} at ${pathEnd.id}`})
            }
        }
    })

    // connections
    const used = new Map<string, string>() // `${scope}:${nodeKey}` -> connection id
    d.connections.forEach((conn, i) => {
        const p = `connections.${i}`
        const isYard = conn.junction.kind === ConnectionJunctionKind.SUBSTATION
        const junction = ref(`${p}.junction.id`, conn.junction.id, isYard ? 'substations' : 'junctions', isYard ? 'substation' : 'junction')
        const kinds = {bus: 0, terminal: 0, takeOff: 0, circuit: 0}
        conn.nodes.forEach((n, k) => {
            const np = `${p}.nodes.${k}`
            const usedKey = `${conn.scope}:${nodeKey(n)}`
            if (n.kind !== NetworkNodeKind.SUBSTATION_BUS) {
                const other = used.get(usedKey)
                if (other) issues.push({path: np, message: `node already used by connection "${other}" in scope ${conn.scope}`})
                used.set(usedKey, conn.id)
            }
            switch (n.kind) {
                case NetworkNodeKind.SUBSTATION_BUS: {
                    kinds.bus++
                    const bus = ref(np, n.id, 'buses', 'bus') as NetworkDocument['buses'][number] | undefined
                    if (bus && junction && isYard && bus.substationId !== conn.junction.id) issues.push({path: np, message: 'bus belongs to another substation'})
                    break
                }
                case NetworkNodeKind.EQUIPMENT_TERMINAL: {
                    kinds.terminal++
                    const eq = ref(np, n.id, 'equipments', 'equipment') as NetworkDocument['equipments'][number] | undefined
                    if (eq) {
                        if (!eq.terminals.some(t => t.key === n.terminal)) issues.push({path: np, message: `equipment "${eq.id}" has no terminal "${n.terminal}"`})
                        if (isYard && eq.substationId !== conn.junction.id) issues.push({path: np, message: 'equipment belongs to another substation'})
                    }
                    break
                }
                case NetworkNodeKind.SUBSTATION_TAKE_OFF: {
                    kinds.takeOff++
                    const t = ref(np, n.id, 'takeOffs', 'take-off') as NetworkDocument['takeOffs'][number] | undefined
                    if (t && isYard && t.substationId !== conn.junction.id) issues.push({path: np, message: 'take-off belongs to another substation'})
                    break
                }
                case NetworkNodeKind.TRANSMISSION_CIRCUIT:
                    kinds.circuit++
                    ref(np, n.id, 'circuits', 'circuit')
                    break
            }
        })
        if (conn.scope === ConnectionScope.SUBSTATION) {
            if (!isYard) issues.push({path: `${p}.junction`, message: 'SUBSTATION connections must be located at a substation'})
            if (kinds.circuit > 0) issues.push({path: `${p}.nodes`, message: 'SUBSTATION connections cannot contain circuit ends'})
            if (conn.nodes.length < 2) issues.push({path: `${p}.nodes`, message: 'a substation connection needs at least two nodes'})
        } else {
            if (kinds.bus > 0 || kinds.terminal > 0) issues.push({path: `${p}.nodes`, message: 'TRANSMISSION connections may only contain take-offs and circuit ends'})
            if (kinds.circuit < 1) issues.push({path: `${p}.nodes`, message: 'a transmission connection needs at least one circuit end'})
            if (isYard) {
                if (kinds.takeOff !== 1) issues.push({path: `${p}.nodes`, message: 'a transmission connection at a substation must start from exactly one take-off'})
            } else if (kinds.takeOff > 0) {
                issues.push({path: `${p}.nodes`, message: 'take-offs cannot be connected at a line junction'})
            }
            if (!isYard && !(typeof conn.name === 'string' && conn.name.trim())) issues.push({path: `${p}.name`, message: 'a connection at a junction must have a name'})
        }
    })

    // yard links: two different yards, nodes of those yards only, a node in at most one link
    const linked = new Map<string, string>()
    ;(d.yardConnections ?? []).forEach((yc, i) => {
        const p = `yardConnections.${i}`
        const a = ref(`${p}.yardAId`, yc.yardAId, 'substations', 'substation')
        const b = ref(`${p}.yardBId`, yc.yardBId, 'substations', 'substation')
        if (a && b && yc.yardAId === yc.yardBId) issues.push({path: `${p}.yardBId`, message: 'a yard link joins two different yards'})
        yc.nodes.forEach((n, k) => {
            const np = `${p}.nodes.${k}`
            const key = nodeKey(n)
            const other = linked.get(key)
            if (other) issues.push({path: np, message: `node already used by yard link "${other}"`})
            linked.set(key, yc.id)
            let owner: string | undefined
            switch (n.kind) {
                case NetworkNodeKind.SUBSTATION_BUS:
                    owner = (ref(np, n.id, 'buses', 'bus') as NetworkDocument['buses'][number] | undefined)?.substationId
                    break
                case NetworkNodeKind.EQUIPMENT_TERMINAL: {
                    const eq = ref(np, n.id, 'equipments', 'equipment') as NetworkDocument['equipments'][number] | undefined
                    if (eq && !eq.terminals.some(t => t.key === n.terminal)) issues.push({path: np, message: `equipment "${eq.id}" has no terminal "${n.terminal}"`})
                    owner = eq?.substationId
                    break
                }
                case NetworkNodeKind.SUBSTATION_TAKE_OFF:
                    owner = (ref(np, n.id, 'takeOffs', 'take-off') as NetworkDocument['takeOffs'][number] | undefined)?.substationId
                    break
                default:
                    break
            }
            if (owner && owner !== yc.yardAId && owner !== yc.yardBId) issues.push({path: np, message: 'node belongs to neither yard of the link'})
        })
    })

    // Planned (not built yet) records used by records that are not planned: warnings, never blocking.
    const warn = (path: string, message: string) => issues.push({path, message, severity: 'warning'})
    const byId = <T extends { id: string }>(list: T[]) => new Map(list.map(r => [r.id, r]))
    const groups = byId(d.substationGroups), yards = byId(d.substations), takeOffs = byId(d.takeOffs), circuits = byId(d.circuits)
    d.substations.forEach((y, i) => {
        if (!y.planned && groups.get(y.groupId)?.planned) warn(`substations.${i}.planned`, `yard ${y.yardName} is built but its site ${groups.get(y.groupId)!.groupName} is planned`)
    })
    d.takeOffs.forEach((t, i) => {
        if (!t.planned && yards.get(t.substationId)?.planned) warn(`takeOffs.${i}.planned`, `take-off ${t.lineName} is built but its yard is planned`)
        if (!t.takeOffColumn) warn(`takeOffs.${i}.takeOffColumn`, `take-off ${t.lineName} is drawn in the bay column: tick "take-off column" to move it right of the bay`)
    })
    // A power transformer belongs in the line column of its bay, like a take-off: unflagged it is drawn in the bay column.
    d.equipments.forEach((e, i) => {
        if (e.equipmentType === SubstationEquipmentType.POWER_TRANSFORMER && !e.lineSide) warn(`equipments.${i}.lineSide`, `power transformer ${e.code} is drawn in the bay column: tick "line side" to move it to the line column, like a take-off`)
    })
    // A power transformer's wiring goes to the line side of its bay: every other equipment on a node with a transformer terminal
    // should be flagged "line side" (buses and unflagged equipment on that node are reported).
    const equipmentById = byId(d.equipments), busById = byId(d.buses)
    const transformerWiring = (path: string, nodes: NetworkNodeRef[], where: string) => {
        const isTransformer = (n: NetworkNodeRef) => n.kind === NetworkNodeKind.EQUIPMENT_TERMINAL && equipmentById.get(n.id)?.equipmentType === SubstationEquipmentType.POWER_TRANSFORMER
        const transformers = nodes.filter(isTransformer)
        if (!transformers.length) return
        const offSide = nodes.filter(n => !isTransformer(n)).filter(n =>
            n.kind === NetworkNodeKind.SUBSTATION_BUS ? busById.has(n.id) : n.kind === NetworkNodeKind.EQUIPMENT_TERMINAL && equipmentById.has(n.id) && !equipmentById.get(n.id)!.lineSide)
        if (!offSide.length) return
        const label = (n: NetworkNodeRef) => n.kind === NetworkNodeKind.SUBSTATION_BUS ? `bus ${busById.get(n.id)!.name ?? n.id}` : `${equipmentById.get(n.id)!.code} ${n.terminal}`
        const codes = [...new Set(transformers.map(n => equipmentById.get(n.id)!.code))].join(', ')
        warn(path, `power transformer ${codes} ${where} is wired to ${offSide.map(label).join(', ')}, not line-side equipment: flag the equipment "line side" (take-off column) or rewire the transformer`)
    }
    d.connections.forEach((c, i) => {
        if (c.scope === ConnectionScope.SUBSTATION) transformerWiring(`connections.${i}.nodes`, c.nodes, `in connection ${c.name ?? c.id}`)
    })
    ;(d.yardConnections ?? []).forEach((l, i) => transformerWiring(`yardConnections.${i}.nodes`, l.nodes, `in yard link ${l.name}`))
    // In-yard wiring is at the connection's own voltage, else the yard's. A bus or take-off with its own voltage should sit on a
    // connection at that voltage, and two connections bridged by one piece of equipment (other than a transformer, whose windings
    // differ by design) should be at the same voltage.
    const nodeVoltage = (c: ConnectionRecord) => c.voltage ?? yards.get(c.junction.id)?.voltage
    const byEquipment = new Map<string, { c: ConnectionRecord; i: number; terminal?: string }[]>()
    d.connections.forEach((c, i) => {
        if (c.scope !== ConnectionScope.SUBSTATION) return
        const v = nodeVoltage(c)
        const label = c.name ?? c.id
        for (const n of c.nodes) {
            if (n.kind === NetworkNodeKind.EQUIPMENT_TERMINAL) byEquipment.set(n.id, [...(byEquipment.get(n.id) ?? []), {c, i, terminal: n.terminal}])
            else if (n.kind === NetworkNodeKind.SUBSTATION_BUS) {
                const b = busById.get(n.id)
                if (b?.voltage && v && b.voltage !== v) warn(`connections.${i}.voltage`, `connection ${label} at ${v}${c.voltage ? '' : ' (the yard voltage)'} holds bus ${b.name ?? b.id} at ${b.voltage}: set the connection voltage to match`)
            } else if (n.kind === NetworkNodeKind.SUBSTATION_TAKE_OFF) {
                const t = takeOffs.get(n.id)
                if (t?.voltage && v && t.voltage !== v) warn(`connections.${i}.voltage`, `connection ${label} at ${v}${c.voltage ? '' : ' (the yard voltage)'} holds take-off ${t.lineName} at ${t.voltage}: set the connection voltage to match`)
            }
        }
    })
    for (const [id, uses] of byEquipment) {
        const e = equipmentById.get(id)
        if (!e || isTransformerType(e.equipmentType) || uses.length < 2) continue
        const volts = new Set(uses.map(u => nodeVoltage(u.c)).filter((v): v is TransmissionVoltage => !!v))
        if (volts.size > 1) warn(`connections.${uses[0].i}.voltage`, `${e.code} joins connections at different voltages: ${uses.map(u => `${u.c.name ?? u.c.id} (${u.terminal}) at ${nodeVoltage(u.c)}${u.c.voltage ? '' : ', the yard voltage'}`).join('; ')}`)
    }
    // The winding wired inside a yard should be the one of that yard's voltage, or of the take-off's own voltage when the node holds
    // a take-off at another voltage (a secondary / auxiliary line leaving the yard); the other windings leave through yard links.
    d.connections.forEach((c, i) => {
        if (c.scope !== ConnectionScope.SUBSTATION) return
        const yard = yards.get(c.junction.id)
        if (!yard) return
        const takeOffVoltage = c.nodes.filter(n => n.kind === NetworkNodeKind.SUBSTATION_TAKE_OFF).map(n => takeOffs.get(n.id)?.voltage).find(v => !!v)
        const expected = takeOffVoltage ?? yard.voltage
        for (const n of c.nodes) {
            if (n.kind !== NetworkNodeKind.EQUIPMENT_TERMINAL) continue
            const e = equipmentById.get(n.id)
            if (!e || e.equipmentType !== SubstationEquipmentType.POWER_TRANSFORMER) continue
            const t = e.terminals.find(t => t.key === n.terminal)
            if (!t?.voltage || t.voltage === expected) continue
            warn(`connections.${i}.nodes`, takeOffVoltage
                ? `power transformer ${e.code} terminal ${t.key} (${t.voltage}) is wired to a ${takeOffVoltage} take-off: wire the ${takeOffVoltage} winding there`
                : `power transformer ${e.code} terminal ${t.key} (${t.voltage}) is wired inside the ${yard.voltage} yard: wire its ${yard.voltage} winding here and take ${t.key} to the other yard through a yard link, or to a take-off set to ${t.voltage} (place the transformer so the wired winding faces the bay stack: below it in a higher-voltage yard, above it in a lower one)`)
        }
    })
    d.connections.forEach((conn, i) => {
        if (conn.planned) return
        if (conn.junction.kind === ConnectionJunctionKind.SUBSTATION && yards.get(conn.junction.id)?.planned) warn(`connections.${i}.planned`, `connection ${conn.name ?? conn.id} is built but its yard is planned`)
        conn.nodes.forEach((n, k) => {
            if (n.kind === NetworkNodeKind.SUBSTATION_TAKE_OFF && takeOffs.get(n.id)?.planned) warn(`connections.${i}.nodes.${k}`, `connection ${conn.name ?? conn.id} is built but uses the planned take-off ${takeOffs.get(n.id)!.lineName}`)
            if (n.kind === NetworkNodeKind.TRANSMISSION_CIRCUIT && circuits.get(n.id)?.planned) warn(`connections.${i}.nodes.${k}`, `connection ${conn.name ?? conn.id} is built but joins the planned circuit ${circuits.get(n.id)!.name}`)
        })
    })
    d.circuits.forEach((c, i) => {
        if (c.planned) return
        for (const conn of d.connections) {
            if (conn.planned && conn.nodes.some(n => n.kind === NetworkNodeKind.TRANSMISSION_CIRCUIT && n.id === c.id)) warn(`circuits.${i}.planned`, `circuit ${c.name} is built but is joined in the planned connection ${conn.name ?? conn.id}`)
        }
    })
    // two circuits of one path at the same tower position
    const towerSeen = new Map<string, string>()
    d.circuits.forEach((c, i) => {
        if (!c.pathId || c.lineGroup === undefined || c.groupCircuit === undefined) return
        const key = `${c.pathId}|${c.lineGroup}|${c.groupCircuit}`
        const first = towerSeen.get(key)
        if (first) warn(`circuits.${i}.groupCircuit`, `circuit ${c.name} takes the tower position of ${first} (group ${c.lineGroup}, circuit ${c.groupCircuit}) on the same path`)
        else towerSeen.set(key, c.name)
    })
    d.lines.forEach((l, i) => {
        if (l.planned) return
        l.circuitIds.forEach((id, k) => {
            if (circuits.get(id)?.planned) warn(`lines.${i}.circuitIds.${k}`, `line ${l.name} is built but its section ${circuits.get(id)!.name} is planned`)
        })
        for (const end of ['from', 'to'] as const) if (l[end] && yards.get(l[end]!.id)?.planned) warn(`lines.${i}.${end}`, `line ${l.name} is built but its ${end} yard is planned`)
    })
    return issues
}

/* ---------- ops ---------- */

export function validateNetworkOp(op: unknown, path = ''): ValidationIssue[] {
    const p = (k: string) => (path ? `${path}.${k}` : k)
    if (!isRecord(op)) return [{path, message: 'op must be an object'}]
    switch (op.type) {
        case 'upsert': {
            const c = op.collection as NetworkCollectionName
            if (!networkCollectionNames.includes(c)) return [{path: p('collection'), message: `unknown collection "${String(op.collection)}"`}]
            return validateNetworkRecordShape(c, op.record, p('record'))
        }
        case 'delete': {
            const issues: Issues = []
            if (!networkCollectionNames.includes(op.collection as NetworkCollectionName)) issues.push({path: p('collection'), message: `unknown collection "${String(op.collection)}"`})
            if (!isNonEmptyString(op.id)) issues.push({path: p('id'), message: 'id is required'})
            return issues
        }
        case 'meta': {
            const issues: Issues = []
            if (op.name !== undefined && !isNonEmptyString(op.name)) issues.push({path: p('name'), message: 'name must be a non-empty string'})
            checkOptionalString(issues, op.description, p('description'), 2000)
            return issues
        }
        default:
            return [{path: p('type'), message: 'type must be upsert, delete or meta'}]
    }
}

export function validateNetworkOps(ops: unknown): ValidationIssue[] {
    if (!Array.isArray(ops)) return [{path: 'ops', message: 'ops must be an array'}]
    if (ops.length === 0) return [{path: 'ops', message: 'ops must not be empty'}]
    return ops.flatMap((op, i) => validateNetworkOp(op, `ops.${i}`))
}

export type {NetworkOp}
