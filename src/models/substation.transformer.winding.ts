import {
    SubstationEquipmentCircuit,
    SubstationEquipmentCircuitProps
} from "./substation.equipment.circuit";
import {
    TransformerWindingRating,
    TransformerWindingSide,
    TransformerWindingTapChanger,
    TransformerWindingWiring
} from "./transformer";
import {SubstationTransformer} from "./substation.transformer";

export interface TransformerWindingProps extends SubstationEquipmentCircuitProps {
    transformer: SubstationTransformer
    windingSide: TransformerWindingSide
    wiring: TransformerWindingWiring
    tapChanger: TransformerWindingTapChanger
    ratings?: TransformerWindingRating[]
}

export type TransformerWindings = {
    [key: string]: TransformerWinding
}

export class TransformerWinding extends SubstationEquipmentCircuit {
    public transformer: SubstationTransformer
    public windingSide: TransformerWindingSide
    public wiring: TransformerWindingWiring
    public tapChanger?: TransformerWindingTapChanger
    public ratings?: TransformerWindingRating[]

    constructor(props: TransformerWindingProps) {
        super(props)
        this.transformer = props.transformer
        this.windingSide = props.windingSide
        this.wiring = props.wiring
        this.tapChanger = props.tapChanger
        this.ratings = props?.ratings || []
    }
}
