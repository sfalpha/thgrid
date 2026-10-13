/**
 * In-place upgrades of older network documents. Applied by the backend on
 * every read (saved document, replayed working document, archived version,
 * import, validate), so files written by earlier versions keep working and
 * are upgraded on their next save.
 */
import {SubstationEquipmentType} from '../models/substation.equipment'
import {CIRCUIT_END_FROM, CIRCUIT_END_TO, ConnectionJunctionKind, ConnectionJunctionRef, ConnectionRecord, ConnectionScope, NetworkDocument, NetworkNodeKind, TransmissionPathRecord} from "./records";
import {uniqueId} from "./ops";
import {defaultWindingVoltage, isTransformerType, terminalsFromWindings, TransformerWindingRecord} from "./records";
import {TransformerWindingSide, TransformerWindingTapChanger, TransformerWindingWiring} from "../models/transformer";
import {pathEndOf, takeOffCircuit, takeOffVoltage} from "./refs";
import {CoordinatesProps} from "../models/coordinates";
import {TransmissionVoltage} from "../models/transmission.voltage";
import {junctionConnectionNaming} from "./naming";
import {genericConductor} from "../models/transmission.conductor";

export {takeOffCircuit, takeOffVoltage}

export interface MigrationResult {
    doc: NetworkDocument
    /** Human readable notes of what was changed; empty when nothing was. */
    changes: string[]
}

/** Next free default name for a connection at a junction: `<junction name>_<n>` (see `junctionConnectionNaming`). */
export function nextJunctionConnectionName(doc: NetworkDocument, junctionId: string, extraTaken: string[] = []): string {
    return junctionConnectionNaming(doc, junctionId, undefined, extraTaken).name
}

export function isJunctionConnection(c: ConnectionRecord): boolean {
    return c.scope === ConnectionScope.TRANSMISSION && c.junction?.kind === ConnectionJunctionKind.TRANSMISSION_JUNCTION
}

/**
 * Voltage a circuit end takes when it joins `conn`: the node's own voltage; at a substation else its take-off's
 * (`takeOffVoltage`), else the yard's.
 */
export function connectionVoltage(doc: NetworkDocument, conn: ConnectionRecord): TransmissionVoltage | undefined {
    if (conn.voltage) return conn.voltage
    if (conn.junction?.kind === ConnectionJunctionKind.SUBSTATION) {
        const takeOff = conn.nodes.find(n => n.kind === NetworkNodeKind.SUBSTATION_TAKE_OFF)
        return (takeOff && takeOffVoltage(doc, takeOff.id)) ?? doc.substations.find(s => s.id === conn.junction.id)?.voltage
    }
    return undefined
}

/** The TRANSMISSION connection holding this circuit end (FROM / TO), if any. */
export function circuitEndConnection(doc: NetworkDocument, circuitId: string, end: string): ConnectionRecord | undefined {
    return doc.connections.find(c => c.scope === ConnectionScope.TRANSMISSION && c.nodes.some(n => n.kind === NetworkNodeKind.TRANSMISSION_CIRCUIT && n.id === circuitId && n.terminal === end))
}

export function migrateNetworkDocument(input: NetworkDocument): MigrationResult {
    const changes: string[] = []
    let doc = input

    // v1 → connections at junctions carry a name; default "<junction>_<n>".
    if (Array.isArray(doc.connections) && doc.connections.some(c => isJunctionConnection(c) && !(typeof c.name === 'string' && c.name.trim()))) {
        const assigned: string[] = []
        const connections = doc.connections.map(c => {
            if (!isJunctionConnection(c) || (typeof c.name === 'string' && c.name.trim())) return c
            const name = nextJunctionConnectionName(doc, c.junction.id, assigned)
            assigned.push(name)
            changes.push(`connection ${c.id}: named "${name}"`)
            return {...c, name}
        })
        doc = {...doc, connections}
    }

    // v1 → circuits reference a shared TransmissionPath instead of carrying waypoints.
    if (!Array.isArray(doc.paths)) {
        doc = {...doc, paths: []}
        changes.push('added empty "paths" collection')
    }
    // v3 → yard links (connections between two yards) live in their own collection.
    if (!Array.isArray(doc.yardConnections)) {
        doc = {...doc, yardConnections: []}
        changes.push('added empty "yardConnections" collection')
    }
    // v8 → a take-off carries no voltage of its own: it moves to the take-off's circuit (the TRANSMISSION connection
    // holding it, which it overrides; else the in-yard connection it is wired into, unless that has one already);
    // a free take-off wired nowhere keeps its yard's voltage.
    const voltaged = (doc.takeOffs ?? []).filter(t => (t as { voltage?: TransmissionVoltage }).voltage)
    if (voltaged.length || (doc.takeOffs ?? []).some(t => 'voltage' in t)) {
        let connections = doc.connections
        const setVoltage = (id: string, voltage: TransmissionVoltage) => {
            connections = connections.map(c => c.id === id ? {...c, voltage} : c)
        }
        for (const t of voltaged) {
            const v = (t as { voltage?: TransmissionVoltage }).voltage!
            const circuit = takeOffCircuit({...doc, connections}, t.id)
            if (circuit.line) {
                if (circuit.line.voltage !== v) {
                    setVoltage(circuit.line.id, v)
                    changes.push(`take-off ${t.lineName}: its voltage ${v} moved to its circuit ${circuit.line.name ?? circuit.line.id}${circuit.line.voltage ? ` (was ${circuit.line.voltage})` : ''}`)
                }
            } else if (circuit.yard.length) {
                if (!circuit.yard.some(c => c.voltage)) {
                    setVoltage(circuit.yard[0].id, v)
                    changes.push(`take-off ${t.lineName}: its voltage ${v} moved to its in-yard circuit ${circuit.yard[0].name ?? circuit.yard[0].id}`)
                }
            } else if (v !== doc.substations.find(s => s.id === t.substationId)?.voltage) {
                changes.push(`take-off ${t.lineName}: its voltage ${v} was dropped (no circuit attached, not wired in the yard): it is at its yard's voltage until a circuit of it sets one`)
            }
        }
        doc = {...doc, connections, takeOffs: doc.takeOffs.map(t => {
            if (!('voltage' in t)) return t
            const {voltage: _, ...rest} = t as typeof t & { voltage?: TransmissionVoltage }
            return rest
        })}
        changes.push('take-offs: voltage moved to their circuits')
    }
    // v7 → generation sites list their generating units in their own collection.
    if (!Array.isArray(doc.generationUnits)) {
        doc = {...doc, generationUnits: []}
        changes.push('added empty "generationUnits" collection')
    }
    // v6 → transformers carry their windings (side, wiring, tap changer, voltage, ratings); older records only had terminals.
    const SIDES: Record<string, TransformerWindingSide> = {PRIMARY: TransformerWindingSide.PRIMARY, SECONDARY: TransformerWindingSide.SECONDARY, AUXILIARY: TransformerWindingSide.AUXILIARY}
    const unwound = (doc.equipments ?? []).filter(e => isTransformerType(e.equipmentType) && !e.windings && Array.isArray(e.terminals) && e.terminals.length)
    if (unwound.length) {
        const yardVoltage = new Map(doc.substations.map(s => [s.id, s.voltage]))
        const equipments = doc.equipments.map(e => {
            if (!unwound.includes(e)) return e
            const windings: Record<string, TransformerWindingRecord> = {}
            e.terminals.forEach((t, i) => {
                const side = SIDES[String(t.label ?? '').toUpperCase()] ?? (i === 0 ? TransformerWindingSide.PRIMARY : i === 1 ? TransformerWindingSide.SECONDARY : TransformerWindingSide.AUXILIARY)
                windings[t.key] = {windingSide: side, wiring: TransformerWindingWiring.STAR, tapChanger: side === TransformerWindingSide.PRIMARY ? TransformerWindingTapChanger.ONLOAD : TransformerWindingTapChanger.NONE, voltage: t.voltage ?? defaultWindingVoltage(side, yardVoltage.get(e.substationId)), ratings: []}
            })
            changes.push(`equipment ${e.id}: windings derived from its ${e.terminals.length} terminal${e.terminals.length === 1 ? '' : 's'}`)
            return {...e, windings, terminals: terminalsFromWindings(windings, e.terminals)}
        })
        doc = {...doc, equipments}
    }
    // v5 → the equipment purpose flag "takeOff" is "lineSide" (the line side of the bay, i.e. its take-off column).
    const flagged = (doc.equipments ?? []).filter(e => 'takeOff' in (e as object)).length
    if (flagged) {
        doc = {
            ...doc, equipments: doc.equipments.map(e => {
                if (!('takeOff' in (e as object))) return e
                const {takeOff, ...rest} = e as typeof e & { takeOff?: boolean }
                return takeOff ? {...rest, lineSide: true} : rest
            }),
        }
        changes.push(`${flagged} equipment flag${flagged === 1 ? '' : 's'} renamed from "takeOff" to "lineSide"`)
    }
    // v4 → equipment and take-off vertical positions are `row` (formerly `slot`), the same axis as bus rows.
    const hasSlot = (r: object) => 'slot' in r && !('row' in r)
    const slotted = [...(doc.equipments ?? []), ...(doc.takeOffs ?? [])].filter(hasSlot).length
    if (slotted) {
        const move = <T extends object>(r: T): T => {
            if (!hasSlot(r)) return r
            const {slot, ...rest} = r as T & { slot?: number }
            return {...rest, row: slot} as T
        }
        doc = {...doc, equipments: doc.equipments.map(move), takeOffs: doc.takeOffs.map(move)}
        changes.push(`${slotted} equipment / take-off position${slotted === 1 ? '' : 's'} renamed from "slot" to "row"`)
    }
    // v3 → transformer winding sides are PRIMARY / SECONDARY (terminal labels copied from a template carried the old names).
    const SIDE_RENAME: Record<string, string> = {HIGH_SIDE: 'PRIMARY', LOW_SIDE: 'SECONDARY', 'High side': 'Primary', 'Low side': 'Secondary'}
    if (Array.isArray(doc.equipments) && doc.equipments.some(e => e.terminals?.some(t => t.label !== undefined && SIDE_RENAME[t.label] !== undefined))) {
        const equipments = doc.equipments.map(e => {
            if (!e.terminals?.some(t => t.label !== undefined && SIDE_RENAME[t.label] !== undefined)) return e
            changes.push(`equipment ${e.id}: winding side labels renamed`)
            return {...e, terminals: e.terminals.map(t => t.label !== undefined && SIDE_RENAME[t.label] !== undefined ? {...t, label: SIDE_RENAME[t.label]} : t)}
        })
        doc = {...doc, equipments}
    }
    // v0 → circuits carried their waypoints (`path`); they move into a path record. A circuit without either is fine: paths are optional.
    type LegacyCircuit = NetworkDocument['circuits'][number] & { path?: CoordinatesProps[] }
    if (Array.isArray(doc.circuits) && (doc.circuits as LegacyCircuit[]).some(c => c.path !== undefined)) {
        const paths = [...doc.paths]
        const circuits = (doc.circuits as LegacyCircuit[]).map(c => {
            const {path: legacy, ...rest} = c
            if (legacy === undefined) return c
            if (rest.pathId && paths.some(p => p.id === rest.pathId)) return rest
            const probe = {...doc, paths}
            const record: TransmissionPathRecord = {id: uniqueId(probe, `${c.name || c.id}_PATH`), name: `${c.name || c.id} path`, waypoints: Array.isArray(legacy) ? legacy : []}
            paths.push(record)
            changes.push(`circuit ${c.id}: created path "${record.name}" (${record.waypoints.length} waypoints)`)
            return {...rest, pathId: record.id}
        })
        doc = {...doc, paths, circuits}
    }

    // v1 → paths know where they start and end; derive from the first circuit that is connected there.
    if (Array.isArray(doc.paths) && doc.paths.some(p => !p.from || !p.to)) {
        const endOf = (circuitId: string, end: string) =>
            pathEndOf(doc, doc.connections.find(c => c.scope === ConnectionScope.TRANSMISSION && c.nodes.some(n => n.kind === NetworkNodeKind.TRANSMISSION_CIRCUIT && n.id === circuitId && n.terminal === end))?.junction)
        let touched = false
        const paths = doc.paths.map(p => {
            if (p.from && p.to) return p
            const circuits = doc.circuits.filter(c => c.pathId === p.id)
            let from = p.from, to = p.to
            for (const c of circuits) {
                if (!from) from = endOf(c.id, CIRCUIT_END_FROM)
                if (!to) to = endOf(c.id, CIRCUIT_END_TO)
            }
            if (from === p.from && to === p.to) return p
            touched = true
            changes.push(`path ${p.id}: ends derived from its circuits`)
            return {...p, from, to}
        })
        if (touched) doc = {...doc, paths}
    }

    // v2 → path ends name sites (SUBSTATION_GROUP), not yards: a route is not specific to a voltage, so circuits of any yard of the site may share it.
    if (Array.isArray(doc.paths) && doc.paths.some(p => p.from?.kind === ConnectionJunctionKind.SUBSTATION || p.to?.kind === ConnectionJunctionKind.SUBSTATION)) {
        let touched = false
        const paths = doc.paths.map(p => {
            const lift = (r: ConnectionJunctionRef | undefined) => r?.kind === ConnectionJunctionKind.SUBSTATION ? (pathEndOf(doc, r) ?? r) : r
            const from = lift(p.from), to = lift(p.to)
            if (from === p.from && to === p.to) return p
            touched = true
            changes.push(`path ${p.id}: ends lifted from yard to site (${[from, to].filter(r => r && r.kind === ConnectionJunctionKind.SUBSTATION_GROUP).map(r => r!.id).join(', ')})`)
            return {...p, from, to}
        })
        if (touched) doc = {...doc, paths}
    }

    // v3 → a current transformer is in series and has two terminals (A, B); older documents gave it a single "T".
    if (Array.isArray(doc.equipments) && doc.equipments.some(e => e.equipmentType === SubstationEquipmentType.CURRENT_TRANSFORMER && e.terminals.length === 1)) {
        const renamed = new Map<string, string>()   // equipment id → old terminal key, now "A"
        const equipments = doc.equipments.map(e => {
            if (e.equipmentType !== SubstationEquipmentType.CURRENT_TRANSFORMER || e.terminals.length !== 1) return e
            const [only] = e.terminals
            renamed.set(e.id, only.key)
            changes.push(`equipment ${e.id}: current transformer terminal "${only.key}" became A, B added`)
            return {...e, terminals: [{...only, key: 'A'}, {key: 'B', label: only.label, voltage: only.voltage, current: only.current}]}
        })
        const connections = doc.connections.map(c => c.nodes.some(n => n.kind === NetworkNodeKind.EQUIPMENT_TERMINAL && renamed.has(n.id) && n.terminal === renamed.get(n.id))
            ? {...c, nodes: c.nodes.map(n => n.kind === NetworkNodeKind.EQUIPMENT_TERMINAL && renamed.has(n.id) && n.terminal === renamed.get(n.id) ? {...n, terminal: 'A'} : n)}
            : c)
        doc = {...doc, equipments, connections}
    }

    // v1 → a line lists its circuit sections (`circuitIds`); circuits no longer point at one line with `lineId`.
    if (Array.isArray(doc.lines) && Array.isArray(doc.circuits) && (doc.lines.some(l => !Array.isArray(l.circuitIds)) || doc.circuits.some(c => c.lineId !== undefined))) {
        const lines = doc.lines.map(l => ({...l, circuitIds: Array.isArray(l.circuitIds) ? [...l.circuitIds] : []}))
        const circuits = doc.circuits.map(c => {
            if (c.lineId === undefined) return c
            const {lineId, ...rest} = c
            const line = lines.find(l => l.id === lineId)
            if (line && !line.circuitIds.includes(c.id)) {
                line.circuitIds.push(c.id)
                changes.push(`circuit ${c.id}: moved into line ${line.id}`)
            } else if (!line) changes.push(`circuit ${c.id}: dropped reference to unknown line ${lineId}`)
            return rest
        })
        // Ends of a line: the yards its first / last section is connected at, when not stated.
        for (const l of lines) {
            if (l.from && l.to) continue
            const yardAt = (circuitId: string | undefined, end: string) => {
                const conn = circuitId ? circuitEndConnection({...doc, circuits}, circuitId, end) : undefined
                return conn?.junction.kind === ConnectionJunctionKind.SUBSTATION ? conn.junction : undefined
            }
            const anyYard = (circuitId: string | undefined) => yardAt(circuitId, CIRCUIT_END_FROM) ?? yardAt(circuitId, CIRCUIT_END_TO)
            const first = l.circuitIds[0], last = l.circuitIds[l.circuitIds.length - 1]
            // one section: its own FROM / TO yards; several: the yard each outer section reaches
            const from = l.from ?? (l.circuitIds.length === 1 ? yardAt(first, CIRCUIT_END_FROM) : anyYard(first))
            const to = l.to ?? (l.circuitIds.length === 1 ? yardAt(first, CIRCUIT_END_TO) : anyYard(last))
            if (from !== l.from || to !== l.to) {
                l.from = from
                l.to = to
                changes.push(`line ${l.id}: ends derived from its sections`)
            }
        }
        doc = {...doc, lines, circuits}
    }

    // v1 → circuits keep no reference to the circuit template they were created from (its values were copied).
    type TemplatedCircuit = NetworkDocument['circuits'][number] & { template?: unknown }
    if (Array.isArray(doc.circuits) && (doc.circuits as TemplatedCircuit[]).some(c => c.template !== undefined)) {
        const circuits = (doc.circuits as TemplatedCircuit[]).map(c => {
            if (c.template === undefined) return c
            const {template, ...rest} = c
            void template
            changes.push(`circuit ${c.id}: dropped the template reference`)
            return rest
        })
        doc = {...doc, circuits}
    }

    // v1 → every circuit has conductor values; unknown ones get the GENERIC conductor (size 0, SQMM).
    if (Array.isArray(doc.circuits) && doc.circuits.some(c => !c.conductor)) {
        const circuits = doc.circuits.map(c => {
            if (c.conductor) return c
            changes.push(`circuit ${c.id}: generic conductor added`)
            return {...c, conductor: genericConductor()}
        })
        doc = {...doc, circuits}
    }

    // v1 → circuits carry the voltage they are energized at; derive it from the first connected end whose voltage is known.
    if (Array.isArray(doc.circuits) && Array.isArray(doc.connections) && doc.circuits.some(c => !c.energizedVoltage)) {
        let touched = false
        const circuits = doc.circuits.map(c => {
            if (c.energizedVoltage) return c
            for (const end of [CIRCUIT_END_FROM, CIRCUIT_END_TO]) {
                const conn = circuitEndConnection(doc, c.id, end)
                const v = conn && connectionVoltage(doc, conn)
                if (!v) continue
                touched = true
                changes.push(`circuit ${c.id}: energized voltage ${v} taken from its ${end} connection`)
                return {...c, energizedVoltage: v}
            }
            return c
        })
        if (touched) doc = {...doc, circuits}
    }

    return {doc, changes}
}
