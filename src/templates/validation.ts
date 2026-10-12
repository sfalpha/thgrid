/**
 * Dependency-free validators shared by the backend (authoritative) and the web
 * UI (instant feedback). Each validator returns a list of issues; an empty list
 * means the payload is valid.
 */
import {TransmissionVoltage} from "../models/transmission.voltage";
import {TransmissionWireType, TransmissionWireUnit} from "../models/transmission.conductor";
import {
    TransformerCooling,
    TransformerWindingSide,
    TransformerWindingTapChanger,
    TransformerWindingWiring
} from "../models/transformer";
import {TemplateKind, TemplateRef, TEMPLATE_ID_PATTERN} from "./template";
import {SubstationArrangement} from "../models/substation";
import {SubstationBusType} from "../models/substation.bus";
import {BayTemplateType} from "../models/substation.bay";
import {SubstationEquipmentType} from "../models/substation.equipment";

export interface ValidationIssue {
    /** JSON-pointer-like path into the payload, e.g. `windings.H.ratings.0.power`. Empty string = whole document. */
    path: string
    message: string
    /** Absent or `error`: blocks a save. `warning`: shown, never blocks (e.g. a planned record used by one that is not planned). */
    severity?: 'error' | 'warning'
}

/** Lets validators check cross-template references without knowing about storage. */
export interface ValidationContext {
    /** Returns true when a template with this reference exists. */
    exists(ref: TemplateRef): boolean
}

export const NO_CONTEXT: ValidationContext = {exists: () => true}

export const WINDING_KEY_PATTERN = /^[A-Za-z0-9_-]{1,16}$/

/* ---------- primitives ---------- */

type Issues = ValidationIssue[]

function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function enumValues<T extends Record<string, string>>(e: T): string[] {
    return Object.values(e)
}

function requireString(issues: Issues, obj: Record<string, unknown>, key: string, path: string, opts: { max?: number } = {}) {
    const v = obj[key]
    if (typeof v !== 'string' || v.trim().length === 0) {
        issues.push({path, message: `${key} is required and must be a non-empty string`})
        return
    }
    if (opts.max && v.length > opts.max) issues.push({path, message: `${key} must be at most ${opts.max} characters`})
}

function optionalString(issues: Issues, obj: Record<string, unknown>, key: string, path: string, opts: { max?: number } = {}) {
    const v = obj[key]
    if (v === undefined || v === null) return
    if (typeof v !== 'string') {
        issues.push({path, message: `${key} must be a string`})
        return
    }
    if (opts.max && v.length > opts.max) issues.push({path, message: `${key} must be at most ${opts.max} characters`})
}

function requireNumber(issues: Issues, obj: Record<string, unknown>, key: string, path: string, opts: { min?: number; integer?: boolean } = {}) {
    const v = obj[key]
    if (typeof v !== 'number' || !Number.isFinite(v)) {
        issues.push({path, message: `${key} is required and must be a number`})
        return
    }
    if (opts.integer && !Number.isInteger(v)) issues.push({path, message: `${key} must be an integer`})
    if (opts.min !== undefined && v < opts.min) issues.push({path, message: `${key} must be >= ${opts.min}`})
}

function requireEnum(issues: Issues, obj: Record<string, unknown>, key: string, path: string, allowed: string[]) {
    const v = obj[key]
    if (typeof v !== 'string' || !allowed.includes(v)) {
        issues.push({path, message: `${key} must be one of: ${allowed.join(', ')}`})
    }
}

function optionalEnum(issues: Issues, obj: Record<string, unknown>, key: string, path: string, allowed: string[]) {
    const v = obj[key]
    if (v === undefined || v === null) return
    requireEnum(issues, obj, key, path, allowed)
}

function optionalBoolean(issues: Issues, obj: Record<string, unknown>, key: string, path: string) {
    const v = obj[key]
    if (v === undefined || v === null) return
    if (typeof v !== 'boolean') issues.push({path, message: `${key} must be a boolean`})
}

function optionalStringArray(issues: Issues, obj: Record<string, unknown>, key: string, path: string) {
    const v = obj[key]
    if (v === undefined || v === null) return
    if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) issues.push({path, message: `${key} must be an array of strings`})
}

/* ---------- ids / envelope ---------- */

export function validateTemplateId(id: unknown): ValidationIssue[] {
    if (typeof id !== 'string' || !TEMPLATE_ID_PATTERN.test(id)) {
        return [{path: 'id', message: 'id must match ^[a-z0-9][a-z0-9_-]{0,79}$'}]
    }
    return []
}

/** Validates the envelope fields of a `TemplateInput` (not `data`). */
export function validateTemplateEnvelope(input: unknown): ValidationIssue[] {
    const issues: Issues = []
    if (!isRecord(input)) return [{path: '', message: 'body must be an object'}]
    if (input.id !== undefined) issues.push(...validateTemplateId(input.id))
    optionalString(issues, input, 'description', 'description', {max: 2000})
    optionalStringArray(issues, input, 'tags', 'tags')
    if (!isRecord(input.data)) issues.push({path: 'data', message: 'data must be an object'})
    return issues
}

/* ---------- per-kind payload validators ---------- */

export function validateTransmissionConductorTemplate(data: unknown): ValidationIssue[] {
    const issues: Issues = []
    if (!isRecord(data)) return [{path: '', message: 'template must be an object'}]
    requireString(issues, data, 'name', 'name', {max: 120})
    requireNumber(issues, data, 'size', 'size', {min: 0})
    requireEnum(issues, data, 'unit', 'unit', enumValues(TransmissionWireUnit))
    requireEnum(issues, data, 'type', 'type', enumValues(TransmissionWireType))
    optionalString(issues, data, 'code', 'code', {max: 60})
    return issues
}

export function validateTransmissionCircuitTemplate(data: unknown, ctx: ValidationContext = NO_CONTEXT): ValidationIssue[] {
    const issues: Issues = []
    if (!isRecord(data)) return [{path: '', message: 'template must be an object'}]
    requireString(issues, data, 'name', 'name', {max: 120})
    optionalEnum(issues, data, 'voltage', 'voltage', enumValues(TransmissionVoltage))
    requireNumber(issues, data, 'bundle', 'bundle', {min: 1, integer: true})
    requireString(issues, data, 'conductorId', 'conductorId')
    if (typeof data.conductorId === 'string' && data.conductorId.length > 0) {
        issues.push(...validateTemplateId(data.conductorId).map(i => ({...i, path: 'conductorId'})))
        if (!ctx.exists({kind: TemplateKind.TRANSMISSION_CONDUCTOR, id: data.conductorId})) {
            issues.push({path: 'conductorId', message: `conductor template "${data.conductorId}" does not exist`})
        }
    }
    return issues
}

function validateWinding(key: string, winding: unknown, issues: Issues) {
    const base = `windings.${key}`
    if (!WINDING_KEY_PATTERN.test(key)) issues.push({path: base, message: 'winding key must match ^[A-Za-z0-9_-]{1,16}$'})
    if (!isRecord(winding)) {
        issues.push({path: base, message: 'winding must be an object'})
        return
    }
    requireEnum(issues, winding, 'windingSide', `${base}.windingSide`, enumValues(TransformerWindingSide))
    requireEnum(issues, winding, 'wiring', `${base}.wiring`, enumValues(TransformerWindingWiring))
    requireEnum(issues, winding, 'tapChanger', `${base}.tapChanger`, enumValues(TransformerWindingTapChanger))
    requireEnum(issues, winding, 'voltage', `${base}.voltage`, enumValues(TransmissionVoltage))
    const ratings = winding.ratings
    if (ratings === undefined || ratings === null) return
    if (!Array.isArray(ratings)) {
        issues.push({path: `${base}.ratings`, message: 'ratings must be an array'})
        return
    }
    ratings.forEach((r, i) => {
        const rp = `${base}.ratings.${i}`
        if (!isRecord(r)) {
            issues.push({path: rp, message: 'rating must be an object'})
            return
        }
        requireEnum(issues, r, 'cooling', `${rp}.cooling`, enumValues(TransformerCooling))
        requireNumber(issues, r, 'power', `${rp}.power`, {min: 0})
        if (typeof r.perModule !== 'boolean') issues.push({path: `${rp}.perModule`, message: 'perModule must be a boolean'})
    })
}

/** Validates a windings map (template or equipment record): keyed by winding code, at least one, exactly one PRIMARY. Paths start with `windings`. */
export function validateTransformerWindings(windings: unknown): ValidationIssue[] {
    const issues: Issues = []
    if (!isRecord(windings)) return [{path: 'windings', message: 'windings must be an object keyed by winding code (e.g. H, X, Y)'}]
    const keys = Object.keys(windings)
    if (keys.length === 0) issues.push({path: 'windings', message: 'at least one winding is required'})
    for (const key of keys) validateWinding(key, windings[key], issues)
    const primaries = keys.filter(k => isRecord(windings[k]) && (windings[k] as Record<string, unknown>).windingSide === TransformerWindingSide.PRIMARY)
    if (keys.length > 0 && primaries.length === 0) issues.push({path: 'windings', message: 'one winding must be the PRIMARY'})
    if (primaries.length > 1) issues.push({path: 'windings', message: 'only one winding may be the PRIMARY'})
    return issues
}

export function validatePowerTransformerTemplate(data: unknown): ValidationIssue[] {
    const issues: Issues = []
    if (!isRecord(data)) return [{path: '', message: 'template must be an object'}]
    requireString(issues, data, 'name', 'name', {max: 120})
    requireNumber(issues, data, 'modules', 'modules', {min: 1, integer: true})
    issues.push(...validateTransformerWindings(data.windings))
    return issues
}

export function validateSubstationYardTemplate(data: unknown): ValidationIssue[] {
    const issues: Issues = []
    if (!isRecord(data)) return [{path: '', message: 'template must be an object'}]
    requireString(issues, data, 'name', 'name', {max: 120})
    requireEnum(issues, data, 'arrangement', 'arrangement', enumValues(SubstationArrangement))
    optionalEnum(issues, data, 'voltage', 'voltage', enumValues(TransmissionVoltage))
    const buses = data.buses
    if (!Array.isArray(buses)) {
        issues.push({path: 'buses', message: 'buses must be an array (it may be empty)'})
        return issues
    }
    const seen = new Set<string>()
    const rows = new Set<number>()
    buses.forEach((b, i) => {
        const p = `buses.${i}`
        if (!isRecord(b)) {
            issues.push({path: p, message: 'bus must be an object'})
            return
        }
        requireString(issues, b, 'name', `${p}.name`, {max: 120})
        requireEnum(issues, b, 'busType', `${p}.busType`, enumValues(SubstationBusType))
        optionalString(issues, b, 'busNumber', `${p}.busNumber`, {max: 20})
        requireNumber(issues, b, 'row', `${p}.row`, {min: 0, integer: true})
        const key = b.busType === SubstationBusType.TRANSFER ? 'TRANSFER' : `MAIN:${typeof b.busNumber === 'string' && b.busNumber ? b.busNumber : '1'}`
        if (seen.has(key)) issues.push({path: p, message: `duplicate bus ${key.replace(':', ' ')}`})
        seen.add(key)
        if (typeof b.row === 'number') {
            if (rows.has(b.row)) issues.push({path: `${p}.row`, message: `row ${b.row} is used by another bus`})
            rows.add(b.row)
        }
    })
    return issues
}

export function validateSubstationBayTemplate(data: unknown): ValidationIssue[] {
    const issues: Issues = []
    if (!isRecord(data)) return [{path: '', message: 'template must be an object'}]
    requireString(issues, data, 'name', 'name', {max: 120})
    requireEnum(issues, data, 'bayTemplateType', 'bayTemplateType', enumValues(BayTemplateType))
    const arrangements = data.arrangements
    if (!Array.isArray(arrangements) || arrangements.length === 0) issues.push({path: 'arrangements', message: 'at least one suitable arrangement is required'})
    else {
        const allowed = enumValues(SubstationArrangement)
        arrangements.forEach((a, i) => {
            if (typeof a !== 'string' || !allowed.includes(a)) issues.push({path: `arrangements.${i}`, message: `arrangement must be one of: ${allowed.join(', ')}`})
        })
        if (new Set(arrangements).size !== arrangements.length) issues.push({path: 'arrangements', message: 'arrangements must not repeat'})
    }
    const equipments = data.equipments
    if (!Array.isArray(equipments) || equipments.length === 0) {
        issues.push({path: 'equipments', message: 'at least one equipment is required'})
        return issues
    }
    const sequences = new Set<number>()
    equipments.forEach((e, i) => {
        const p = `equipments.${i}`
        if (!isRecord(e)) {
            issues.push({path: p, message: 'equipment must be an object'})
            return
        }
        requireEnum(issues, e, 'equipmentType', `${p}.equipmentType`, enumValues(SubstationEquipmentType))
        requireNumber(issues, e, 'sequence', `${p}.sequence`, {min: 0, integer: true})
        optionalBoolean(issues, e, 'lineSide', `${p}.lineSide`)
        optionalBoolean(issues, e, 'busTie', `${p}.busTie`)
        if (typeof e.sequence === 'number') {
            if (sequences.has(e.sequence)) issues.push({path: `${p}.sequence`, message: `sequence ${e.sequence} is used by another equipment`})
            sequences.add(e.sequence)
        }
    })
    return issues
}

/** Dispatches to the right payload validator. Unknown kinds yield a single issue. */
export function validateTemplateData(kind: TemplateKind, data: unknown, ctx: ValidationContext = NO_CONTEXT): ValidationIssue[] {
    switch (kind) {
        case TemplateKind.POWER_TRANSFORMER:
            return validatePowerTransformerTemplate(data)
        case TemplateKind.TRANSMISSION_CIRCUIT:
            return validateTransmissionCircuitTemplate(data, ctx)
        case TemplateKind.TRANSMISSION_CONDUCTOR:
            return validateTransmissionConductorTemplate(data)
        case TemplateKind.SUBSTATION_YARD:
            return validateSubstationYardTemplate(data)
        case TemplateKind.SUBSTATION_BAY:
            return validateSubstationBayTemplate(data)
        default:
            return [{path: 'kind', message: `unknown template kind "${String(kind)}"`}]
    }
}

/* ---------- collections ---------- */

export function validateCollectionInput(input: unknown, ctx: ValidationContext = NO_CONTEXT): ValidationIssue[] {
    const issues: Issues = []
    if (!isRecord(input)) return [{path: '', message: 'body must be an object'}]
    if (input.id !== undefined) issues.push(...validateTemplateId(input.id))
    requireString(issues, input, 'name', 'name', {max: 120})
    optionalString(issues, input, 'description', 'description', {max: 2000})
    optionalStringArray(issues, input, 'tags', 'tags')
    const items = input.items
    if (items === undefined || items === null) return issues
    if (!Array.isArray(items)) {
        issues.push({path: 'items', message: 'items must be an array'})
        return issues
    }
    const seen = new Set<string>()
    items.forEach((item, i) => {
        const p = `items.${i}`
        if (!isRecord(item)) {
            issues.push({path: p, message: 'item must be an object'})
            return
        }
        const kindOk = typeof item.kind === 'string' && (Object.values(TemplateKind) as string[]).includes(item.kind)
        if (!kindOk) issues.push({path: `${p}.kind`, message: `kind must be one of: ${Object.values(TemplateKind).join(', ')}`})
        const idIssues = validateTemplateId(item.id)
        issues.push(...idIssues.map(x => ({...x, path: `${p}.id`})))
        optionalString(issues, item, 'note', `${p}.note`, {max: 500})
        if (kindOk && idIssues.length === 0) {
            const ref: TemplateRef = {kind: item.kind as TemplateKind, id: item.id as string}
            const dedupeKey = `${ref.kind}:${ref.id}`
            if (seen.has(dedupeKey)) issues.push({path: p, message: `duplicate item ${ref.kind}/${ref.id}`})
            seen.add(dedupeKey)
            if (!ctx.exists(ref)) issues.push({path: `${p}.id`, message: `template ${ref.kind}/${ref.id} does not exist`})
        }
    })
    return issues
}
