import {SubstationEquipment, SubstationEquipmentType} from "./substation.equipment";
import {SubstationBay} from "./substation.bay";
import {TransmissionVoltage} from "./transmission.voltage";
import {SubstationUnitProps} from "./substation.unit";
import {SubstationEquipmentCircuit} from "./substation.equipment.circuit";

export interface SubstationPowerFuseProps extends SubstationUnitProps {
    bay: SubstationBay
    code: string
    brand?: string
    model?: string
    current?: number
    voltage?: TransmissionVoltage
    circuitA: SubstationEquipmentCircuit
    circuitB: SubstationEquipmentCircuit
    fuseCurrent?: number
}

export class SubstationPowerFuse extends SubstationEquipment {
    current?: number
    voltage?: TransmissionVoltage
    circuitA: SubstationEquipmentCircuit
    circuitB: SubstationEquipmentCircuit
    fuseCurrent?: number

    static readonly idPrefix = 'SFU'

    constructor(props: SubstationPowerFuseProps) {
        super({id: props.id, name: props.name, bay: props.bay, code: props.code, equipmentType: SubstationEquipmentType.POWER_FUSE, brand: props?.brand, model: props?.model})
        this.current = props?.current
        this.voltage = props?.voltage
        this.circuitA = props.circuitA
        this.circuitB = props.circuitB
        this.fuseCurrent = props?.fuseCurrent
    }
}