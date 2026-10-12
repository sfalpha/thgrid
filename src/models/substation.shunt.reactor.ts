import {SubstationEquipment, SubstationEquipmentType} from "./substation.equipment";
import {SubstationBay} from "./substation.bay";
import {TransmissionVoltage} from "./transmission.voltage";
import {SubstationUnitProps} from "./substation.unit";
import {SubstationEquipmentCircuit} from "./substation.equipment.circuit";

export interface SubstationShuntReactorProps extends SubstationUnitProps {
    bay: SubstationBay
    code: string
    brand?: string
    model?: string
    current?: number
    voltage?: TransmissionVoltage
    circuitA: SubstationEquipmentCircuit
    circuitB: SubstationEquipmentCircuit
    var?: number
}

export class SubstationShuntReactor extends SubstationEquipment {
    current?: number
    voltage?: TransmissionVoltage
    circuitA: SubstationEquipmentCircuit
    circuitB: SubstationEquipmentCircuit
    var?: number

    static readonly idPrefix = 'SSR'

    constructor(props: SubstationShuntReactorProps) {
        super({id: props.id, name: props.name, bay: props.bay, code: props.code, equipmentType: SubstationEquipmentType.SHUNT_REACTOR, brand: props?.brand, model: props?.model})
        this.current = props?.current
        this.voltage = props?.voltage
        this.circuitA = props.circuitA
        this.circuitB = props.circuitB
        this.var = props?.var
    }
}