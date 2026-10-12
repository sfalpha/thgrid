import {SubstationCircuit, SubstationCircuitNamingHints, SubstationCircuitProps} from "./substation.circuit";
import {Substation} from "./substation";
import {TransmissionVoltage} from "./transmission.voltage";
import {joinId, joinName} from "./naming";

/** Purpose of a bay template (`SubstationBayTemplate.bayTemplateType`). */
export enum BayTemplateType {
    TAKEOFF = 'TAKEOFF',
    BUS_TIE = 'BUS_TIE',
    HIGH_SIDE_TRANSFORMER = 'HIGH_SIDE_TRANSFORMER',
    LOW_SIDE_TRANSFORMER = 'LOW_SIDE_TRANSFORMER',
    CAPACITOR_BANK = 'CAPACITOR_BANK',
    SHUNT_REACTOR = 'SHUNT_REACTOR',
    STATIC_VAR_COMPENSATOR = 'STATIC_VAR_COMPENSATOR',
}

export interface SubstationBayProps extends SubstationCircuitProps {
    id?: string
    name?: string
    substation: Substation
    bayNumber: string
    column?: number
}

export const defaultBayPrefix: { v: TransmissionVoltage, p: string }[] = [
    { v: TransmissionVoltage.AC500KV, p: '9' },
    { v: TransmissionVoltage.AC230KV, p: '8' },
    { v: TransmissionVoltage.AC115KV, p: '7' },
    { v: TransmissionVoltage.AC69KV, p: '69' },
    { v: TransmissionVoltage.AC22KV, p: '22' },
]

export interface SubstationBayNamingHints extends SubstationCircuitNamingHints {
    /** Bay number, e.g. "8041". */
    bayNumber?: string
}

/** A bay of a yard. Default id `SBA_<group>_<yard>_<bayNumber>`, default name `BAY_<bayNumber>`. */
export class SubstationBay extends SubstationCircuit {
    static readonly idPrefix: string = 'SBA'

    static defaultId(hints: SubstationBayNamingHints = {}): string {
        const tokens = [hints.groupName, hints.yardName, hints.bayNumber || hints.name].filter(Boolean)
        return tokens.length ? joinId(this.idPrefix, ...tokens) : super.defaultId()
    }

    static defaultName(hints: SubstationBayNamingHints = {}): string | undefined {
        return hints.name || (hints.bayNumber ? joinName(['BAY', hints.bayNumber]) : undefined)
    }

    public substation: Substation
    public bayNumber: string
    public column?: number

    constructor(props: SubstationBayProps) {
        const hints: SubstationBayNamingHints = {name: props.name, groupName: props.substation?.substationGroup?.name, yardName: props.substation?.name, bayNumber: props.bayNumber}
        super({...props, id: props.id || SubstationBay.defaultId(hints), name: props.name || SubstationBay.defaultName(hints)})
        this.substation = props.substation
        this.bayNumber = props.bayNumber
        this.column = props?.column
    }
}
