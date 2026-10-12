import {SubstationArrangement} from "../models/substation";
import {BayTemplateType} from "../models/substation.bay";
import {SubstationEquipmentType} from "../models/substation.equipment";

/**
 * One piece of equipment of a bay template. `sequence` is its distance from
 * the start row when the template is deployed (row = start ± sequence,
 * upwards or downwards): 0 is the start row itself (usually a bus), so
 * templates normally begin at 1, and skipping numbers leaves blank rows.
 */
export interface BayEquipmentTemplate {
    equipmentType: SubstationEquipmentType
    sequence: number
    /** The equipment is on the line side of the bay: deployed into the bay's take-off column (ground switch first, then CT, PT, …); what a power transformer connects to. */
    lineSide?: boolean
    /** The equipment ties buses (a bus-tie / transfer-bus switch). */
    busTie?: boolean
}

/**
 * A bay template: the equipment stack of one bay for a purpose
 * (`bayTemplateType`), usable in yards of the listed arrangements only. It is
 * independent of yard and bus templates.
 */
export interface SubstationBayTemplate {
    name: string
    bayTemplateType: BayTemplateType
    /** Arrangements the bay suits; the yard editor offers the template to yards of these arrangements only. */
    arrangements: SubstationArrangement[]
    equipments: BayEquipmentTemplate[]
}
