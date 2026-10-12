
export enum TransmissionWireType {
    /** Unknown / not yet chosen conductor. */
    GENERIC = 'GENERIC',
    AAC = 'AAC',
    ACSR_GA = 'ACSR/GA',
    ACSR_AW = 'ACSR/AW',
    /** High-temperature low-sag conductor with an Invar (iron-nickel) core. */
    HTLS_INVAR = 'HTLS/INVAR',
    /** High-temperature low-sag conductor with a carbon-fibre composite core (ACCC). */
    HTLS_ACCC = 'HTLS/ACCC'
}

export enum TransmissionWireUnit {
    SQMM = 'SQMM',
    MCM= 'MCM',
    AWG = 'AWG'
}

export interface TransmissionConductor {
    size: number
    unit: TransmissionWireUnit
    type: TransmissionWireType
    code?: string
}

/** The conductor a circuit gets when none is known (no template, or the template could not be loaded): size 0, SQMM, GENERIC. */
export const GENERIC_CONDUCTOR: Readonly<TransmissionConductor> = Object.freeze({size: 0, unit: TransmissionWireUnit.SQMM, type: TransmissionWireType.GENERIC})

export function genericConductor(): TransmissionConductor {
    return {...GENERIC_CONDUCTOR}
}