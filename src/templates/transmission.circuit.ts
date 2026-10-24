import {TransmissionVoltage} from "../models/transmission.voltage";
import {ConductorMountType} from "../models/transmission.conductor";
import {TransmissionConductorTemplate} from "./transmission.conductor";

/**
 * In-memory (resolved) circuit template consumed by `TransmissionCircuitFactory`.
 * The conductor is embedded so factories never need storage access.
 */
export interface TransmissionCircuitTemplate {
    name: string
    voltage?: TransmissionVoltage
    bundle: number
    conductor: TransmissionConductorTemplate
    mountType?: ConductorMountType
}

/**
 * Persisted form of a circuit template. Instead of embedding the conductor it
 * references a `TRANSMISSION_CONDUCTOR` template by id so one conductor can be
 * shared by many circuits and edited in one place.
 * Use `resolveTransmissionCircuitTemplate` (see `resolve.ts`) to obtain the
 * embedded `TransmissionCircuitTemplate`.
 */
export interface TransmissionCircuitTemplateData {
    name: string
    voltage?: TransmissionVoltage
    bundle: number
    conductorId: string
    /** How the circuit's conductors are carried (e.g. DUCT_BANK for a buried XLPE cable); unset: the conductor's preferred mount. */
    mountType?: ConductorMountType
}
