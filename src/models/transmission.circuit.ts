import {TransmissionUnit, TransmissionUnitNamingHints, TransmissionUnitProps} from "./transmission.unit";
import {TransmissionVoltage} from "./transmission.voltage";
import {TransmissionConductor} from "./transmission.conductor";
import {TransmissionPath} from "./transmission.path";
import {joinId, joinName, seqToken, voltageLabel} from "./naming";

export interface TransmissionCircuitProps extends TransmissionUnitProps {
    current?: number
    /** Rated (design) voltage of the circuit. */
    voltage?: TransmissionVoltage
    /** Voltage the circuit is actually operated at; normally the voltage of the connections it joins. */
    energizedVoltage?: TransmissionVoltage
    bundle?: number
    conductor: TransmissionConductor
    /** Physical route of the circuit; may be shared with parallel circuits. */
    path: TransmissionPath
}

export interface TransmissionCircuitNamingHints extends TransmissionUnitNamingHints {
    /** Name of the yard / junction at the FROM end (the site code for a yard, e.g. "CNO"). */
    from?: string
    /** Name of the yard / junction at the TO end, e.g. "CTI" or "JT1". */
    to?: string
    /** Rated voltage; its label leads the name (`AC230KV` → `230KV`). */
    voltage?: TransmissionVoltage | string
    /** 1-based number among the circuits between the same ends: `S<n>`. */
    sequence?: number
}

/**
 * A transmission circuit. Default name `<kV>_<from>_<to>_S<n>` in the EGAT
 * style (e.g. `230KV_CNO_CTI_S1`), default id `TCC_<name>`.
 */
export class TransmissionCircuit extends TransmissionUnit {
    static readonly idPrefix = 'TCC'

    static defaultId(hints: TransmissionCircuitNamingHints = {}): string {
        const name = TransmissionCircuit.defaultName(hints)
        return name ? joinId(this.idPrefix, name) : super.defaultId()
    }

    static defaultName(hints: TransmissionCircuitNamingHints = {}): string | undefined {
        if (hints.name) return hints.name
        if (!hints.from && !hints.to) return undefined
        return joinName([voltageLabel(String(hints.voltage ?? '')), hints.from, hints.to, seqToken('S', hints.sequence)])
    }

    public current?: number
    public voltage?: TransmissionVoltage
    public energizedVoltage?: TransmissionVoltage
    public bundle?: number
    public conductor: TransmissionConductor
    public path: TransmissionPath

    constructor(props: TransmissionCircuitProps) {
        const hints: TransmissionCircuitNamingHints = {name: props.name, from: props.path?.from?.name, to: props.path?.to?.name, voltage: props.voltage}
        super({...props, id: props.id || TransmissionCircuit.defaultId(hints), name: props.name || TransmissionCircuit.defaultName(hints)})
        this.current = props?.current
        this.voltage = props?.voltage
        this.energizedVoltage = props?.energizedVoltage
        this.bundle = props?.bundle
        this.conductor = props.conductor
        this.path = props.path
    }
}
