import {SubstationArrangement} from "../models/substation";
import {SubstationBusType} from "../models/substation.bus";
import {TransmissionVoltage} from "../models/transmission.voltage";

/**
 * A bus of a yard template: deployed as one `SubstationBusRecord` of the
 * yard (type, number and diagram row; the voltage is the yard's).
 */
export interface SubstationBusTemplate {
    name: string
    busType: SubstationBusType
    /** Bus number; ignored for a transfer bus. */
    busNumber?: string
    /** Vertical position in the single-line diagram (0 = bottom). */
    row: number
}

/**
 * A yard (substation) template: the arrangement and the buses a yard of that
 * arrangement starts with. Deploying it onto a yard sets the yard's
 * arrangement, creates the buses and a chosen number of empty bays; bays are
 * then filled from bay templates (`SubstationBayTemplate`), which are not
 * tied to a yard template but to the arrangements they suit.
 */
export interface SubstationYardTemplate {
    name: string
    arrangement: SubstationArrangement
    /** Voltage the template is meant for (informational: a deployed yard keeps its own voltage). */
    voltage?: TransmissionVoltage
    buses: SubstationBusTemplate[]
}
