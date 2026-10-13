import {SubstationUnit, SubstationUnitNamingHints, SubstationUnitProps} from "./substation.unit";
import {SubstationBay} from "./substation.bay";
import {SubstationCircuit} from "./substation.circuit";
import {joinId, joinName, yardNameForVoltage} from "./naming";
import {TransmissionVoltage} from "./transmission.voltage";

export interface SubstationTakeOffProps extends SubstationUnitProps {
    bay: SubstationBay
    /** The take-off's circuit: its voltage is the take-off's (the yard's when it has none), e.g. the secondary or auxiliary side of a transformer in the yard. */
    circuit?: SubstationCircuit
    lineName?: string
}

export interface SubstationTakeOffNamingHints extends SubstationUnitNamingHints {
    groupName?: string
    yardName?: string
    /** Name of the line leaving through the take-off, e.g. "CTI_L1"; derived from `targetCode` + `sequence` when missing. */
    lineName?: string
    /** Site code of the substation the line goes to, e.g. "CTI". */
    targetCode?: string
    /** Voltage of the take-off (its circuit's, else its yard's); leads the line name as `230KV` / `300KVDC`. */
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
    /** The circuit behind the take-off: it carries the take-off's voltage (unset: the yard's). */
    public circuit: SubstationCircuit

    constructor(props: SubstationTakeOffProps) {
        const hints: SubstationTakeOffNamingHints = {name: props.name, groupName: props.bay?.substation?.substationGroup?.name, yardName: props.bay?.substation?.name, lineName: props.lineName, voltage: props.circuit?.voltage ?? props.bay?.substation?.voltage}
        super({...props, id: props.id || SubstationTakeOff.defaultId(hints), name: props.name || SubstationTakeOff.defaultName(hints)})
        this.bay = props.bay
        // The circuit behind the take-off carries the same line name.
        this.circuit = props.circuit ?? new SubstationCircuit({id: SubstationCircuit.defaultId(hints), name: SubstationCircuit.defaultName(hints)})
    }

    /** Voltage of the take-off: its circuit's, else its yard's. */
    get voltage(): TransmissionVoltage | undefined {
        return this.circuit.voltage ?? this.bay?.substation?.voltage
    }
}
