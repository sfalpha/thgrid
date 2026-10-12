import {v4 as uuidv4} from "uuid";
import {SubstationUnitProps} from "./substation.unit";

export interface SubstationEquipmentUnitProps {
    id?: string
    name?: string
}

export class SubstationEquipmentUnit {
    public id?: string
    public name?: string

    constructor(props: SubstationUnitProps) {
        this.id = props.id || uuidv4()
        this.name = props?.name
    }
}