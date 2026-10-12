import {SubstationEquipment, SubstationEquipmentType} from "./substation.equipment";
import {SubstationBay} from "./substation.bay";
import {TransmissionVoltage} from "./transmission.voltage";
import {SubstationUnitProps} from "./substation.unit";
import {SubstationEquipmentCircuit} from "./substation.equipment.circuit";

export interface SubstationPotentialTransformerCores {
    i: number[]
    o: number
}

export interface SubstationPotentialTransformerProps extends SubstationUnitProps {
    bay: SubstationBay
    code: string
    brand?: string
    model?: string
    current?: number
    voltage?: TransmissionVoltage
    cores?: SubstationPotentialTransformerCores[]
    circuit: SubstationEquipmentCircuit
}

export class SubstationPotentialTransformer extends SubstationEquipment {
    current?: number
    voltage?: TransmissionVoltage
    circuit: SubstationEquipmentCircuit

    static readonly idPrefix = 'SPT'

    constructor(props: SubstationPotentialTransformerProps) {
        super({id: props.id, name: props.name, bay: props.bay, code: props.code, equipmentType: SubstationEquipmentType.POTENTIAL_TRANSFORMER, brand: props?.brand, model: props?.model})
        this.current = props?.current
        this.voltage = props?.voltage
        this.circuit = props.circuit
    }
}