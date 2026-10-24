
export enum TransmissionWireType {
    /** Unknown / not yet chosen conductor. */
    GENERIC = 'GENERIC',
    AAC = 'AAC',
    ACSR_GA = 'ACSR/GA',
    ACSR_AW = 'ACSR/AW',
    /** High-temperature low-sag conductor with an Invar (iron-nickel) core. */
    HTLS_INVAR = 'HTLS/INVAR',
    /** High-temperature low-sag conductor with a carbon-fibre composite core (ACCC). */
    HTLS_ACCC = 'HTLS/ACCC',
    /** Cable insulated with cross-linked polyethylene (XLPE), e.g. an underground section. */
    XLPE = 'XLPE'
}

/** How a circuit's conductors are carried: by insulators on a tower (the aerial mounts), or as a cable. */
export enum ConductorMountType {
    SUSPENSION_I_STRING = 'SUSPENSION_I_STRING',
    SUSPENSION_V_STRING = 'SUSPENSION_V_STRING',
    SUSPENSION_V_STRING_COMPACT = 'SUSPENSION_V_STRING_COMPACT',
    LINE_POST = 'LINE_POST',
    HORIZONTAL_LINE_POST = 'HORIZONTAL_LINE_POST',
    HORIZONTAL_VEE = 'HORIZONTAL_VEE',
    /** Cables laid on a cable ladder (tray). */
    CABLE_LADDER = 'CABLE_LADDER',
    /** Cables in a U-shaped (open-top) trench. */
    U_TRENCH = 'U_TRENCH',
    /** Buried in a concrete duct bank (drawn under the ground line, numbered apart from the towers). */
    DUCT_BANK = 'DUCT_BANK',
    /** Laid under water (drawn like a duct bank, in water, numbered apart from the towers and the duct banks). */
    SUBMARINE = 'SUBMARINE',
}

export const CONDUCTOR_MOUNT_TYPE_LABELS: Record<ConductorMountType, string> = {
    [ConductorMountType.SUSPENSION_I_STRING]: 'Suspension I-String',
    [ConductorMountType.SUSPENSION_V_STRING]: 'Suspension V-String',
    [ConductorMountType.SUSPENSION_V_STRING_COMPACT]: 'Suspension V-String (Compact)',
    [ConductorMountType.LINE_POST]: 'Line Post',
    [ConductorMountType.HORIZONTAL_LINE_POST]: 'Horizontal Line Post',
    [ConductorMountType.HORIZONTAL_VEE]: 'Horizontal Vee',
    [ConductorMountType.CABLE_LADDER]: 'Cable Ladder',
    [ConductorMountType.U_TRENCH]: 'U-Trench',
    [ConductorMountType.DUCT_BANK]: 'Duct Bank',
    [ConductorMountType.SUBMARINE]: 'Submarine',
}

/** The mounts of an insulated cable (XLPE). */
export const CABLE_MOUNT_TYPES: readonly ConductorMountType[] = [ConductorMountType.CABLE_LADDER, ConductorMountType.U_TRENCH, ConductorMountType.DUCT_BANK, ConductorMountType.SUBMARINE]

/** The mounts of an aerial (bare) conductor, on insulators: every mount but the cable ones. */
export const AERIAL_MOUNT_TYPES: readonly ConductorMountType[] = Object.values(ConductorMountType).filter(m => !CABLE_MOUNT_TYPES.includes(m))

/** Whether a mount carries an aerial conductor on insulators (a tower's), not a cable. */
export const isAerialMount = (m: ConductorMountType) => AERIAL_MOUNT_TYPES.includes(m)

/** The mounts that suit a wire type when its conductor template lists none: an XLPE cable's, else the aerial ones. */
export function defaultMountTypes(type: TransmissionWireType): ConductorMountType[] {
    return [...(type === TransmissionWireType.XLPE ? CABLE_MOUNT_TYPES : AERIAL_MOUNT_TYPES)]
}

/** The mount a circuit takes from a conductor's list: a suspension I-string, else a duct bank, else the first one listed. */
export function preferredMountType(suits: readonly ConductorMountType[]): ConductorMountType | undefined {
    return [ConductorMountType.SUSPENSION_I_STRING, ConductorMountType.DUCT_BANK].find(m => suits.includes(m)) ?? suits[0]
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