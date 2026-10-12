import {SubstationUnit, SubstationUnitNamingHints, SubstationUnitProps} from "./substation.unit";
import {Substation} from "./substation";
import {joinId} from "./naming";
import {GenerationType} from "./generation";

export interface SubstationGroupProps extends SubstationUnitProps {
    id?: string
    name?: string
    groupName?: string
    substations?: Substation[]
    /** The site is a power plant / power producer. */
    generation?: boolean
    /** Kinds of generation at the site (meaningful when `generation` is set). */
    generationTypes?: GenerationType[]
}

export interface SubstationGroupNamingHints extends SubstationUnitNamingHints {
    /** Short site code, e.g. "CNO". */
    groupName?: string
}

/** A substation site. Default id `SSG_<groupName>`, default name the group name. */
export class SubstationGroup extends SubstationUnit {
    static readonly idPrefix = 'SSG'

    static defaultId(hints: SubstationGroupNamingHints = {}): string {
        const code = hints.groupName || hints.name
        return code ? joinId(this.idPrefix, code) : super.defaultId()
    }

    static defaultName(hints: SubstationGroupNamingHints = {}): string | undefined {
        return hints.name || hints.groupName || undefined
    }

    public substations: Substation[]
    public generation: boolean
    public generationTypes: GenerationType[]

    public constructor(props: SubstationGroupProps) {
        const hints: SubstationGroupNamingHints = {name: props.name, groupName: props.groupName}
        super({...props, id: props.id || SubstationGroup.defaultId(hints), name: props.name || SubstationGroup.defaultName(hints)})
        this.substations = props?.substations || []
        this.generation = props?.generation ?? false
        this.generationTypes = props?.generationTypes || []
    }
}
