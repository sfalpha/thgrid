import {SubstationUnit, SubstationUnitNamingHints, SubstationUnitProps} from "./substation.unit";
import {TransmissionVoltage} from "./transmission.voltage";
import {joinId, seqToken} from "./naming";

export interface SubstationCircuitProps extends SubstationUnitProps {
    current?: number
    voltage?: TransmissionVoltage
}

export interface SubstationCircuitNamingHints extends SubstationUnitNamingHints {
    groupName?: string
    yardName?: string
    /** Line the circuit leads to (a take-off circuit), e.g. "CTI_L1". */
    lineName?: string
    /** 1-based number of an anonymous in-yard circuit (wiring node). */
    sequence?: number
}

/**
 * An electrical circuit inside a yard: the circuit behind a take-off or an
 * anonymous wiring node. Default id `SCC_<group>_<yard>_<line | X<n>>`,
 * default name the line name or `X<n>`.
 */
export class SubstationCircuit extends SubstationUnit {
    static readonly idPrefix: string = 'SCC'

    static defaultId(hints: SubstationCircuitNamingHints = {}): string {
        const tail = hints.lineName || hints.name || seqToken('X', hints.sequence)
        const tokens = [hints.groupName, hints.yardName, tail].filter(Boolean)
        return tokens.length ? joinId(this.idPrefix, ...tokens) : super.defaultId()
    }

    static defaultName(hints: SubstationCircuitNamingHints = {}): string | undefined {
        return hints.name || hints.lineName || seqToken('X', hints.sequence)
    }

    public current?: number
    public voltage?: TransmissionVoltage

    constructor(props: SubstationCircuitProps) {
        super(props);
        this.current = props?.current
        this.voltage = props?.voltage
    }
}
