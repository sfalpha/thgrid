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
 * Circuits in a duct bank (\`mountType\` DUCT_BANK) lie there instead, numbered on
 * their own (duct bank 1, 2, …): the same rules, a duct bank's rows taking the
 * place of a tower's pairs of arms (1 / 2 the top row, left / right, …), two
 * per new duct bank; submarine circuits (SUBMARINE) likewise in submarine
 * groups, numbered apart from both (\`circuitGroupKind\`).
 *
 * On the map the towers of a path run side by side, group 1 on the left (as
 * seen from the FROM end), then the duct banks, then the submarine groups; within a tower (or duct bank)
 * its circuits fill the lanes from the middle outwards (1 / 2 in the middle,
 * 3 / 4 outside them: the higher a pair hangs, the nearer the middle); the
 * whole is centred on the path, so a single circuit runs on the path's line.
 */
import {CIRCUIT_GROUP_KINDS, type CircuitGroupKind, circuitGroupKind, type TransmissionCircuitRecord} from '@shared/network/records'

export interface TowerSlot {
    circuit: TransmissionCircuitRecord
    /** The tower (line group), or the duct bank or submarine group of a circuit in one; 1 = the first one, on the left. */
    group: number
    /** Number of the circuit on its tower: 1 / 2 the top pair, 3 / 4 the next one down, … (in a duct bank: by rows). */
    number: number
    /** Arm pair the circuit hangs on (row of a duct bank), 1 = the top one. */
    level: number
    /** 1 = left, 2 = right (looking from the path's FROM end). */
    side: number
    /** What the group is: a tower, a duct bank (`mountType` DUCT_BANK) or a submarine group (SUBMARINE). */
    kind: CircuitGroupKind
    /** Assigned here (the circuit sets no tower position, or only its group). */
    auto: boolean
}

const slotOf = (circuit: TransmissionCircuitRecord, group: number, number: number, auto: boolean): TowerSlot =>
    ({circuit, group, number, level: Math.ceil(number / 2), side: number % 2 === 1 ? 1 : 2, kind: circuitGroupKind(circuit), auto})

/** The slots of circuits of one kind (all on towers, all in duct banks, or all in submarine groups), keyed by circuit id. */
function slotsOfKind(circuits: TransmissionCircuitRecord[]): Map<string, TowerSlot> {
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
    return out
}

/** The tower (duct bank, submarine group) slots of a path's circuits, in the order given (see the module comment). */
export function towerSlots(circuits: TransmissionCircuitRecord[]): TowerSlot[] {
    const byKind = new Map(CIRCUIT_GROUP_KINDS.map(kind => [kind, slotsOfKind(circuits.filter(c => circuitGroupKind(c) === kind))]))
    return circuits.map(c => byKind.get(circuitGroupKind(c))!.get(c.id)!)
}

/** Whether any circuit of the path sets its tower position (then the map keeps it, see `layoutLanes`). */
export const hasTowerHints = (circuits: TransmissionCircuitRecord[]) => circuits.some(c => c.lineGroup !== undefined)

/**
 * Sideways lane position of each circuit (in lanes, positive = left of the path's direction, as `offsetPoints` takes
 * it): on its tower ±(level − ½), left side positive; the towers side by side from the left in group order, then the
 * duct banks and the submarine groups, one lane apart; then centred on the path.
 */
export function towerLanePositions(circuits: TransmissionCircuitRecord[]): Map<string, number> {
    const slots = towerSlots(circuits)
    const out = new Map<string, number>()
    if (!slots.length) return out
    let cursor = 0   // where the next tower's leftmost lane goes
    const groups = CIRCUIT_GROUP_KINDS.flatMap(kind => [...new Set(slots.filter(s => s.kind === kind).map(s => s.group))].sort((a, b) => a - b).map(group => ({kind, group})))
    for (const {kind, group} of groups) {
        const local = slots.filter(s => s.kind === kind && s.group === group).map(s => ({id: s.circuit.id, pos: (s.side === 1 ? 1 : -1) * (s.level - 0.5)}))
        const shift = cursor - Math.max(...local.map(l => l.pos))
        for (const l of local) out.set(l.id, l.pos + shift)
        cursor = shift + Math.min(...local.map(l => l.pos)) - 1
    }
    const values = [...out.values()]
    const mid = (Math.min(...values) + Math.max(...values)) / 2
    for (const [id, pos] of out) out.set(id, pos - mid)
    return out
}

/**
 * The sub-conductors of a bundle of `bundle` around its centre (px), each a circle of radius `CONDUCTOR_R` (a single
 * conductor the same size): one circle; two side by side; three or more on a regular polygon, two on top (a triangle
 * hanging point down, a square, a pentagon, …). `hang` is how far below the insulator's end the centre lies (the
 * topmost sub-conductor touches it); `height` the bundle's whole height.
 */
/** Radius (px) of a conductor in the tower drawing, alone or in a bundle. */
export const CONDUCTOR_R = 2.4

export function bundleLayout(bundle?: number): { r: number; pts: [number, number][]; hang: number; height: number } {
    const n = Math.max(1, Math.round(bundle ?? 1))
    const r = CONDUCTOR_R
    // the sub-conductors a little apart: neighbours on the polygon keep a 0.8 px gap
    const rho = n === 1 ? 0 : (r + 0.4) / Math.sin(Math.PI / n)
    const pts = Array.from({length: n}, (_, k): [number, number] => {
        const a = -Math.PI / 2 + Math.PI / n + 2 * Math.PI * k / n
        return n === 1 ? [0, 0] : [rho * Math.cos(a), rho * Math.sin(a)]
    })
    const top = Math.min(...pts.map(p => p[1])) - r, bottom = Math.max(...pts.map(p => p[1])) + r
    return {r, pts, hang: -top, height: bottom - top}
}
