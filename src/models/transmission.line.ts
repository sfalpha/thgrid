import {TransmissionUnit, TransmissionUnitNamingHints, TransmissionUnitProps} from "./transmission.unit";
import {TransmissionConnection} from "./transmission.connection";
import {TransmissionCircuit} from "./transmission.circuit";
import {Substation} from "./substation";
import {TransmissionVoltage} from "./transmission.voltage";
import {joinId, joinName, seqToken, voltageLabel} from "./naming";

export interface TransmissionLineProps extends TransmissionUnitProps {
    connections?: TransmissionConnection[]
    /** Circuit sections, ordered from the FROM yard to the TO yard. A section may belong to several lines (a tie). */
    circuits?: TransmissionCircuit[]
    from?: Substation
    to?: Substation
}

export interface TransmissionLineNamingHints extends TransmissionUnitNamingHints {
    /** Site code at one end, e.g. "CNO". */
    from?: string
    /** Site code at the other end, e.g. "CTI". */
    to?: string
    voltage?: TransmissionVoltage | string
    /** 1-based number among the lines between the same two substations: `L<n>` (defaults to 1). */
    sequence?: number
}

/** A named line between two substations. Default name `<kV>_<from>_<to>_L<n>` (e.g. `230KV_CNO_CTI_L1`), default id `TLN_<name>`. */
export class TransmissionLine extends TransmissionUnit {
    static readonly idPrefix = 'TLN'

    static defaultId(hints: TransmissionLineNamingHints = {}): string {
        const name = TransmissionLine.defaultName(hints)
        return name ? joinId(this.idPrefix, name) : super.defaultId()
    }

    static defaultName(hints: TransmissionLineNamingHints = {}): string | undefined {
        if (hints.name) return hints.name
        if (!hints.from && !hints.to) return undefined
        return joinName([voltageLabel(String(hints.voltage ?? '')), hints.from, hints.to, seqToken('L', hints.sequence ?? 1)])
    }

    connections: TransmissionConnection[]
    circuits: TransmissionCircuit[]
    from?: Substation
    to?: Substation

    constructor(props: TransmissionLineProps) {
        const hints: TransmissionLineNamingHints = {name: props.name, from: props.from?.substationGroup?.name, to: props.to?.substationGroup?.name, voltage: props.from?.voltage}
        super({...props, id: props.id || TransmissionLine.defaultId(hints), name: props.name || TransmissionLine.defaultName(hints)})
        this.connections = props?.connections || []
        this.circuits = props?.circuits || []
        this.from = props?.from
        this.to = props?.to
    }
}
