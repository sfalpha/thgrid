import {SubstationEquipment, SubstationEquipmentType} from "./substation.equipment";
import {TransformerWindings} from "./substation.transformer.winding";
import {SubstationBay} from "./substation.bay";
import {SubstationUnitProps} from "./substation.unit";

export interface SubstationTransformerProps extends SubstationUnitProps {
    bay: SubstationBay
    code: string
    equipmentType: SubstationEquipmentType
    brand?: string
    model?: string
    windings?: TransformerWindings
    modules?: number
}

/** A transformer of any kind. Default id `<type prefix>_<group>_<yard>_<code>` (`STF_…` when the type has no prefix of its own). */
export class SubstationTransformer extends SubstationEquipment {
    static readonly idPrefix: string = 'STF'

    public windings: TransformerWindings
    public modules: number

    constructor(props: SubstationTransformerProps) {
        super({id: props.id, name: props.name, bay: props.bay, code: props.code, equipmentType: props.equipmentType, brand: props?.brand, model: props?.model})
        this.windings = props.windings || {}
        this.modules = props?.modules || 1
    }
}
