/**
 * Core template envelope types.
 *
 * A "template" is a reusable, named specification (e.g. a standard 230kV power
 * transformer, a standard ACSR conductor) that factories turn into concrete
 * network objects. Templates are persisted as one JSON file per template under
 * `data/templates/<kind-directory>/<id>.json`.
 *
 * The per-kind payload interfaces live next to this file
 * (`power.transformer.ts`, `transmission.circuit.ts`, `transmission.conductor.ts`,
 * `substation.yard.ts`, `substation.bay.ts`).
 * Adding a new template kind means:
 *   1. add a member to `TemplateKind`,
 *   2. add its payload interface and register it in `TemplateDataByKind`,
 *   3. add a definition to `registry.ts` (label, directory, validator, refs),
 *   4. add an editor component in the web UI.
 */
import {PowerTransformerTemplate} from "./power.transformer";
import {TransmissionCircuitTemplateData} from "./transmission.circuit";
import {TransmissionConductorTemplate} from "./transmission.conductor";
import {SubstationYardTemplate} from "./substation.yard";
import {SubstationBayTemplate} from "./substation.bay";

export enum TemplateKind {
    POWER_TRANSFORMER = 'POWER_TRANSFORMER',
    TRANSMISSION_CIRCUIT = 'TRANSMISSION_CIRCUIT',
    TRANSMISSION_CONDUCTOR = 'TRANSMISSION_CONDUCTOR',
    SUBSTATION_YARD = 'SUBSTATION_YARD',
    SUBSTATION_BAY = 'SUBSTATION_BAY',
}

/** Maps every kind to the payload type stored in `TemplateRecord.data`. */
export interface TemplateDataByKind {
    [TemplateKind.POWER_TRANSFORMER]: PowerTransformerTemplate
    [TemplateKind.TRANSMISSION_CIRCUIT]: TransmissionCircuitTemplateData
    [TemplateKind.TRANSMISSION_CONDUCTOR]: TransmissionConductorTemplate
    [TemplateKind.SUBSTATION_YARD]: SubstationYardTemplate
    [TemplateKind.SUBSTATION_BAY]: SubstationBayTemplate
}

export type TemplateData<K extends TemplateKind = TemplateKind> = TemplateDataByKind[K]

/** A reference to a template of a given kind. Used by collections and by templates that reference other templates. */
export interface TemplateRef<K extends TemplateKind = TemplateKind> {
    kind: K
    id: string
}

/** Metadata shared by every stored template, independent of its kind. */
export interface TemplateMeta {
    /** Stable identifier, also the file name (without `.json`). See `TEMPLATE_ID_PATTERN`. */
    id: string
    kind: TemplateKind
    description?: string
    tags?: string[]
    /** ISO-8601 timestamps maintained by the backend. */
    createdAt: string
    updatedAt: string
}

/** The persisted document: metadata envelope + kind-specific payload. */
export interface TemplateRecord<K extends TemplateKind = TemplateKind> extends TemplateMeta {
    kind: K
    data: TemplateDataByKind[K]
}

/** Lightweight listing item (no payload). `name` is lifted from `data.name`. */
export interface TemplateSummary {
    id: string
    kind: TemplateKind
    name: string
    description?: string
    tags?: string[]
    updatedAt: string
}

/** Client payload for create/update. `id` is only honoured on create. */
export interface TemplateInput<K extends TemplateKind = TemplateKind> {
    id?: string
    description?: string
    tags?: string[]
    data: TemplateDataByKind[K]
}

export const TEMPLATE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/

export const templateKinds: TemplateKind[] = Object.values(TemplateKind)

export function isTemplateKind(value: unknown): value is TemplateKind {
    return typeof value === 'string' && (templateKinds as string[]).includes(value)
}

/** Derives a file-system and URL safe id from a human readable name. */
export function slugifyTemplateId(name: string): string {
    return name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 80)
}

export function templateName(record: TemplateRecord): string {
    const data = record.data as { name?: unknown }
    return typeof data?.name === 'string' ? data.name : record.id
}

export function toTemplateSummary(record: TemplateRecord): TemplateSummary {
    return {
        id: record.id,
        kind: record.kind,
        name: templateName(record),
        description: record.description,
        tags: record.tags,
        updatedAt: record.updatedAt,
    }
}

export function sameRef(a: TemplateRef, b: TemplateRef): boolean {
    return a.kind === b.kind && a.id === b.id
}
