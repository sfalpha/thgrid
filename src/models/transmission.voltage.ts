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
    DC = 'DC'
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