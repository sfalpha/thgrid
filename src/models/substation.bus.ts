import {SubstationBay, SubstationBayNamingHints, SubstationBayProps} from "./substation.bay";
import {joinId, joinName} from "./naming";

export enum SubstationBusType {
    MAIN = 'MAIN',
    TRANSFER = 'TRANSFER'
}

export interface SubstationBusProps extends SubstationBayProps {
    busNumber?: string
    busType?: SubstationBusType
    row?: number
}

export interface SubstationBusNamingHints extends SubstationBayNamingHints {
    busType?: SubstationBusType | string
    /** Bus number; ignored for a transfer bus. */
    busNumber?: string
}

/** A bus of a yard. Default id `SBU_<group>_<yard>_<type>_BUS_<n>`, default name `<type>_BUS_<n>` (`TRANSFER_BUS` without a number). */
export class SubstationBus extends SubstationBay {
    static readonly idPrefix = 'SBU'

    /** Normalised `[busType, busNumber]`: MAIN by default, number 1 by default, no number for a transfer bus. */
    private static busTokens(hints: SubstationBusNamingHints): [string, string | undefined] {
        const busType = String(hints.busType || SubstationBusType.MAIN)
        const busNumber = busType === SubstationBusType.TRANSFER ? undefined : (hints.busNumber || '1')
        return [busType, busNumber]
    }

    static defaultId(hints: SubstationBusNamingHints = {}): string {
        const [busType, busNumber] = SubstationBus.busTokens(hints)
        return joinId(this.idPrefix, hints.groupName, hints.yardName, busType, 'BUS', busNumber)
    }

    static defaultName(hints: SubstationBusNamingHints = {}): string | undefined {
        if (hints.name) return hints.name
        const [busType, busNumber] = SubstationBus.busTokens(hints)
        return joinName([busType, 'BUS', busNumber])
    }

    public busType: string
    public busNumber?: string
    public row?: number

    constructor(props: SubstationBusProps) {
        const hints: SubstationBusNamingHints = {
            name: props.name, groupName: props.substation?.substationGroup?.name, yardName: props.substation?.name,
            busType: props.busType, busNumber: props.busNumber,
        }
        const [busType, busNumber] = SubstationBus.busTokens(hints)
        super({...props, id: props.id || SubstationBus.defaultId(hints), name: props.name || SubstationBus.defaultName(hints)})
        this.busType = busType
        this.busNumber = busNumber
        this.row = props?.row
    }
}
