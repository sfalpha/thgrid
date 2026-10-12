import {SubstationEquipment, SubstationEquipmentType} from "./substation.equipment";
import {SubstationBay} from "./substation.bay";
import {TransmissionVoltage} from "./transmission.voltage";
import {SubstationUnitProps} from "./substation.unit";
import {SubstationEquipmentCircuit} from "./substation.equipment.circuit";

export interface SubstationGroundSwitchProps extends SubstationUnitProps {
    bay: SubstationBay
    code: string
    brand?: string
    model?: string
    current?: number
    voltage?: TransmissionVoltage
    circuit: SubstationEquipmentCircuit
}

export class SubstationGroundSwitch extends SubstationEquipment {
    current?: number
    voltage?: TransmissionVoltage
    circuit: SubstationEquipmentCircuit

    static readonly idPrefix = 'SGS'

    constructor(props: SubstationGroundSwitchProps) {
        super({id: props.id, name: props.name, bay: props.bay, code: props.code, equipmentType: SubstationEquipmentType.GROUND_SWITCH, brand: props?.brand, model: props?.model})
        this.current = props?.current
        this.voltage = props?.voltage
        this.circuit = props.circuit
    }
}