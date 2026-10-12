/**
 * Turns persisted template payloads (which reference other templates by id)
 * into the embedded in-memory shapes consumed by the factories.
 */
import {TemplateKind, TemplateRecord, TemplateRef} from "./template";
import {TransmissionCircuitTemplate, TransmissionCircuitTemplateData} from "./transmission.circuit";
import {TransmissionConductorTemplate} from "./transmission.conductor";
import {PowerTransformerTemplate} from "./power.transformer";
import {SubstationYardTemplate} from "./substation.yard";
import {SubstationBayTemplate} from "./substation.bay";

export interface TemplateLookup {
    get<K extends TemplateKind>(ref: TemplateRef<K>): TemplateRecord<K> | undefined
}

export class TemplateResolveError extends Error {
    constructor(public readonly ref: TemplateRef, message?: string) {
        super(message ?? `Referenced template ${ref.kind}/${ref.id} not found`)
        this.name = 'TemplateResolveError'
    }
}

export function resolveTransmissionCircuitTemplate(data: TransmissionCircuitTemplateData, lookup: TemplateLookup): TransmissionCircuitTemplate {
    const ref: TemplateRef<TemplateKind.TRANSMISSION_CONDUCTOR> = {kind: TemplateKind.TRANSMISSION_CONDUCTOR, id: data.conductorId}
    const conductor = lookup.get(ref)
    if (!conductor) throw new TemplateResolveError(ref)
    return {
        name: data.name,
        voltage: data.voltage,
        bundle: data.bundle,
        conductor: conductor.data,
    }
}

/** Map from kind to its resolved (factory-ready) type. */
export interface ResolvedTemplateByKind {
    [TemplateKind.POWER_TRANSFORMER]: PowerTransformerTemplate
    [TemplateKind.TRANSMISSION_CIRCUIT]: TransmissionCircuitTemplate
    [TemplateKind.TRANSMISSION_CONDUCTOR]: TransmissionConductorTemplate
    [TemplateKind.SUBSTATION_YARD]: SubstationYardTemplate
    [TemplateKind.SUBSTATION_BAY]: SubstationBayTemplate
}

export function resolveTemplate<K extends TemplateKind>(record: TemplateRecord<K>, lookup: TemplateLookup): ResolvedTemplateByKind[K] {
    switch (record.kind) {
        case TemplateKind.TRANSMISSION_CIRCUIT:
            return resolveTransmissionCircuitTemplate(record.data as TransmissionCircuitTemplateData, lookup) as ResolvedTemplateByKind[K]
        case TemplateKind.POWER_TRANSFORMER:
        case TemplateKind.TRANSMISSION_CONDUCTOR:
        case TemplateKind.SUBSTATION_YARD:
        case TemplateKind.SUBSTATION_BAY:
            return record.data as unknown as ResolvedTemplateByKind[K]
        default:
            throw new Error(`Cannot resolve template kind ${String(record.kind)}`)
    }
}

/** Builds a lookup over an in-memory list of records (e.g. an imported bundle). */
export function lookupFromRecords(records: TemplateRecord[]): TemplateLookup {
    const index = new Map<string, TemplateRecord>()
    for (const r of records) index.set(`${r.kind}:${r.id}`, r)
    return {
        get<K extends TemplateKind>(ref: TemplateRef<K>) {
            return index.get(`${ref.kind}:${ref.id}`) as TemplateRecord<K> | undefined
        },
    }
}
