import {v4 as uuidv4} from 'uuid';
import {Coordinates} from "./coordinates";
import {joinId, UnitNamingHints} from "./naming";

export interface SubstationUnitProps {
    id?: string
    name?: string
    coords?: Coordinates
}

export type SubstationUnitNamingHints = UnitNamingHints

/**
 * Base of everything inside a substation. Every subclass has its own id
 * prefix and derives default ids / names from the names of its parents
 * through the static `defaultId()` / `defaultName()`, which the frontend
 * also uses to propose ids and names for new records.
 */
export class SubstationUnit {
    /** Prefix of generated ids; every subclass overrides it. */
    static readonly idPrefix: string = 'SUN'

    /** Default id for the unit described by `hints`: `<prefix>_<name>`, or `<prefix>_<uuid>` when nothing is known. */
    static defaultId(hints: SubstationUnitNamingHints = {}): string {
        return joinId(this.idPrefix, hints.name || uuidv4())
    }

    /** Default name for the unit described by `hints`; undefined when nothing can be derived. */
    static defaultName(hints: SubstationUnitNamingHints = {}): string | undefined {
        return hints.name || undefined
    }

    public id?: string
    public name?: string
    public coords?: Coordinates

    constructor(props: SubstationUnitProps) {
        this.id = props.id || uuidv4()
        this.name = props?.name
        this.coords = props?.coords
    }
}
