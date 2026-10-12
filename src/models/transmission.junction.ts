import {TransmissionUnit, TransmissionUnitNamingHints, TransmissionUnitProps} from "./transmission.unit";
import {TransmissionConnection} from "./transmission.connection";
import {joinId} from "./naming";

export type TransmissionJunctionConnections = {
    [key: string]: TransmissionConnection
}

export interface TransmissionJunctionProps extends TransmissionUnitProps {
    connections?: TransmissionJunctionConnections
}

export interface TransmissionJunctionNamingHints extends TransmissionUnitNamingHints {
    /** 1-based number of the junction in the network, used for the default name `JT<n>`. */
    sequence?: number
}

/** A tap / splice point on a line. Default name `JT<n>`, default id `TJT_<name>`. */
export class TransmissionJunction extends TransmissionUnit {
    static readonly idPrefix = 'TJT'

    static defaultId(hints: TransmissionJunctionNamingHints = {}): string {
        return joinId(this.idPrefix, TransmissionJunction.defaultName(hints))
    }

    static defaultName(hints: TransmissionJunctionNamingHints = {}): string {
        return hints.name || `JT${hints.sequence ?? 1}`
    }

    connections: TransmissionJunctionConnections

    constructor(props: TransmissionJunctionProps) {
        const hints: TransmissionJunctionNamingHints = {name: props.name}
        super({...props, id: props.id || TransmissionJunction.defaultId(hints), name: props.name || TransmissionJunction.defaultName(hints)})
        this.connections = props?.connections || {}
    }
}
