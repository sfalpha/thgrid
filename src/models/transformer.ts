export enum TransformerWindingWiring {
    SINGLE = 'SINGLE',
    STAR = 'STAR',
    DELTA = 'DELTA',
    TWELVE_PHASE = 'TWELVE_PHASE'
}

export enum TransformerWindingSide {
    PRIMARY = 'PRIMARY',
    SECONDARY = 'SECONDARY',
    AUXILIARY = 'AUXILIARY'
}

export enum TransformerCooling {
    ONAN = 'ONAN',
    ONAF = 'ONAF',
    OA = 'OA',
    FA = 'FA'
}
export interface TransformerWindingRating {
    cooling: TransformerCooling
    power: number
    perModule: boolean
}

export enum TransformerWindingTapChanger {
    NONE = 'NONE',
    BASIC = 'BASIC',
    ONLOAD = 'ONLOAD'
}
