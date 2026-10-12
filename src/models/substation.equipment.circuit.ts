import {TransmissionVoltage} from "./transmission.voltage";
import {SubstationEquipmentUnit, SubstationEquipmentUnitProps} from "./substation.equipment.unit";

export interface SubstationEquipmentCircuitProps extends SubstationEquipmentUnitProps {
    current?: number
    voltage?: TransmissionVoltage
}

export class SubstationEquipmentCircuit extends SubstationEquipmentUnit {
    public current?: number
    public voltage?: TransmissionVoltage

    constructor(props: SubstationEquipmentCircuitProps) {
        super(props)
        this.current = props?.current
        this.voltage = props?.voltage
    }
}