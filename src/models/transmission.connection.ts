import {TransmissionUnit, TransmissionUnitNamingHints, TransmissionUnitProps} from "./transmission.unit";
import {TransmissionCircuit} from "./transmission.circuit";
import {SubstationCircuit} from "./substation.circuit";
import {TransmissionJunction} from "./transmission.junction";
import {Substation} from "./substation";
import {joinId} from "./naming";

export interface TransmissionConnectionProps extends TransmissionUnitProps {
    circuits?: (TransmissionCircuit | SubstationCircuit)[]
    junction: TransmissionJunction | Substation
}

export interface TransmissionConnectionNamingHints extends TransmissionUnitNamingHints {
    /** Name of the yard / junction the node sits at, e.g. "CNO_230KV" or "JT1". */
    at?: string
    /** Line name of the take-off the node starts from (nodes at a yard). */
    takeOff?: string
    /** 1-based number of the node at a junction (nodes at a junction): `<junction>_<n>`. */
    sequence?: number
}

/**
 * An electrical node joining circuit ends, at a yard (through a take-off) or
 * at a junction. Default name the take-off's line name at a yard or
 * `<junction>_<n>` at a junction; default id `TCN_<at>_<take-off | n>`.
 */
export class TransmissionConnection extends TransmissionUnit {
    static readonly idPrefix = 'TCN'

    static defaultId(hints: TransmissionConnectionNamingHints = {}): string {
        const tail = hints.takeOff || (hints.at ? hints.sequence ?? 1 : hints.name)
        return hints.at || tail ? joinId(this.idPrefix, hints.at, tail) : super.defaultId()
    }

    static defaultName(hints: TransmissionConnectionNamingHints = {}): string | undefined {
        if (hints.name) return hints.name
        if (hints.takeOff) return hints.takeOff
        return hints.at ? `${hints.at}_${hints.sequence ?? 1}` : undefined
    }

    circuits: (TransmissionCircuit | SubstationCircuit)[]
    junction: TransmissionJunction | Substation

    constructor(props: TransmissionConnectionProps) {
        const hints: TransmissionConnectionNamingHints = {name: props.name, at: props.junction?.name}
        super({...props, id: props.id || TransmissionConnection.defaultId(hints), name: props.name || TransmissionConnection.defaultName(hints)})
        this.junction = props.junction
        this.circuits = props?.circuits || []
    }
}
