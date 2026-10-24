/**
 * Circuit templates grouped for a picker by how well they fit the yards the circuit connects to: one group per rated
 * voltage. First the voltages the yards are at, highest first; then templates rated above the yards (they run below
 * their rating there), the closest rating first; last, at the bottom, the unsuitable ones: rated below a connected yard
 * (they would run above their rating), of the other current type, or without a voltage. Without a yard to go by every
 * voltage is listed, highest first. Within a group the templates keep the order given (the collections' order: the
 * smaller conductors first).
 */
import {TransmissionType, TransmissionVoltage, transmissionTypeOf, voltageValueKv, withinRating} from '@shared/models/transmission.voltage'

export interface TemplateGroup<T> {
    /** E.g. `230 kV`, `500 kV · rated above the yards`, `115 kV · below the yards' voltage`. */
    label: string
    voltage?: TransmissionVoltage
    /** At the yards' voltage, or above it; false: unsuitable (listed last). */
    suitable: boolean
    items: T[]
}

/** A voltage as group titles name it: `230 kV`, `300 kV DC`. */
export function voltageTitle(v?: TransmissionVoltage | string): string {
    if (!v) return 'No voltage'
    const kv = voltageValueKv(v)
    if (kv === undefined) return String(v)
    return `${kv} kV${transmissionTypeOf(v) === TransmissionType.DC ? ' DC' : ''}`
}

export function circuitTemplateGroups<T extends { data: { voltage?: TransmissionVoltage } }>(templates: T[], yardVoltages: (TransmissionVoltage | undefined)[]): TemplateGroup<T>[] {
    // the yards' voltages that tell something (not unknown, not de-energized)
    const at = [...new Set(yardVoltages.filter((v): v is TransmissionVoltage => !!v && v !== TransmissionVoltage.DE_ENERGIZED))]
    const kv = (v?: TransmissionVoltage) => voltageValueKv(v) ?? -1
    const byVoltage = new Map<string, T[]>()
    for (const t of templates) {
        const key = t.data.voltage ?? ''
        const list = byVoltage.get(key)
        if (list) list.push(t)
        else byVoltage.set(key, [t])
    }
    const groups = [...byVoltage].map(([key, items]) => {
        const voltage = (key || undefined) as TransmissionVoltage | undefined
        // suitable: it can run at every connected yard's voltage (the same current type, rated at or above it)
        const suitable = !!voltage && at.every(y => withinRating(voltage, y))
        const exact = !!voltage && at.includes(voltage)
        return {voltage, items, suitable, exact}
    })
    const rank = (g: typeof groups[number]) => !at.length ? (g.voltage ? 0 : 1) : g.exact && g.suitable ? 0 : g.suitable ? 1 : 2
    groups.sort((a, b) => rank(a) - rank(b)
        // the yards' voltages and the unsuitable ones highest first; those rated above the yards closest first
        || (rank(a) === 1 && at.length ? kv(a.voltage) - kv(b.voltage) : kv(b.voltage) - kv(a.voltage)))
    return groups.map(g => ({
        voltage: g.voltage, suitable: !at.length || g.suitable, items: g.items,
        label: !at.length || (g.exact && g.suitable) ? voltageTitle(g.voltage)
            : g.suitable ? `${voltageTitle(g.voltage)} · rated above the yards (runs below its rating)`
                : !g.voltage ? 'No voltage' : `${voltageTitle(g.voltage)} · not for these yards (below their voltage, or another type)`,
    }))
}
