/**
 * Persisted records of a transmission network ("grid").
 *
 * One network is one JSON file (`NetworkDocument`) under `data/networks/<id>.json`.
 * The runtime classes in `src/models` form an object graph with back-references
 * (bay.substation <-> substation.bays, ...) which cannot be stored as JSON; these
 * records are the flat, id-referenced counterparts. Every id is unique within
 * the document. A loader (future) turns records into the `src/models` classes.
 *
 * Editing happens through `NetworkOp`s (see `ops.ts`) that are journaled by the
 * backend until the user saves a new version of the document.
 */
import {CoordinatesProps} from "../models/coordinates";
import {TransmissionVoltage} from "../models/transmission.voltage";
import {TransmissionConductor} from "../models/transmission.conductor";
import {GenerationType} from "../models/generation";
import {SubstationArrangement} from "../models/substation";
import {SubstationBusType} from "../models/substation.bus";
import {SubstationEquipmentType} from "../models/substation.equipment";
import {TemplateKind, TemplateRef} from "../templates/template";
import type {TransformerWindingTemplate} from "../templates/power.transformer";
import {TransformerWindingSide, TransformerWindingTapChanger, TransformerWindingWiring} from "../models/transformer";

/* ---------- common ---------- */

export interface NetworkRecordBase {
    /** Unique within the document. See `NETWORK_ID_PATTERN`. */
    id: string
    name?: string
    /** Planned, not built yet: drawn in grey. Using a planned record from one that is not planned is a validation warning. */
    planned?: boolean
    coords?: CoordinatesProps
}

export const NETWORK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/

/* ---------- substation side ---------- */

/** A substation site: the thing drawn on the map. Owns one or more yards (`SubstationRecord`). */
export interface SubstationGroupRecord extends NetworkRecordBase {
    /** Short code, e.g. "CNO". Used to derive ids of children (see `SubstationGroup`). */
    groupName: string
    coords: CoordinatesProps
    /** The site is a power plant / power producer: drawn with a "G" badge on the map. */
    generation?: boolean
    /** Kinds of generation at the site, one small badge each; meaningful when `generation` is set. */
    generationTypes?: GenerationType[]
    /**
     * The site is an extension of another one (its id), e.g. a plant switchyard `BPK_T` next to `BPK`: zoomed out the
     * map draws it with its parent (one marker, the parent's label listing its extensions, paths between them left out).
     * One level: the parent is not an extension itself.
     */
    extensionOf?: string
}

/**
 * A generating unit of a generation site (see `GenerationUnit`): a block of a power plant, a section of a solar or
 * wind farm, a battery system. The site should be flagged `generation` and list the unit's type among its
 * `generationTypes` (warnings otherwise).
 */
export interface GenerationUnitRecord extends NetworkRecordBase {
    /** The site the unit belongs to. */
    groupId: string
    /** Commonly the block name, e.g. "Block 1", "GT11", "Unit 3". */
    name: string
    generationType: GenerationType
    /** Installed (nameplate) capacity in MW; unset while unknown. */
    capacityMw?: number
}

/** A voltage yard of a site, e.g. "230KV". Owns buses, bays, equipment and take-offs. */
export interface SubstationRecord extends NetworkRecordBase {
    groupId: string
    yardName: string
    voltage: TransmissionVoltage
    arrangement?: SubstationArrangement
}

export interface SubstationBusRecord extends NetworkRecordBase {
    substationId: string
    busType: SubstationBusType
    busNumber?: string
    /** Bay number of the bus (EGAT numbers buses like bays, e.g. 8001). */
    bayNumber?: string
    /** Vertical position in the single-line diagram (the same axis as equipment and take-off `row`). */
    row: number
    voltage?: TransmissionVoltage
    current?: number
}

export interface SubstationBayRecord extends NetworkRecordBase {
    substationId: string
    bayNumber: string
    /** Horizontal position in the single-line diagram. */
    column: number
    voltage?: TransmissionVoltage
    current?: number
}

/**
 * A connectable point on a piece of equipment. Mirrors the
 * `SubstationEquipmentCircuit` fields of the runtime classes:
 *  - two-terminal devices (breaker, disconnecting switch, fuse, reactor): keys "A" and "B"
 *  - one-terminal devices (CT, PT, ground switch, surge arrester): key "T"
 *  - transformers: one terminal per winding, keyed by the winding code ("H", "X", "Y")
 */
export interface EquipmentTerminalRecord {
    key: string
    label?: string
    voltage?: TransmissionVoltage
    current?: number
}

export interface SubstationEquipmentRecord extends NetworkRecordBase {
    substationId: string
    bayId: string
    /** Equipment code within the substation, e.g. "8021-1". */
    code: string
    equipmentType: SubstationEquipmentType
    brand?: string
    model?: string
    /** Template the equipment was instantiated from (power transformers today). */
    template?: TemplateRef<TemplateKind.POWER_TRANSFORMER>
    /**
     * Power / service transformers: the windings, keyed by winding code (H, X, Y), with side, wiring, tap changer, voltage and
     * ratings per cooling mode. The terminals of a transformer are derived from them (`terminalsFromWindings`): one per winding.
     */
    windings?: Record<string, TransformerWindingRecord>
    terminals: EquipmentTerminalRecord[]
    /** Vertical position in the single-line diagram (0 = bottom), in the bay column or, with `takeOffId`, in the take-off column. */
    row: number
    /** Drawn in the take-off column of this take-off's bay (right of the main bay column) instead of in the bay column; same yard. */
    takeOffId?: string
    /** The equipment is on the line side of its bay, i.e. the take-off column (tag from a bay template; drawn with a ↑ mark). Power transformers connect to line-side equipment. */
    lineSide?: boolean
    /** The equipment ties buses: a bus-tie / transfer-bus switch (drawn with a ⇔ mark). */
    busTie?: boolean
    /** Type-specific attributes (interruptCapacity, cores, surgeVoltage, var, fuseCurrent, withGroundSwitch, ...). */
    attributes?: Record<string, unknown>
}

/**
 * The point where a line leaves a yard. Every transmission connection at a
 * substation starts from a take-off; inside the yard the take-off is wired to
 * equipment terminals / buses like any other node.
 */
export interface SubstationTakeOffRecord extends NetworkRecordBase {
    substationId: string
    /** Bay the take-off belongs to. Optional so a take-off can be created from the map before the yard is detailed. */
    bayId?: string
    lineName: string
    /** Vertical position within the bay in the single-line diagram. */
    row?: number
    /** Drawn in the bay's take-off column (right of the main bay column); unset take-offs sit in the bay column and get a warning. */
    takeOffColumn?: boolean
    /**
     * Voltage of the line leaving here when it is not the yard's, e.g. the secondary or auxiliary side of a transformer in the
     * yard. Unset, the yard voltage applies (colour, the voltage a circuit is energized at when attached, the line name prefix).
     */
    voltage?: TransmissionVoltage
}

/* ---------- transmission side ---------- */

export interface TransmissionJunctionRecord extends NetworkRecordBase {
    /** Set on a *site junction*: the substation site this junction belongs to (at most one per site). It is named after the site by default and moves with it. */
    groupId?: string
    coords: CoordinatesProps
}

/** Physical route shared by one or more circuits (e.g. a tower line carrying two parallel circuits). */
export interface TransmissionPathRecord extends NetworkRecordBase {
    name: string
    /** Where the route starts: a site (SUBSTATION_GROUP) or a line junction. Circuits on the path attach there (through a take-off at a yard of the site). */
    from?: ConnectionJunctionRef
    /** Where the route ends. */
    to?: ConnectionJunctionRef
    /** Intermediate waypoints between the ends, ordered FROM → TO. */
    waypoints: CoordinatesProps[]
}

export interface TransmissionCircuitRecord extends NetworkRecordBase {
    name: string
    /**
     * The route of the circuit; several circuits may share one path. Optional:
     * paths and circuits are added independently, and a circuit without a path
     * is drawn as a dashed straight line between its attached ends.
     */
    pathId?: string
    /** Rated (design) voltage, copied from a circuit template when one is applied (no reference to the template is kept: the record is self-describing). */
    voltage?: TransmissionVoltage
    /**
     * Voltage the circuit is operated at. Set to the voltage of the connection
     * (the node at a junction, the yard at a substation) whenever an end is
     * attached; it may be edited afterwards, and the UI warns when it differs
     * from the connections. The map draws the circuit in this colour, with a
     * dotted overlay in the rated colour when the two differ.
     */
    energizedVoltage?: TransmissionVoltage
    bundle?: number
    /**
     * Tower position, a hint for drawing parallel circuits (and tower illustrations): the line group (`lineGroup`, one
     * tower line; several run side by side, 1 on the left) and the circuit's number on it (`groupCircuit`: 1 / 2 hang on
     * the top pair of arms, left / right looking from the path's FROM end, 3 / 4 on the pair below, …). Unset: assigned
     * at draw time, two circuits per new tower (see `towerLayout.ts`).
     */
    lineGroup?: number
    groupCircuit?: number
    /** Conductor values (size, unit, type, code), copied from a TRANSMISSION_CONDUCTOR template when the circuit is created from a template; editable afterwards. */
    conductor?: TransmissionConductor
    /** @deprecated Older documents: id of the conductor template; superseded by the copied `conductor` values. */
    conductorTemplateId?: string
    current?: number
    lengthKm?: number
    /** @deprecated Older documents: single line of the circuit. Migrated into `TransmissionLineRecord.circuitIds` on load. */
    lineId?: string
}

/**
 * A named line: circuit sections joined end to end through TRANSMISSION
 * connections (junction nodes), running from one substation yard to another.
 * A circuit may belong to several lines: two lines that leave the same yard
 * and part at a tee share the section up to the tee.
 */
export interface TransmissionLineRecord extends NetworkRecordBase {
    name: string
    voltage?: TransmissionVoltage
    /** Where the line starts: a yard (SUBSTATION), or a junction (TRANSMISSION_JUNCTION: a site's own junction or a line junction, where the line stays open or ties in). */
    from?: ConnectionJunctionRef
    /** Where the line ends, as `from`. */
    to?: ConnectionJunctionRef
    /** Circuit sections, ordered FROM → TO. */
    circuitIds: string[]
}

/* ---------- connectivity ---------- */

export enum NetworkNodeKind {
    SUBSTATION_BUS = 'SUBSTATION_BUS',
    EQUIPMENT_TERMINAL = 'EQUIPMENT_TERMINAL',
    SUBSTATION_TAKE_OFF = 'SUBSTATION_TAKE_OFF',
    TRANSMISSION_CIRCUIT = 'TRANSMISSION_CIRCUIT',
}

export const CIRCUIT_END_FROM = 'FROM'
export const CIRCUIT_END_TO = 'TO'
export type CircuitEnd = typeof CIRCUIT_END_FROM | typeof CIRCUIT_END_TO

/**
 * Pointer to a connectable node.
 *  - EQUIPMENT_TERMINAL: `id` is the equipment id, `terminal` the terminal key.
 *  - TRANSMISSION_CIRCUIT: `id` is the circuit id, `terminal` is "FROM" or "TO".
 *  - SUBSTATION_BUS / SUBSTATION_TAKE_OFF: `id` only.
 */
export interface NetworkNodeRef {
    kind: NetworkNodeKind
    id: string
    terminal?: string
}

export enum ConnectionScope {
    /** Joins nodes inside one yard (bus <-> equipment terminals <-> take-off). */
    SUBSTATION = 'SUBSTATION',
    /** Joins circuit ends with a take-off (at a substation) or with each other (at a junction). Mirrors `TransmissionConnection`. */
    TRANSMISSION = 'TRANSMISSION',
}

export enum ConnectionJunctionKind {
    SUBSTATION = 'SUBSTATION',
    TRANSMISSION_JUNCTION = 'TRANSMISSION_JUNCTION',
    /** A substation site (group): where a transmission path starts or ends; a route is not specific to a voltage. */
    SUBSTATION_GROUP = 'SUBSTATION_GROUP',
}

export interface ConnectionJunctionRef {
    kind: ConnectionJunctionKind
    /** Substation (yard) id, site (group) id or junction id, by kind. Connections and lines sit at yards; path ends name sites. */
    id: string
}

/**
 * An electrical node joining two or more `NetworkNodeRef`s.
 *  - SUBSTATION scope: `junction` is the yard; nodes are buses, equipment terminals and take-offs of that yard.
 *  - TRANSMISSION scope at a substation: `junction` is the yard; nodes are exactly one take-off and one or more circuit ends.
 *  - TRANSMISSION scope at a junction: `junction` is the junction; nodes are circuit ends only.
 */
export interface ConnectionRecord extends NetworkRecordBase {
    scope: ConnectionScope
    junction: ConnectionJunctionRef
    nodes: NetworkNodeRef[]
    /**
     * Nominal voltage of the node. TRANSMISSION scope: set from the first circuit at creation, informational only (it does not
     * restrict the voltage of the connected circuits). SUBSTATION scope: the voltage of the in-yard wiring node when it is not
     * the yard's (colours the wire; unset, the yard voltage applies and a bus, take-off or neighbouring node at another voltage
     * gets a warning).
     */
    voltage?: TransmissionVoltage
    /** Current limit of the wiring node in A (SUBSTATION scope; optional, informational). */
    current?: number
}

/**
 * A yard link: an electrical connection between two yards (usually the two
 * sides of a transformer, or any tie between the yards of a site). It joins
 * nodes of yard A and nodes of yard B; each node belongs to one of the two.
 * Each yard's diagram draws its own nodes wired to a port that stands for
 * the other yard, at the top when that yard's voltage is higher, else at the
 * bottom.
 */
export interface SubstationYardConnectionRecord extends NetworkRecordBase {
    name: string
    yardAId: string
    yardBId: string
    /** Buses, equipment terminals and take-offs of either yard joined by the link. */
    nodes: NetworkNodeRef[]
    /** Nominal voltage of the link (informational; the diagram colours it by its nodes, else by the lower of the two yards). */
    voltage?: TransmissionVoltage
}

/* ---------- document ---------- */

export const NETWORK_DOCUMENT_FORMAT = 'thgrid.network'
export const NETWORK_DOCUMENT_VERSION = 1

export interface NetworkCollections {
    substationGroups: SubstationGroupRecord[]
    generationUnits: GenerationUnitRecord[]
    substations: SubstationRecord[]
    buses: SubstationBusRecord[]
    bays: SubstationBayRecord[]
    equipments: SubstationEquipmentRecord[]
    takeOffs: SubstationTakeOffRecord[]
    junctions: TransmissionJunctionRecord[]
    paths: TransmissionPathRecord[]
    circuits: TransmissionCircuitRecord[]
    lines: TransmissionLineRecord[]
    connections: ConnectionRecord[]
    yardConnections: SubstationYardConnectionRecord[]
}

export type NetworkCollectionName = keyof NetworkCollections
export type NetworkRecordOf<C extends NetworkCollectionName> = NetworkCollections[C][number]
export type AnyNetworkRecord = NetworkRecordOf<NetworkCollectionName>

export const networkCollectionNames: NetworkCollectionName[] = [
    'substationGroups', 'generationUnits', 'substations', 'buses', 'bays', 'equipments', 'takeOffs',
    'junctions', 'paths', 'circuits', 'lines', 'connections', 'yardConnections',
]

export interface NetworkDocumentMeta {
    format: typeof NETWORK_DOCUMENT_FORMAT
    version: typeof NETWORK_DOCUMENT_VERSION
    /** File name (without .json). See `TEMPLATE_ID_PATTERN` in templates. */
    id: string
    name: string
    description?: string
    /** Incremented on every save. */
    revision: number
    createdAt: string
    updatedAt: string
}

/** The whole grid: one JSON file. */
export interface NetworkDocument extends NetworkDocumentMeta, NetworkCollections {
}

export interface NetworkSummary {
    id: string
    name: string
    description?: string
    revision: number
    updatedAt: string
    counts: Record<NetworkCollectionName, number>
    /** Number of unsaved journal entries (0 when clean). */
    journalEntries: number
}

export function emptyNetworkCollections(): NetworkCollections {
    return {
        substationGroups: [], generationUnits: [], substations: [], buses: [], bays: [], equipments: [],
        takeOffs: [], junctions: [], paths: [], circuits: [], lines: [], connections: [], yardConnections: [],
    }
}

export function newNetworkDocument(id: string, name: string, now = new Date().toISOString()): NetworkDocument {
    return {
        format: NETWORK_DOCUMENT_FORMAT,
        version: NETWORK_DOCUMENT_VERSION,
        id,
        name,
        revision: 0,
        createdAt: now,
        updatedAt: now,
        ...emptyNetworkCollections(),
    }
}

export function toNetworkSummary(doc: NetworkDocument, journalEntries = 0): NetworkSummary {
    const counts = {} as Record<NetworkCollectionName, number>
    for (const c of networkCollectionNames) counts[c] = doc[c]?.length ?? 0
    return {id: doc.id, name: doc.name, description: doc.description, revision: doc.revision, updatedAt: doc.updatedAt, counts, journalEntries}
}

/** A winding of a transformer record: the same shape as a template winding. */
export type TransformerWindingRecord = TransformerWindingTemplate

/** Voltages a secondary defaults to, by the yard (primary) voltage. */
const SECONDARY_FOR: Partial<Record<string, TransmissionVoltage>> = {
    [TransmissionVoltage.AC500KV]: TransmissionVoltage.AC230KV,
    [TransmissionVoltage.AC230KV]: TransmissionVoltage.AC115KV,
    [TransmissionVoltage.AC115KV]: TransmissionVoltage.AC22KV,
}

/** Voltage a winding defaults to: the primary at the yard voltage, the secondary one level down, an auxiliary at 22 kV. */
export function defaultWindingVoltage(side: TransformerWindingSide, primaryVoltage?: TransmissionVoltage): TransmissionVoltage {
    const primary = primaryVoltage ?? TransmissionVoltage.AC230KV
    if (side === TransformerWindingSide.PRIMARY) return primary
    if (side === TransformerWindingSide.SECONDARY) return SECONDARY_FOR[primary] ?? TransmissionVoltage.AC115KV
    return TransmissionVoltage.AC22KV
}

/** Windings a new transformer starts with: H (PRIMARY, star, on-load tap changer) at the yard voltage and X (SECONDARY) one level down. */
export function defaultTransformerWindings(primaryVoltage?: TransmissionVoltage): Record<string, TransformerWindingRecord> {
    const {PRIMARY, SECONDARY} = TransformerWindingSide
    return {
        H: {windingSide: PRIMARY, wiring: TransformerWindingWiring.STAR, tapChanger: TransformerWindingTapChanger.ONLOAD, voltage: defaultWindingVoltage(PRIMARY, primaryVoltage), ratings: []},
        X: {windingSide: SECONDARY, wiring: TransformerWindingWiring.STAR, tapChanger: TransformerWindingTapChanger.NONE, voltage: defaultWindingVoltage(SECONDARY, primaryVoltage), ratings: []},
    }
}

/** The terminals of a transformer: one per winding, keyed by the winding code, labelled with the side, at the winding voltage. */
export function terminalsFromWindings(windings: Record<string, TransformerWindingRecord>, previous: EquipmentTerminalRecord[] = []): EquipmentTerminalRecord[] {
    return Object.entries(windings).map(([key, w]) => ({...previous.find(t => t.key === key), key, label: w.windingSide, voltage: w.voltage}))
}

/* ---------- terminal defaults ---------- */

const TWO_TERMINAL: SubstationEquipmentType[] = [
    SubstationEquipmentType.CIRCUIT_BREAKER, SubstationEquipmentType.MTS_BREAKER, SubstationEquipmentType.DISCONNECTING_SWITCH,
    SubstationEquipmentType.POWER_FUSE, SubstationEquipmentType.SHUNT_REACTOR, SubstationEquipmentType.CURRENT_TRANSFORMER,
]
const TRANSFORMER_TYPES: SubstationEquipmentType[] = [
    SubstationEquipmentType.POWER_TRANSFORMER, SubstationEquipmentType.SERVICE_TRANSFORMER,
]

/** Terminal layout of an equipment type, mirroring the runtime classes. */
export function defaultTerminals(type: SubstationEquipmentType): EquipmentTerminalRecord[] {
    if (TWO_TERMINAL.includes(type)) return [{key: 'A'}, {key: 'B'}]
    if (TRANSFORMER_TYPES.includes(type)) return [{key: 'H', label: 'Primary'}, {key: 'X', label: 'Secondary'}]
    return [{key: 'T'}]
}

export function isTransformerType(type: SubstationEquipmentType): boolean {
    return TRANSFORMER_TYPES.includes(type)
}

/** Stable string key of a node reference, for maps and equality. */
export function nodeKey(n: NetworkNodeRef): string {
    return n.terminal ? `${n.kind}:${n.id}:${n.terminal}` : `${n.kind}:${n.id}`
}

export function sameNode(a: NetworkNodeRef, b: NetworkNodeRef): boolean {
    return nodeKey(a) === nodeKey(b)
}
