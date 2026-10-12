/**
 * Tower positions of the circuits on one path. A line group is one tower
 * line (\`lineGroup\`); in it each circuit has a number (\`groupCircuit\`):
 * circuits 1 and 2 hang on the top pair of arms (1 left, 2 right, looking from
 * the path's FROM end), 3 and 4 on the pair below, and so on. Circuits set
 * them on the record; the others are assigned here, in the order given (name
 * order): a circuit with a group but no number takes the next free number of
 * its group, a circuit with neither goes on a new tower after the highest
 * group in use, two per tower (the typical double-circuit tower).
 *
 * On the map the towers of a path run side by side, group 1 on the left (as
 * seen from the FROM end), and within a tower its circuits fill the lanes from
 * the middle outwards (1 / 2 in the middle, 3 / 4 outside them: the higher a
 * pair hangs, the nearer the middle); the whole is centred on the path, so a
 * single circuit runs on the path's line.
 */
import type {TransmissionCircuitRecord} from '@shared/network/records'

export interface TowerSlot {
    circuit: TransmissionCircuitRecord
    /** The tower (line group), 1 = the first one, on the left. */
    group: number
    /** Number of the circuit on its tower: 1 / 2 the top pair, 3 / 4 the next one down, … */
    number: number
    /** Arm pair the circuit hangs on, 1 = the top one. */
    level: number
    /** 1 = left, 2 = right (looking from the path's FROM end). */
    side: number
    /** Assigned here (the circuit sets no tower position, or only its group). */
    auto: boolean
}

const slotOf = (circuit: TransmissionCircuitRecord, group: number, number: number, auto: boolean): TowerSlot =>
    ({circuit, group, number, level: Math.ceil(number / 2), side: number % 2 === 1 ? 1 : 2, auto})

/** The tower slots of a path's circuits, in the order given (see the module comment). */
export function towerSlots(circuits: TransmissionCircuitRecord[]): TowerSlot[] {
    const taken = new Set<string>()
    const out = new Map<string, TowerSlot>()
    for (const c of circuits) {
        if (c.lineGroup === undefined || c.groupCircuit === undefined) continue
        out.set(c.id, slotOf(c, c.lineGroup, c.groupCircuit, false))
        taken.add(`${c.lineGroup}|${c.groupCircuit}`)
    }
    // a group without a number: the next free number on that tower
    for (const c of circuits) {
        if (c.lineGroup === undefined || c.groupCircuit !== undefined) continue
        let n = 1
        while (taken.has(`${c.lineGroup}|${n}`)) n++
        out.set(c.id, slotOf(c, c.lineGroup, n, true))
        taken.add(`${c.lineGroup}|${n}`)
    }
    // neither: two per new tower, sequentially
    let group = Math.max(0, ...circuits.map(c => c.lineGroup ?? 0)), number = 2
    for (const c of circuits) {
        if (out.has(c.id)) continue
        if (number === 2) {
            group++
            number = 1
        } else number = 2
        out.set(c.id, slotOf(c, group, number, true))
    }
    return circuits.map(c => out.get(c.id)!)
}

/** Whether any circuit of the path sets its tower position (then the map keeps it, see `layoutLanes`). */
export const hasTowerHints = (circuits: TransmissionCircuitRecord[]) => circuits.some(c => c.lineGroup !== undefined)

/**
 * Sideways lane position of each circuit (in lanes, positive = left of the path's direction, as `offsetPoints` takes
 * it): on its tower ±(level − ½), left side positive; the towers side by side from the left in group order, one lane
 * apart; then centred on the path.
 */
export function towerLanePositions(circuits: TransmissionCircuitRecord[]): Map<string, number> {
    const slots = towerSlots(circuits)
    const out = new Map<string, number>()
    if (!slots.length) return out
    let cursor = 0   // where the next tower's leftmost lane goes
    for (const group of [...new Set(slots.map(s => s.group))].sort((a, b) => a - b)) {
        const local = slots.filter(s => s.group === group).map(s => ({id: s.circuit.id, pos: (s.side === 1 ? 1 : -1) * (s.level - 0.5)}))
        const shift = cursor - Math.max(...local.map(l => l.pos))
        for (const l of local) out.set(l.id, l.pos + shift)
        cursor = shift + Math.min(...local.map(l => l.pos)) - 1
    }
    const values = [...out.values()]
    const mid = (Math.min(...values) + Math.max(...values)) / 2
    for (const [id, pos] of out) out.set(id, pos - mid)
    return out
}
