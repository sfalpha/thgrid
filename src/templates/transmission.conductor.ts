import {TransmissionWireType, TransmissionWireUnit} from "../models/transmission.conductor";

export interface TransmissionConductorTemplate {
    name: string
    size: number
    unit: TransmissionWireUnit
    type: TransmissionWireType
    code?: string
}