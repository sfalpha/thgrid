import {SubstationUnit, SubstationUnitNamingHints, SubstationUnitProps} from "./substation.unit";
import {GenerationType} from "./generation";
import {joinId} from "./naming";

export interface GenerationUnitProps extends SubstationUnitProps {
    /** Code of the site the unit belongs to, for the default id. */
    groupName?: string
    /** Kind of generation of the unit. */
    generationType?: GenerationType
    /** Installed (nameplate) capacity in MW. */
    capacityMw?: number
}

export interface GenerationUnitNamingHints extends SubstationUnitNamingHints {
    /** Code of the site the unit belongs to, e.g. "BPK_C". */
    groupName?: string
    /** 1-based number of the unit at its site, for the default name `Block <n>`. */
    sequence?: number
}

/**
 * A generating unit of a generation site: a block of a power plant (a gas or steam turbine set, a combined-cycle
 * block, a hydro unit), a section of a solar or wind farm, a battery system. Commonly named after its block. Default
 * name `Block <n>`, default id `SGU_<site>_<name>`.
 */
export class GenerationUnit extends SubstationUnit {
    static readonly idPrefix = 'SGU'

    static defaultId(hints: GenerationUnitNamingHints = {}): string {
        return joinId(this.idPrefix, hints.groupName, GenerationUnit.defaultName(hints))
    }

    static defaultName(hints: GenerationUnitNamingHints = {}): string {
        return hints.name || `Block ${hints.sequence ?? 1}`
    }

    public generationType?: GenerationType
    public capacityMw?: number

    constructor(props: GenerationUnitProps) {
        const hints: GenerationUnitNamingHints = {name: props.name, groupName: props.groupName}
        super({...props, id: props.id || GenerationUnit.defaultId(hints), name: props.name || GenerationUnit.defaultName(hints)})
        this.generationType = props.generationType
        this.capacityMw = props.capacityMw
    }
}
