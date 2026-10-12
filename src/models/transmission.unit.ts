import {Coordinates} from "./coordinates";
import {v4 as uuidv4} from "uuid";
import {joinId, UnitNamingHints} from "./naming";

export interface TransmissionUnitProps {
    id?: string
    name?: string
    coords?: Coordinates
}

export type TransmissionUnitNamingHints = UnitNamingHints

/**
 * Base of everything on the transmission side. Every subclass has its own id
 * prefix and derives default ids / names from related items (the endpoints
 * of a route, the junction a node sits at, …) through the static
 * `defaultId()` / `defaultName()`, which the frontend also uses to propose
 * ids and names for new records.
 */
export class TransmissionUnit {
    /** Prefix of generated ids; every subclass overrides it. */
    static readonly idPrefix: string = 'TUN'

    /** Default id for the unit described by `hints`: `<prefix>_<name>`, or `<prefix>_<uuid>` when nothing is known. */
    static defaultId(hints: TransmissionUnitNamingHints = {}): string {
        return joinId(this.idPrefix, hints.name || uuidv4())
    }

    /** Default name for the unit described by `hints`; undefined when nothing can be derived. */
    static defaultName(hints: TransmissionUnitNamingHints = {}): string | undefined {
        return hints.name || undefined
    }

    id: string
    name?: string
    coords?: Coordinates

    constructor(props: TransmissionUnitProps = {}) {
        this.id = props.id || uuidv4()
        this.name = props?.name
        this.coords = props?.coords
    }
}
