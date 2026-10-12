import {SubstationBus} from "./substation.bus";
import {SubstationUnit, SubstationUnitNamingHints, SubstationUnitProps} from "./substation.unit";
import {TransmissionVoltage} from "./transmission.voltage";
import {SubstationBay} from "./substation.bay";
import {SubstationTakeOff} from "./substation.take.off";
import {SubstationGroup} from "./substation.group";
import {SubstationEquipment} from "./substation.equipment";
import {joinId, yardNameForVoltage} from "./naming";

export enum SubstationArrangement {
    SINGLE_BUS = 'SINGLE_BUS',
    DOUBLE_BUS = 'DOUBLE_BUS',
    TRIPLE_BUS = 'TRIPLE_BUS',
    SINGLE_MAIN_AND_TRANSFER_BUS = 'SINGLE_MAIN_AND_TRANSFER_BUS',
    DOUBLE_MAIN_AND_TRANSFER_BUS = 'DOUBLE_MAIN_AND_TRANSFER_BUS',
    TRIPLE_MAIN_AND_TRANSFER_BUS = 'TRIPLE_MAIN_AND_TRANSFER_BUS',
    BREAKER_AND_A_HALF = 'BREAKER_AND_A_HALF',
    RING = 'RING',
    MESH = 'MESH',
}

export interface SubstationProps extends SubstationUnitProps {
    id?: string
    name?: string
    yardName?: string
    substationGroup: SubstationGroup
    voltage: TransmissionVoltage
    arrangement?: SubstationArrangement
    buses?: SubstationBus[]
    bays?: SubstationBay[]
    takeOffs?: SubstationTakeOff[]
    equipments?: SubstationEquipment[]
}

export interface SubstationNamingHints extends SubstationUnitNamingHints {
    /** Site code the yard belongs to, e.g. "CNO". */
    groupName?: string
    /** Yard name, e.g. "230KV"; derived from `voltage` when missing (`yardNameForVoltage`). */
    yardName?: string
    voltage?: TransmissionVoltage | string
}

/**
 * A voltage yard of a site. Default yard name from the voltage (`230KV`,
 * `300KVDC`), default id `SSY_<group>_<yard>`, default name the yard name.
 */
export class Substation extends SubstationUnit {
    static readonly idPrefix = 'SSY'

    /** The yard name the hints give: the stated one, else the voltage without its AC prefix (`DC` suffixed). */
    static defaultYardName(hints: SubstationNamingHints = {}): string | undefined {
        return hints.yardName || yardNameForVoltage(hints.voltage ? String(hints.voltage) : undefined)
    }

    static defaultId(hints: SubstationNamingHints = {}): string {
        const tokens = [hints.groupName, Substation.defaultYardName(hints) || hints.name].filter(Boolean)
        return tokens.length ? joinId(this.idPrefix, ...tokens) : super.defaultId()
    }

    static defaultName(hints: SubstationNamingHints = {}): string | undefined {
        return hints.name || Substation.defaultYardName(hints)
    }

    public substationGroup: SubstationGroup
    public voltage: TransmissionVoltage
    public arrangement?: SubstationArrangement
    public buses: SubstationBus[]
    public bays: SubstationBay[]
    public takeOffs: SubstationTakeOff[]
    public equipments: SubstationEquipment[]

    constructor(props: SubstationProps) {
        const hints: SubstationNamingHints = {name: props.name, groupName: props.substationGroup?.name, yardName: props.yardName, voltage: props.voltage}
        super({...props, id: props.id || Substation.defaultId(hints), name: props.name || Substation.defaultName(hints)})
        this.substationGroup = props.substationGroup
        this.voltage = props.voltage
        this.arrangement = props?.arrangement
        this.buses = props?.buses || []
        this.bays = props?.bays || []
        this.takeOffs = props?.takeOffs || []
        this.equipments = props?.equipments || []
    }
}
