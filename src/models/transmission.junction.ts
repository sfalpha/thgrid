import {TransmissionUnit, TransmissionUnitNamingHints, TransmissionUnitProps} from "./transmission.unit";
import {TransmissionConnection} from "./transmission.connection";
import {joinId, joinName} from "./naming";

export type TransmissionJunctionConnections = {
    [key: string]: TransmissionConnection
}

export interface TransmissionJunctionProps extends TransmissionUnitProps {
    connections?: TransmissionJunctionConnections
}

export interface TransmissionJunctionNamingHints extends TransmissionUnitNamingHints {
    /** Code of the site closest to the junction, the prefix of the default name `<site>_J<n>`. */
    site?: string
    /** 1-based number of the junction (among those named after the same site), used for the default name. */
    sequence?: number
}

/** A tap / splice point on a line. Default name `<closest site>_J<n>` (`J<n>` without a site), default id `TJT_<name>`. */
export class TransmissionJunction extends TransmissionUnit {
    static readonly idPrefix = 'TJT'

    static defaultId(hints: TransmissionJunctionNamingHints = {}): string {
        return joinId(this.idPrefix, TransmissionJunction.defaultName(hints))
    }

    static defaultName(hints: TransmissionJunctionNamingHints = {}): string {
        return hints.name || joinName([hints.site, `J${hints.sequence ?? 1}`])
    }

    connections: TransmissionJunctionConnections

    constructor(props: TransmissionJunctionProps) {
        const hints: TransmissionJunctionNamingHints = {name: props.name}
        super({...props, id: props.id || TransmissionJunction.defaultId(hints), name: props.name || TransmissionJunction.defaultName(hints)})
        this.connections = props?.connections || {}
    }
}
