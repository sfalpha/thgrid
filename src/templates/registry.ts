/**
 * Registry of template kinds. The backend uses it to pick a storage directory
 * and validator per kind and to compute cross-references; the web UI uses the
 * labels and ordering. Register new kinds here.
 */
import {TemplateKind, TemplateRef} from "./template";
import {ValidationContext, ValidationIssue, validateTemplateData} from "./validation";
import {TransmissionCircuitTemplateData} from "./transmission.circuit";

export interface TemplateKindDefinition {
    kind: TemplateKind
    /** Human readable singular label. */
    label: string
    /** Human readable plural label. */
    pluralLabel: string
    /** Sub-directory of `data/templates` holding this kind. */
    directory: string
    /** Short description shown in the UI. */
    description: string
    validate(data: unknown, ctx: ValidationContext): ValidationIssue[]
    /** Templates referenced by this payload (for integrity checks and bundle export). */
    references(data: unknown): TemplateRef[]
}

const definitions: Record<TemplateKind, TemplateKindDefinition> = {
    [TemplateKind.TRANSMISSION_CONDUCTOR]: {
        kind: TemplateKind.TRANSMISSION_CONDUCTOR,
        label: 'Conductor',
        pluralLabel: 'Conductors',
        directory: 'transmission-conductor',
        description: 'Overhead line conductor specification (size, unit, wire type).',
        validate: (data, ctx) => validateTemplateData(TemplateKind.TRANSMISSION_CONDUCTOR, data, ctx),
        references: () => [],
    },
    [TemplateKind.TRANSMISSION_CIRCUIT]: {
        kind: TemplateKind.TRANSMISSION_CIRCUIT,
        label: 'Transmission circuit',
        pluralLabel: 'Transmission circuits',
        directory: 'transmission-circuit',
        description: 'Voltage level, bundle count and conductor of a line circuit.',
        validate: (data, ctx) => validateTemplateData(TemplateKind.TRANSMISSION_CIRCUIT, data, ctx),
        references: (data) => {
            const d = data as Partial<TransmissionCircuitTemplateData> | undefined
            return typeof d?.conductorId === 'string' && d.conductorId
                ? [{kind: TemplateKind.TRANSMISSION_CONDUCTOR, id: d.conductorId}]
                : []
        },
    },
    [TemplateKind.POWER_TRANSFORMER]: {
        kind: TemplateKind.POWER_TRANSFORMER,
        label: 'Power transformer',
        pluralLabel: 'Power transformers',
        directory: 'power-transformer',
        description: 'Windings (side, wiring, voltage, tap changer, ratings) and module count.',
        validate: (data, ctx) => validateTemplateData(TemplateKind.POWER_TRANSFORMER, data, ctx),
        references: () => [],
    },
    [TemplateKind.SUBSTATION_YARD]: {
        kind: TemplateKind.SUBSTATION_YARD,
        label: 'Substation yard',
        pluralLabel: 'Substation yards',
        directory: 'substation-yard',
        description: 'Arrangement and buses (type, number, row) a yard starts with; deployed from the yard editor with a number of empty bays.',
        validate: (data, ctx) => validateTemplateData(TemplateKind.SUBSTATION_YARD, data, ctx),
        references: () => [],
    },
    [TemplateKind.SUBSTATION_BAY]: {
        kind: TemplateKind.SUBSTATION_BAY,
        label: 'Substation bay',
        pluralLabel: 'Substation bays',
        directory: 'substation-bay',
        description: 'Equipment stack of one bay (type, sequence, take-off / bus-tie flags) for a purpose, usable in the listed arrangements.',
        validate: (data, ctx) => validateTemplateData(TemplateKind.SUBSTATION_BAY, data, ctx),
        references: () => [],
    },
}

/** Display order: dependencies first so users create conductors before circuits. */
export const templateKindOrder: TemplateKind[] = [
    TemplateKind.TRANSMISSION_CONDUCTOR,
    TemplateKind.TRANSMISSION_CIRCUIT,
    TemplateKind.POWER_TRANSFORMER,
    TemplateKind.SUBSTATION_YARD,
    TemplateKind.SUBSTATION_BAY,
]

export function getTemplateKindDefinition(kind: TemplateKind): TemplateKindDefinition {
    const def = definitions[kind]
    if (!def) throw new Error(`Unknown template kind: ${String(kind)}`)
    return def
}

export function listTemplateKindDefinitions(): TemplateKindDefinition[] {
    return templateKindOrder.map(k => definitions[k])
}

/** Serializable subset of the definition for the `/api/meta` endpoint. */
export interface TemplateKindInfo {
    kind: TemplateKind
    label: string
    pluralLabel: string
    directory: string
    description: string
}

export function toTemplateKindInfo(def: TemplateKindDefinition): TemplateKindInfo {
    return {kind: def.kind, label: def.label, pluralLabel: def.pluralLabel, directory: def.directory, description: def.description}
}
