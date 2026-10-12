import {SubstationEquipment, SubstationEquipmentType} from "./substation.equipment";
import {SubstationBay} from "./substation.bay";
import {TransmissionVoltage} from "./transmission.voltage";
import {SubstationUnitProps} from "./substation.unit";
import {SubstationEquipmentCircuit} from "./substation.equipment.circuit";
import {SubstationPotentialTransformer} from "./substation.potential.transformer";
import {SubstationCurrentTransformer} from "./substation.current.transformer";
import {SubstationDisconnectingSwitch} from "./substation.disconnecting.switch";

export interface SubstationMtsBreakerProps extends SubstationUnitProps {
    bay: SubstationBay
    code: string
    brand?: string
    model?: string
    current?: number
    voltage?: TransmissionVoltage
    circuitA: SubstationEquipmentCircuit
    circuitB: SubstationEquipmentCircuit
    ptA?: SubstationPotentialTransformer
    ptB?: SubstationPotentialTransformer
    ctA?: SubstationCurrentTransformer
    ctB?: SubstationCurrentTransformer
    dsA?: SubstationDisconnectingSwitch
    dsB?: SubstationDisconnectingSwitch
    withGroundSwitch?: boolean
    interruptCapacity?: number
}

export class SubstationMtsBreaker extends SubstationEquipment {
    current?: number
    voltage?: TransmissionVoltage
    circuitA: SubstationEquipmentCircuit
    circuitB: SubstationEquipmentCircuit
    ptA?: SubstationPotentialTransformer
    ptB?: SubstationPotentialTransformer
    ctA?: SubstationCurrentTransformer
    ctB?: SubstationCurrentTransformer
    dsA?: SubstationDisconnectingSwitch
    dsB?: SubstationDisconnectingSwitch
    withGroundSwitch?: boolean
    interruptCapacity?: number

    static readonly idPrefix = 'SMT'

    constructor(props: SubstationMtsBreakerProps) {
        super({id: props.id, name: props.name, bay: props.bay, code: props.code, equipmentType: SubstationEquipmentType.MTS_BREAKER, brand: props?.brand, model: props?.model})
        this.current = props?.current
        this.voltage = props?.voltage
        this.circuitA = props.circuitA
        this.circuitB = props.circuitB
        this.ptA = props?.ptA
        this.ptB = props?.ptB
        this.ctA = props?.ctA
        this.ctB= props?.ctB
        this.dsA = props?.dsA
        this.dsB = props?.dsB
        this.withGroundSwitch = props?.withGroundSwitch
        this.interruptCapacity = props?.interruptCapacity
    }
}