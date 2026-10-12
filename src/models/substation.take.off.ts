import {SubstationUnit, SubstationUnitNamingHints, SubstationUnitProps} from "./substation.unit";
import {SubstationBay} from "./substation.bay";
import {SubstationCircuit} from "./substation.circuit";
import {joinId, joinName, yardNameForVoltage} from "./naming";
import {TransmissionVoltage} from "./transmission.voltage";

export interface SubstationTakeOffProps extends SubstationUnitProps {
    bay: SubstationBay
    circuit?: SubstationCircuit
    lineName?: string
    /** Voltage of the line leaving here when it is not the yard's (the secondary or auxiliary side of a transformer in the yard). */
    voltage?: TransmissionVoltage
}

export interface SubstationTakeOffNamingHints extends SubstationUnitNamingHints {
    groupName?: string
    yardName?: string
    /** Name of the line leaving through the take-off, e.g. "CTI_L1"; derived from `targetCode` + `sequence` when missing. */
    lineName?: string
    /** Site code of the substation the line goes to, e.g. "CTI". */
    targetCode?: string
    /** Voltage of the yard the line leaves from; leads the line name as `230KV` / `300KVDC`. */
    voltage?: string
    /** 1-based number of the line toward that site from this yard (defaults to 1). */
    sequence?: number
}

/**
 * The point where a line leaves a yard. Default line name
 * `<voltage>_<target site>_L<n>` (`230KV_CTI_L1`), default id
 * `STO_<group>_<yard>_<line>`, default name the line name.
 */
export class SubstationTakeOff extends SubstationUnit {
    static readonly idPrefix = 'STO'

    /** The line name the hints give: the stated one, else `<voltage>_<target code>_L<n>` (the voltage part is left out when unknown). */
    static defaultLineName(hints: SubstationTakeOffNamingHints = {}): string | undefined {
        if (hints.lineName) return hints.lineName
        if (!hints.targetCode) return undefined
        return joinName([yardNameForVoltage(hints.voltage), hints.targetCode, `L${hints.sequence ?? 1}`])
    }

    static defaultId(hints: SubstationTakeOffNamingHints = {}): string {
        const tokens = [hints.groupName, hints.yardName, SubstationTakeOff.defaultLineName(hints) || hints.name].filter(Boolean)
        return tokens.length ? joinId(this.idPrefix, ...tokens) : super.defaultId()
    }

    static defaultName(hints: SubstationTakeOffNamingHints = {}): string | undefined {
        return hints.name || SubstationTakeOff.defaultLineName(hints)
    }

    public bay: SubstationBay
    public circuit: SubstationCircuit
    /** Set when the line leaves at another voltage than the yard's; the yard voltage applies otherwise. */
    public voltage?: TransmissionVoltage

    constructor(props: SubstationTakeOffProps) {
        const hints: SubstationTakeOffNamingHints = {name: props.name, groupName: props.bay?.substation?.substationGroup?.name, yardName: props.bay?.substation?.name, lineName: props.lineName, voltage: props.voltage ?? props.bay?.substation?.voltage}
        super({...props, id: props.id || SubstationTakeOff.defaultId(hints), name: props.name || SubstationTakeOff.defaultName(hints)})
        this.bay = props.bay
        this.voltage = props.voltage
        // The circuit behind the take-off carries the same line name.
        this.circuit = props.circuit ?? new SubstationCircuit({id: SubstationCircuit.defaultId(hints), name: SubstationCircuit.defaultName(hints)})
    }
}
