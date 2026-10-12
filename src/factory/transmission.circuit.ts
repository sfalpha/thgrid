import {TransmissionCircuitTemplate} from "../templates/transmission.circuit";
import {TransmissionCircuit} from "../models/transmission.circuit";
import {TransmissionPath} from "../models/transmission.path";

interface TransmissionCircuitMeta {
    name: string
    /** Physical route of the circuit; shared with parallel circuits. */
    path: TransmissionPath
}

export class TransmissionCircuitFactory {
    public static new(template: TransmissionCircuitTemplate, meta: TransmissionCircuitMeta): TransmissionCircuit {
        return new TransmissionCircuit(
            {
                name: meta.name,
                voltage: template.voltage,
                conductor: template.conductor,
                bundle: template.bundle,
                path: meta.path
            }
        )
    }
}