import {SubstationEquipment, SubstationEquipmentType} from "./substation.equipment";
import {SubstationBay} from "./substation.bay";
import {TransmissionVoltage} from "./transmission.voltage";
import {SubstationUnitProps} from "./substation.unit";
import {SubstationEquipmentCircuit} from "./substation.equipment.circuit";

export interface SubstationCurrentTransformerCores {
    i: number[]
    o: number
}

export interface SubstationCurrentTransformerProps extends SubstationUnitProps {
    bay: SubstationBay
    code: string
    brand?: string
    model?: string
    current?: number
    voltage?: TransmissionVoltage
    cores: SubstationCurrentTransformerCores[]
    /** A current transformer sits in series: the circuit enters at A and leaves at B. */
    circuitA: SubstationEquipmentCircuit
    circuitB: SubstationEquipmentCircuit
}

export class SubstationCurrentTransformer extends SubstationEquipment {
    current?: number
    voltage?: TransmissionVoltage
    circuitA: SubstationEquipmentCircuit
    circuitB: SubstationEquipmentCircuit

    static readonly idPrefix = 'SCT'

    constructor(props: SubstationCurrentTransformerProps) {
        super({id: props.id, name: props.name, bay: props.bay, code: props.code, equipmentType: SubstationEquipmentType.CURRENT_TRANSFORMER, brand: props?.brand, model: props?.model})
        this.current = props?.current
        this.voltage = props?.voltage
        this.circuitA = props.circuitA
        this.circuitB = props.circuitB
    }
}