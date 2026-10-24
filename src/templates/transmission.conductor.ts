import {ConductorMountType, defaultMountTypes, TransmissionWireType, TransmissionWireUnit} from "../models/transmission.conductor";

export interface TransmissionConductorTemplate {
    name: string
    size: number
    unit: TransmissionWireUnit
    type: TransmissionWireType
    code?: string
    /**
     * The mounts that suit the conductor: an XLPE cable's cable ladder, U-trench, duct bank and submarine; an aerial conductor's
     * every other one. Unset: by the wire type (`defaultMountTypes`). A circuit taking the conductor from the template
     * keeps its mount type when listed, else takes the preferred one (`preferredMountType`).
     */
    mountTypes?: ConductorMountType[]
}

/** The mounts that suit a conductor template: its list, else its wire type's. */
export function conductorMountTypes(t: Pick<TransmissionConductorTemplate, 'type' | 'mountTypes'>): ConductorMountType[] {
    return t.mountTypes ?? defaultMountTypes(t.type)
}