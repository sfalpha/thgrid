import {SubstationEquipment, SubstationEquipmentType} from "./substation.equipment";
import {SubstationBay} from "./substation.bay";
import {TransmissionVoltage} from "./transmission.voltage";
import {SubstationUnitProps} from "./substation.unit";
import {SubstationEquipmentCircuit} from "./substation.equipment.circuit";

export interface SubstationSurgeArresterProps extends SubstationUnitProps {
    bay: SubstationBay
    code: string
    brand?: string
    model?: string
    current?: number
    voltage?: TransmissionVoltage
    circuit: SubstationEquipmentCircuit
    surgeVoltage?: number
}

export class SubstationSurgeArrester extends SubstationEquipment {
    current?: number
    voltage?: TransmissionVoltage
    circuit: SubstationEquipmentCircuit
    surgeVoltage?: number

    static readonly idPrefix = 'SSA'

    constructor(props: SubstationSurgeArresterProps) {
        super({id: props.id, name: props.name, bay: props.bay, code: props.code, equipmentType: SubstationEquipmentType.SURGE_ARRESTER, brand: props?.brand, model: props?.model})
        this.current = props?.current
        this.voltage = props?.voltage
        this.circuit = props.circuit
        this.surgeVoltage = props?.surgeVoltage
    }
}