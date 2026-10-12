import {SubstationEquipmentType} from "./substation.equipment";
import {SubstationTransformer} from "./substation.transformer";
import {SubstationBay} from "./substation.bay";
import {TransformerWindings} from "./substation.transformer.winding";
import {SubstationUnitProps} from "./substation.unit";

export interface SubstationPowerTransformerProps extends SubstationUnitProps {
    bay: SubstationBay
    code: string
    brand?: string
    model?: string
    windings?: TransformerWindings
    modules?: number
}

/** A power transformer. Default id `SKT_<group>_<yard>_<code>`, default name the code. */
export class SubstationPowerTransformer extends SubstationTransformer {
    static readonly idPrefix = 'SKT'

    constructor(props: SubstationPowerTransformerProps) {
        super({
            id: props.id, name: props.name, bay: props.bay, code: props.code, equipmentType: SubstationEquipmentType.POWER_TRANSFORMER,
            brand: props?.brand, model: props?.model, windings: props.windings, modules: props.modules,
        })
    }
}
