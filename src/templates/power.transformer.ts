import {
    TransformerWindingRating,
    TransformerWindingSide,
    TransformerWindingTapChanger,
    TransformerWindingWiring
} from "../models/transformer";
import {TransmissionVoltage} from "../models/transmission.voltage";

export interface TransformerWindingTemplate {
    windingSide: TransformerWindingSide
    tapChanger: TransformerWindingTapChanger
    wiring: TransformerWindingWiring
    voltage: TransmissionVoltage
    ratings?: TransformerWindingRating[]
}

export type TransformerWindingsTemplate = {
    [key: string]: TransformerWindingTemplate
}

export interface PowerTransformerTemplate {
    name: string
    windings: TransformerWindingsTemplate
    modules: number
}