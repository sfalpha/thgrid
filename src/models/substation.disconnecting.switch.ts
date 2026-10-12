import {SubstationEquipment, SubstationEquipmentType} from "./substation.equipment";
import {SubstationBay} from "./substation.bay";
import {TransmissionVoltage} from "./transmission.voltage";
import {SubstationUnitProps} from "./substation.unit";
import {SubstationEquipmentCircuit} from "./substation.equipment.circuit";

export interface SubstationDisconnectingSwitchProps extends SubstationUnitProps {
    bay: SubstationBay
    code: string
    brand?: string
    model?: string
    current?: number
    voltage?: TransmissionVoltage
    circuitA: SubstationEquipmentCircuit
    circuitB: SubstationEquipmentCircuit
    withGroundSwitch?: boolean
}

export class SubstationDisconnectingSwitch extends SubstationEquipment {
    current?: number
    voltage?: TransmissionVoltage
    circuitA: SubstationEquipmentCircuit
    circuitB: SubstationEquipmentCircuit
    withGroundSwitch: boolean

    static readonly idPrefix = 'SDS'

    constructor(props: SubstationDisconnectingSwitchProps) {
        super({id: props.id, name: props.name, bay: props.bay, code: props.code, equipmentType: SubstationEquipmentType.DISCONNECTING_SWITCH, brand: props?.brand, model: props?.model})
        this.current = props?.current
        this.voltage = props?.voltage
        this.circuitA = props.circuitA
        this.circuitB = props.circuitB
        this.withGroundSwitch = props?.withGroundSwitch || false
    }
}