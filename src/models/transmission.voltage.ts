export enum TransmissionVoltage {
    AC500KV = 'AC500KV',
    AC230KV = 'AC230KV',
    AC115KV = 'AC115KV',
    AC69KV = 'AC69KV',
    AC33KV = 'AC33KV', // Auxiliary
    AC24KV = 'AC24KV', // Auxiliary
    AC22KV = 'AC22KV', // Auxiliary
    AC400V = 'AC400V', // Auxiliary
    DC300KV = 'DC300KV',
    /** De-energized (0 V): built but unused, or a planned line partly built; drawn black on the map. */
    DE_ENERGIZED = '0V',
}

export enum TransmissionType {
    AC = 'AC',
    DC = 'DC',
    /** Neither: de-energized (0 V). */
    N = 'N',
}

export enum TransmissionVoltageClass {
    EHV = 'EHV',
    UHV = 'UHV',
    HV = 'HV',
    MV = 'MV',
    LC = 'LV'
}

export interface TransmissionVoltageDetailProps {
    voltage: TransmissionVoltage
    /** Nominal voltage in kV (0.4 for 400 V, 0 when de-energized). */
    voltageValue: number
    voltageClass: TransmissionVoltageClass
    type: TransmissionType
}

export class TransmissionVoltageDetail {
    public voltage: TransmissionVoltage
    public voltageValue: number
    public voltageClass: TransmissionVoltageClass
    public type: TransmissionType

    constructor(props: TransmissionVoltageDetailProps) {
        this.voltage = props.voltage
        this.voltageValue = props.voltageValue
        this.voltageClass = props.voltageClass
        this.type = props.type
    }
}

const detail = (voltage: TransmissionVoltage, voltageValue: number, voltageClass: TransmissionVoltageClass, type: TransmissionType) =>
    new TransmissionVoltageDetail({voltage, voltageValue, voltageClass, type})

/**
 * Every voltage of `TransmissionVoltage`, highest first, with its value in kV, its class and its current type: the
 * lookups for numerical comparisons and the current type (`voltageDetail`, `voltageValueKv`, `transmissionTypeOf`).
 */
export const TRANSMISSION_VOLTAGE_DETAILS: readonly TransmissionVoltageDetail[] = [
    detail(TransmissionVoltage.AC500KV, 500, TransmissionVoltageClass.EHV, TransmissionType.AC),
    detail(TransmissionVoltage.DC300KV, 300, TransmissionVoltageClass.HV, TransmissionType.DC),
    detail(TransmissionVoltage.AC230KV, 230, TransmissionVoltageClass.HV, TransmissionType.AC),
    detail(TransmissionVoltage.AC115KV, 115, TransmissionVoltageClass.HV, TransmissionType.AC),
    detail(TransmissionVoltage.AC69KV, 69, TransmissionVoltageClass.HV, TransmissionType.AC),
    detail(TransmissionVoltage.AC33KV, 33, TransmissionVoltageClass.MV, TransmissionType.AC),
    detail(TransmissionVoltage.AC24KV, 24, TransmissionVoltageClass.MV, TransmissionType.AC),
    detail(TransmissionVoltage.AC22KV, 22, TransmissionVoltageClass.MV, TransmissionType.AC),
    detail(TransmissionVoltage.AC400V, 0.4, TransmissionVoltageClass.LC, TransmissionType.AC),
    detail(TransmissionVoltage.DE_ENERGIZED, 0, TransmissionVoltageClass.LC, TransmissionType.N),
]

const DETAILS_BY_VOLTAGE = new Map<string, TransmissionVoltageDetail>(TRANSMISSION_VOLTAGE_DETAILS.map(d => [d.voltage, d]))

/** The details of a voltage (undefined for an unknown code). */
export const voltageDetail = (voltage?: TransmissionVoltage | string): TransmissionVoltageDetail | undefined => voltage ? DETAILS_BY_VOLTAGE.get(voltage) : undefined

/** Nominal voltage in kV (undefined for an unknown code). */
export const voltageValueKv = (voltage?: TransmissionVoltage | string): number | undefined => voltageDetail(voltage)?.voltageValue

/** AC, DC, or N (de-energized); undefined for an unknown code. */
export const transmissionTypeOf = (voltage?: TransmissionVoltage | string): TransmissionType | undefined => voltageDetail(voltage)?.type

/**
 * How a circuit's energized voltage relates to its rated one:
 * - `same`, `lower` (run below its rating at the same current type) and `deEnergized` (0 V) are fine: informational;
 * - `higher` (above its rating) and `typeMismatch` (AC on a DC circuit or the other way round) are worth a warning;
 * - `unknown` when either is missing or not a listed voltage.
 */
export type EnergizedVsRated = 'same' | 'lower' | 'deEnergized' | 'higher' | 'typeMismatch' | 'unknown'

export function energizedVsRated(rated?: TransmissionVoltage | string, energized?: TransmissionVoltage | string): EnergizedVsRated {
    if (!rated || !energized) return 'unknown'
    if (rated === energized) return 'same'
    const r = voltageDetail(rated), e = voltageDetail(energized)
    if (!r || !e) return 'unknown'
    if (e.type === TransmissionType.N) return 'deEnergized'
    if (r.type !== e.type && r.type !== TransmissionType.N) return 'typeMismatch'
    return e.voltageValue < r.voltageValue ? 'lower' : e.voltageValue > r.voltageValue ? 'higher' : 'same'
}

/** Whether a circuit rated `rated` may run at `voltage`: the same current type at no more than its rating, or de-energized (unknowns pass). */
export const withinRating = (rated?: TransmissionVoltage | string, voltage?: TransmissionVoltage | string): boolean =>
    !['higher', 'typeMismatch'].includes(energizedVsRated(rated, voltage))
