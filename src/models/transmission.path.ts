import {TransmissionUnit, TransmissionUnitNamingHints, TransmissionUnitProps} from "./transmission.unit";
import {CoordinatesProps} from "./coordinates";
import {TransmissionJunction} from "./transmission.junction";
import {Substation} from "./substation";
import {joinId} from "./naming";

export interface TransmissionPathProps extends TransmissionUnitProps {
    name: string
    /** Where the route starts / ends: a substation yard or a line junction. */
    from?: TransmissionJunction | Substation
    to?: TransmissionJunction | Substation
    /** Intermediate waypoints of the route, ordered from the FROM end to the TO end of the circuits that use it. */
    waypoints?: CoordinatesProps[]
}

export interface TransmissionPathNamingHints extends TransmissionUnitNamingHints {
    /** Name of the yard / junction the route starts at, e.g. "CNO_230KV". */
    from?: string
    /** Name of the yard / junction the route ends at, e.g. "JT1". */
    to?: string
    /** 1-based number among the routes between the same ends; 1 adds nothing. */
    sequence?: number
}

/**
 * The physical route of one or more transmission circuits (e.g. the tower line
 * carrying two parallel circuits). Every `TransmissionCircuit` references
 * exactly one path; several circuits may share it. Default name
 * `<from>-<to>` (`… (2)` for a second route), default id `TPA_<from>_<to>`.
 */
export class TransmissionPath extends TransmissionUnit {
    static readonly idPrefix = 'TPA'

    static defaultId(hints: TransmissionPathNamingHints = {}): string {
        const ends = [hints.from, hints.to].filter(Boolean)
        if (!ends.length) return super.defaultId(hints)
        return joinId(this.idPrefix, ...ends, hints.sequence && hints.sequence > 1 ? hints.sequence : undefined)
    }

    static defaultName(hints: TransmissionPathNamingHints = {}): string | undefined {
        if (hints.name) return hints.name
        if (!hints.from && !hints.to) return undefined
        return `${hints.from ?? 'OPEN'}-${hints.to ?? 'OPEN'}${hints.sequence && hints.sequence > 1 ? ` (${hints.sequence})` : ''}`
    }

    public name: string
    public from?: TransmissionJunction | Substation
    public to?: TransmissionJunction | Substation
    public waypoints: CoordinatesProps[]

    constructor(props: TransmissionPathProps) {
        const hints: TransmissionPathNamingHints = {name: props.name, from: props.from?.name, to: props.to?.name}
        super({...props, id: props.id || TransmissionPath.defaultId(hints)})
        this.name = props.name || TransmissionPath.defaultName(hints) || this.id
        this.from = props?.from
        this.to = props?.to
        this.waypoints = props?.waypoints || []
    }
}
