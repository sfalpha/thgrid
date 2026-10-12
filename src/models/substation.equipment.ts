import {SubstationUnit, SubstationUnitNamingHints, SubstationUnitProps} from "./substation.unit";
import {SubstationBay} from "./substation.bay";
import {joinId} from "./naming";

export enum SubstationEquipmentType {
    CIRCUIT_BREAKER = 'CIRCUIT_BREAKER',
    MTS_BREAKER = 'MTS_BREAKER',
    DISCONNECTING_SWITCH = 'DISCONNECTING_SWITCH',
    GROUND_SWITCH = 'GROUND_SWITCH',
    SURGE_ARRESTER = 'SURGE_ARRESTER',
    CURRENT_TRANSFORMER = 'CURRENT_TRANSFORMER',
    POTENTIAL_TRANSFORMER = 'POTENTIAL_TRANSFORMER',
    POWER_TRANSFORMER = 'POWER_TRANSFORMER',
    SERVICE_TRANSFORMER = 'SERVICE_TRANSFORMER',
    STATIC_VAR_COMPENSATOR = 'STATIC_VAR_COMPENSATOR',
    SHUNT_REACTOR = 'SHUNT_REACTOR',
    POWER_FUSE = 'POWER_FUSE'
}

export enum SubstationEquipmentCodeType {
    ROW_SEQ,
    TYPE_SEQ
}

/** Id prefix of every equipment type (the subclasses repeat theirs in `idPrefix`). */
export const SubstationEquipmentTypeHint  = [
    { type: SubstationEquipmentType.CIRCUIT_BREAKER, idPrefix: 'SCB'},
    { type: SubstationEquipmentType.MTS_BREAKER, idPrefix: 'SMT'},
    { type: SubstationEquipmentType.DISCONNECTING_SWITCH, idPrefix: 'SDS'},
    { type: SubstationEquipmentType.GROUND_SWITCH, idPrefix: 'SGS'},
    { type: SubstationEquipmentType.SURGE_ARRESTER, idPrefix: 'SSA'},
    { type: SubstationEquipmentType.CURRENT_TRANSFORMER, idPrefix: 'SCT'},
    { type: SubstationEquipmentType.POTENTIAL_TRANSFORMER, idPrefix: 'SPT'},
    { type: SubstationEquipmentType.POWER_TRANSFORMER, idPrefix: 'SKT'},
    { type: SubstationEquipmentType.SERVICE_TRANSFORMER, idPrefix: 'SKW'},
    { type: SubstationEquipmentType.STATIC_VAR_COMPENSATOR, idPrefix: 'SSV'},
    { type: SubstationEquipmentType.SHUNT_REACTOR, idPrefix: 'SSR'},
    { type: SubstationEquipmentType.POWER_FUSE, idPrefix: 'SFU'},
]

/** Id prefix for an equipment type; `SXX` for an unknown one. */
export function equipmentIdPrefix(type?: SubstationEquipmentType | string): string {
    return SubstationEquipmentTypeHint.find(e => e.type === type)?.idPrefix || SubstationEquipment.idPrefix
}

export interface SubstationEquipmentProps extends SubstationUnitProps {
    bay: SubstationBay
    code: string
    equipmentType: SubstationEquipmentType
    brand?: string
    model?: string
    /** The equipment is on the line side of its bay (the take-off column): what a power transformer connects to. */
    lineSide?: boolean
    /** The equipment ties buses (a bus-tie / transfer-bus switch). */
    busTie?: boolean
}

export interface SubstationEquipmentNamingHints extends SubstationUnitNamingHints {
    groupName?: string
    yardName?: string
    /** Equipment code within the yard, e.g. "8041-1". */
    code?: string
    /** Picks the id prefix (`SCB`, `SDS`, …); the class's own prefix when omitted. */
    equipmentType?: SubstationEquipmentType | string
}

/**
 * A piece of equipment in a bay. Default id `<type prefix>_<group>_<yard>_<code>`
 * (e.g. `SCB_CNO_230KV_8041`), default name the equipment code.
 */
export class SubstationEquipment extends SubstationUnit {
    static readonly idPrefix: string = 'SXX'

    static defaultId(hints: SubstationEquipmentNamingHints = {}): string {
        const prefix = hints.equipmentType ? equipmentIdPrefix(hints.equipmentType) : this.idPrefix
        const tokens = [hints.groupName, hints.yardName, hints.code || hints.name].filter(Boolean)
        return tokens.length ? joinId(prefix, ...tokens) : super.defaultId()
    }

    static defaultName(hints: SubstationEquipmentNamingHints = {}): string | undefined {
        return hints.name || hints.code || undefined
    }

    public bay: SubstationBay
    public code: string
    public equipmentType: SubstationEquipmentType
    public brand?: string
    public model?: string
    public lineSide?: boolean
    public busTie?: boolean

    constructor(props: SubstationEquipmentProps) {
        const hints: SubstationEquipmentNamingHints = {
            name: props.name, groupName: props.bay?.substation?.substationGroup?.name, yardName: props.bay?.substation?.name,
            code: props.code, equipmentType: props.equipmentType,
        }
        super({...props, id: props.id || SubstationEquipment.defaultId(hints), name: props.name || SubstationEquipment.defaultName(hints)});
        this.bay = props.bay
        this.code = props.code
        this.equipmentType = props.equipmentType
        this.brand = props?.brand
        this.model = props?.model
        this.lineSide = props?.lineSide
        this.busTie = props?.busTie
    }
}
