/**
 * How a circuit's conductors are carried (`mountType`) and the tower it hangs on (`towerType`) when it takes them from
 * templates: the circuit panel's *Apply circuit template*, its conductor template button, and the line and circuit
 * wizards.
 */
import {type ConductorMountType, preferredMountType, type TransmissionWireType} from '@shared/models/transmission.conductor'
import {towerTypeApplies} from '@shared/models/transmission.tower'
import type {TransmissionCircuitRecord} from '@shared/network/records'

/** A circuit's mount type and tower type. */
export type CircuitMount = Pick<TransmissionCircuitRecord, 'mountType' | 'towerType'>

/**
 * The mount a circuit takes from its templates: the circuit template's; else its own when the conductor's list
 * (`suits`) has it, else the conductor's preferred one (`preferredMountType`); unchanged without a list (no conductor
 * template). Its tower type stays only where it still applies (`towerTypeApplies`).
 */
export function templateMount(current: CircuitMount, suits: ConductorMountType[] | undefined, fromCircuitTemplate: ConductorMountType | undefined, wireType: TransmissionWireType | undefined): CircuitMount {
    const mountType = fromCircuitTemplate ?? (!suits ? current.mountType : current.mountType && suits.includes(current.mountType) ? current.mountType : preferredMountType(suits))
    return {mountType, towerType: current.towerType && towerTypeApplies(mountType, wireType) ? current.towerType : undefined}
}
