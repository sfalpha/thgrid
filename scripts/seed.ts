/**
 * Seeds `data/` with the EGAT standard templates (conductors, circuits, power
 * transformers) and an "EGAT standard" collection that groups them.
 *
 * Usage: npm run seed            (skips templates that already exist)
 *        npm run seed -- --force (overwrites existing templates)
 *
 * The data set mirrors the TypeScript constants that used to live under
 * `src/templates/{conductor,circuit,powertransformer}/egat.*.ts`.
 */
import path from "node:path";
import {loadConfig, dataLayout} from "../src/server/config";
import {TemplateStore} from "../src/server/storage/template.store";
import {CollectionStore} from "../src/server/storage/collection.store";
import {slugifyTemplateId, TemplateKind, TemplateRecord} from "../src/templates/template";
import {TransmissionConductorTemplate} from "../src/templates/transmission.conductor";
import {TransmissionCircuitTemplateData} from "../src/templates/transmission.circuit";
import {PowerTransformerTemplate, TransformerWindingTemplate} from "../src/templates/power.transformer";
import {TransmissionWireType, TransmissionWireUnit} from "../src/models/transmission.conductor";
import {TransmissionVoltage} from "../src/models/transmission.voltage";
import {
    TransformerCooling,
    TransformerWindingSide,
    TransformerWindingTapChanger,
    TransformerWindingWiring,
} from "../src/models/transformer";
import {getTemplateKindDefinition} from "../src/templates/registry";
import {TemplateCollection} from "../src/templates/collection";
import {NetworkStore} from "../src/server/storage/network.store";
import {
    CIRCUIT_END_FROM,
    CIRCUIT_END_TO,
    ConnectionJunctionKind,
    ConnectionScope,
    NetworkNodeKind,
    newNetworkDocument,
} from "../src/network/records";
import {validateNetworkDocument} from "../src/network/validation";
import {SubstationArrangement} from "../src/models/substation";
import {SubstationBusType} from "../src/models/substation.bus";
import {BayTemplateType} from "../src/models/substation.bay";
import {SubstationEquipmentType} from "../src/models/substation.equipment";
import {SubstationYardTemplate} from "../src/templates/substation.yard";
import {SubstationBayTemplate} from "../src/templates/substation.bay";

const force = process.argv.includes('--force')
const now = new Date().toISOString()
const TAGS = ['EGAT']

/* ---------- conductors ---------- */

const conductors: TransmissionConductorTemplate[] = []
for (const size of [1272, 795, 477]) {
    for (const [type, suffix] of [[TransmissionWireType.ACSR_GA, 'GA'], [TransmissionWireType.ACSR_AW, 'AW']] as const) {
        conductors.push({name: `TC_${size}MCM_ACSR_${suffix}`, size, unit: TransmissionWireUnit.MCM, type})
    }
}
// All-aluminium 477 MCM, used on 115 kV lines.
conductors.push({name: 'TC_477MCM_AAC', size: 477, unit: TransmissionWireUnit.MCM, type: TransmissionWireType.AAC})
// High-temperature low-sag conductors (Invar core and ACCC composite core), 795 and 1272 MCM, for uprated 115 / 230 kV lines.
const HTLS: [TransmissionWireType, string][] = [[TransmissionWireType.HTLS_INVAR, 'HTLS_INVAR'], [TransmissionWireType.HTLS_ACCC, 'HTLS_ACCC']]
for (const size of [795, 1272]) for (const [type, suffix] of HTLS) conductors.push({name: `TC_${size}MCM_${suffix}`, size, unit: TransmissionWireUnit.MCM, type})

/* ---------- circuits ---------- */

const circuits: TransmissionCircuitTemplateData[] = []
const circuitSpecs: [TransmissionVoltage, string, number[], number, string[]][] = [
    [TransmissionVoltage.AC500KV, '500KV', [4], 1272, ['GA']],
    [TransmissionVoltage.AC230KV, '230KV', [1, 2, 4], 1272, ['GA', 'AW']],
    [TransmissionVoltage.AC115KV, '115KV', [1, 2, 4], 1272, ['GA', 'AW']],
    [TransmissionVoltage.AC115KV, '115KV', [1, 2], 795, ['GA', 'AW']],
    [TransmissionVoltage.AC115KV, '115KV', [1], 477, ['GA', 'AW']],
]
for (const [voltage, vLabel, bundles, size, suffixes] of circuitSpecs) {
    for (const bundle of bundles) {
        for (const suffix of suffixes) {
            circuits.push({
                name: `TCT_${vLabel}_${bundle}x${size}MCM_ACSR_${suffix}`,
                voltage,
                bundle,
                conductorId: slugifyTemplateId(`TC_${size}MCM_ACSR_${suffix}`),
            })
        }
    }
}
circuits.push({name: 'TCT_115KV_1x477MCM_AAC', voltage: TransmissionVoltage.AC115KV, bundle: 1, conductorId: slugifyTemplateId('TC_477MCM_AAC')})
// HTLS circuits: 115 and 230 kV, single / double / quad bundle, both sizes and both core types.
for (const [voltage, vLabel] of [[TransmissionVoltage.AC115KV, '115KV'], [TransmissionVoltage.AC230KV, '230KV']] as const) {
    for (const size of [795, 1272]) for (const bundle of [1, 2, 4]) for (const [, suffix] of HTLS) {
        circuits.push({name: `TCT_${vLabel}_${bundle}x${size}MCM_${suffix}`, voltage, bundle, conductorId: slugifyTemplateId(`TC_${size}MCM_${suffix}`)})
    }
}

/* ---------- order: smaller conductors first (the collection and the pickers follow this order) ---------- */

const TYPE_ORDER = [TransmissionWireType.ACSR_GA, TransmissionWireType.ACSR_AW, TransmissionWireType.AAC, TransmissionWireType.HTLS_INVAR, TransmissionWireType.HTLS_ACCC]
const kv = (v: TransmissionVoltage) => Number(String(v).replace(/\D/g, '')) || 0
conductors.sort((a, b) => a.size - b.size || TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type))
const conductorOf = (c: TransmissionCircuitTemplateData) => conductors.find(x => slugifyTemplateId(x.name) === c.conductorId)!
circuits.sort((a, b) => kv(a.voltage) - kv(b.voltage) || conductorOf(a).size - conductorOf(b).size || a.bundle - b.bundle || TYPE_ORDER.indexOf(conductorOf(a).type) - TYPE_ORDER.indexOf(conductorOf(b).type))

/* ---------- power transformers ---------- */

function winding(side: TransformerWindingSide, wiring: TransformerWindingWiring, voltage: TransmissionVoltage,
                 tapChanger: TransformerWindingTapChanger, ratings?: [TransformerCooling, number, boolean][]): TransformerWindingTemplate {
    return {
        windingSide: side,
        wiring,
        voltage,
        tapChanger,
        ratings: ratings?.map(([cooling, power, perModule]) => ({cooling, power, perModule})),
    }
}

const {PRIMARY, SECONDARY, AUXILIARY} = TransformerWindingSide
const {STAR, DELTA} = TransformerWindingWiring
const {ONLOAD, NONE} = TransformerWindingTapChanger
const {ONAN, ONAF, OA, FA} = TransformerCooling

const transformers: PowerTransformerTemplate[] = [
    {
        name: 'TR_230KV_115KV_A22KV_200MVA_ONAF',
        modules: 1,
        windings: {
            H: winding(PRIMARY, STAR, TransmissionVoltage.AC230KV, ONLOAD, [[ONAN, 120000, false], [ONAF, 160000, false], [ONAF, 200000, false]]),
            X: winding(SECONDARY, STAR, TransmissionVoltage.AC115KV, NONE, [[ONAN, 120000, false], [ONAF, 160000, false], [ONAF, 200000, false]]),
            Y: winding(AUXILIARY, DELTA, TransmissionVoltage.AC22KV, NONE, [[ONAN, 30000, false], [ONAF, 40000, false], [ONAF, 50000, false]]),
        },
    },
]
for (const aux of [TransmissionVoltage.AC22KV, TransmissionVoltage.AC24KV]) {
    const auxLabel = aux === TransmissionVoltage.AC22KV ? 'A22KV' : 'A24KV'
    transformers.push({
        name: `TR_500KV_230KV_${auxLabel}_3X333MVA_FA`,
        modules: 3,
        windings: {
            H: winding(PRIMARY, STAR, TransmissionVoltage.AC500KV, ONLOAD, [[OA, 200000, true], [FA, 800000 / 3, true], [FA, 1000000 / 3, true]]),
            X: winding(SECONDARY, STAR, TransmissionVoltage.AC230KV, NONE),
            Y: winding(AUXILIARY, DELTA, aux, NONE),
        },
    })
    transformers.push({
        name: `TR_500KV_230KV_${auxLabel}_3X200MVA_ONAF`,
        modules: 3,
        windings: {
            H: winding(PRIMARY, STAR, TransmissionVoltage.AC500KV, ONLOAD, [[ONAN, 120000, true], [ONAF, 160000, true], [ONAF, 200000, true]]),
            X: winding(SECONDARY, STAR, TransmissionVoltage.AC230KV, NONE),
            Y: winding(AUXILIARY, DELTA, aux, NONE),
        },
    })
}

/* ---------- substation yards and bays ---------- */

const {MAIN, TRANSFER} = SubstationBusType
const mainBus = (n: number, row: number) => ({name: `MAIN_BUS_${n}`, busType: MAIN, busNumber: String(n), row})
// Rows count from the bottom; bays stack upwards from the lowest bus (bay templates below start at sequence 1).
const yards: SubstationYardTemplate[] = [
    {name: 'YARD_SINGLE_BUS', arrangement: SubstationArrangement.SINGLE_BUS, buses: [mainBus(1, 0)]},
    {name: 'YARD_SINGLE_MAIN_AND_TRANSFER_BUS', arrangement: SubstationArrangement.SINGLE_MAIN_AND_TRANSFER_BUS, buses: [mainBus(1, 0), {name: 'TRANSFER_BUS', busType: TRANSFER, row: 9}]},
    {name: 'YARD_DOUBLE_BUS', arrangement: SubstationArrangement.DOUBLE_BUS, buses: [mainBus(1, 0), mainBus(2, 1)]},
    {name: 'YARD_DOUBLE_MAIN_AND_TRANSFER_BUS', arrangement: SubstationArrangement.DOUBLE_MAIN_AND_TRANSFER_BUS, buses: [mainBus(1, 0), mainBus(2, 1), {name: 'TRANSFER_BUS', busType: TRANSFER, row: 10}]},
    {name: 'YARD_BREAKER_AND_A_HALF', arrangement: SubstationArrangement.BREAKER_AND_A_HALF, buses: [mainBus(1, 0), mainBus(2, 12)]},
]
const {DISCONNECTING_SWITCH: DS, CIRCUIT_BREAKER: CB, CURRENT_TRANSFORMER: CT, POTENTIAL_TRANSFORMER: PT, GROUND_SWITCH: GS, POWER_TRANSFORMER: KT} = SubstationEquipmentType
const eq = (equipmentType: SubstationEquipmentType, sequence: number, flags: { lineSide?: boolean; busTie?: boolean } = {}) => ({equipmentType, sequence, ...flags})
const MAIN_TRANSFER = [SubstationArrangement.SINGLE_MAIN_AND_TRANSFER_BUS, SubstationArrangement.DOUBLE_MAIN_AND_TRANSFER_BUS]
const bays: SubstationBayTemplate[] = [
    // line bay of a main-and-transfer yard (EGAT 115 kV, e.g. BBG bay 01): bay column bus DS, breaker, line DS, transfer-bus DS (bus tie);
    // take-off column (take-off flag) above the transfer bus (row 9 in the yard templates): ground switch first, then CT and PT, the take-off at 13
    {name: 'BAY_LINE_MAIN_TRANSFER', bayTemplateType: BayTemplateType.TAKEOFF, arrangements: MAIN_TRANSFER, equipments: [eq(DS, 1), eq(CB, 2), eq(DS, 3), eq(DS, 4, {busTie: true}), eq(GS, 10, {lineSide: true}), eq(CT, 11, {lineSide: true}), eq(PT, 12, {lineSide: true})]},
    {name: 'BAY_BUS_TIE_MAIN_TRANSFER', bayTemplateType: BayTemplateType.BUS_TIE, arrangements: MAIN_TRANSFER, equipments: [eq(DS, 1), eq(CB, 2), eq(DS, 3, {busTie: true})]},
    {name: 'BAY_TRANSFORMER_HIGH_SIDE_MAIN_TRANSFER', bayTemplateType: BayTemplateType.HIGH_SIDE_TRANSFORMER, arrangements: MAIN_TRANSFER, equipments: [eq(DS, 1), eq(CB, 2), eq(CT, 3, {lineSide: true}), eq(KT, 5, {lineSide: true})]},
    // breaker-and-a-half diameter half: bus DS, breaker, DS to the line node; the line gear (ground switch first, CT, PT) in the take-off column beside it
    {name: 'BAY_LINE_BREAKER_AND_A_HALF', bayTemplateType: BayTemplateType.TAKEOFF, arrangements: [SubstationArrangement.BREAKER_AND_A_HALF], equipments: [eq(DS, 1), eq(CB, 2), eq(DS, 3), eq(GS, 4, {lineSide: true}), eq(CT, 5, {lineSide: true}), eq(PT, 6, {lineSide: true})]},
    {name: 'BAY_LINE_SINGLE_BUS', bayTemplateType: BayTemplateType.TAKEOFF, arrangements: [SubstationArrangement.SINGLE_BUS, SubstationArrangement.DOUBLE_BUS], equipments: [eq(DS, 1), eq(CB, 2), eq(DS, 3), eq(GS, 4, {lineSide: true}), eq(CT, 5, {lineSide: true}), eq(PT, 6, {lineSide: true})]},
]

/* ---------- write ---------- */

async function main() {
    const config = loadConfig()
    const templates = new TemplateStore(path.join(config.dataDir, dataLayout.templates))
    const collections = new CollectionStore(path.join(config.dataDir, dataLayout.collections))
    await Promise.all([templates.init(), collections.init()])

    const records: TemplateRecord[] = [
        ...conductors.map(data => ({kind: TemplateKind.TRANSMISSION_CONDUCTOR, data}) as const),
        ...circuits.map(data => ({kind: TemplateKind.TRANSMISSION_CIRCUIT, data}) as const),
        ...transformers.map(data => ({kind: TemplateKind.POWER_TRANSFORMER, data}) as const),
        ...yards.map(data => ({kind: TemplateKind.SUBSTATION_YARD, data}) as const),
        ...bays.map(data => ({kind: TemplateKind.SUBSTATION_BAY, data}) as const),
    ].map(({kind, data}) => ({
        id: slugifyTemplateId(data.name),
        kind,
        description: `EGAT standard ${getTemplateKindDefinition(kind).label.toLowerCase()}`,
        tags: TAGS,
        createdAt: now,
        updatedAt: now,
        data,
    }) as TemplateRecord)

    const snapshot = await templates.snapshot()
    let written = 0, skipped = 0
    for (const record of records) {
        const issues = getTemplateKindDefinition(record.kind).validate(record.data, {
            exists: ref => snapshot.exists(ref) || records.some(r => r.kind === ref.kind && r.id === ref.id),
        })
        if (issues.length) throw new Error(`Seed template ${record.kind}/${record.id} is invalid: ${JSON.stringify(issues)}`)
        const existing = snapshot.get(record)
        if (existing && !force) {
            skipped++
            continue
        }
        await templates.put(existing ? {...record, createdAt: existing.createdAt} : record)
        written++
    }

    const collectionId = 'egat_standard'
    const existingCollection = await collections.get(collectionId)
    if (!existingCollection || force) {
        const collection: TemplateCollection = {
            id: collectionId,
            name: 'EGAT standard',
            description: 'Standard conductors, line circuits, power transformers, yard and bay layouts used by EGAT.',
            tags: TAGS,
            items: records.map(r => ({kind: r.kind, id: r.id})),
            createdAt: existingCollection?.createdAt ?? now,
            updatedAt: now,
        }
        await collections.put(collection)
        console.log(`collection ${collectionId}: ${existingCollection ? 'overwritten' : 'created'} (${collection.items.length} items)`)
    } else {
        console.log(`collection ${collectionId}: exists, skipped`)
    }
    console.log(`templates: ${written} written, ${skipped} skipped (use --force to overwrite)`)

    await seedSampleNetwork(config.dataDir)
    console.log(`data directory: ${config.dataDir}`)
}

/**
 * A small sample grid so the editors have something to show: the CNO 230 kV
 * yard (coordinates from the original data set), one bay wired bus → breaker →
 * take-off, a junction and a 230 kV circuit section leaving the take-off.
 */
async function seedSampleNetwork(dataDir: string) {
    const store = new NetworkStore(path.join(dataDir, dataLayout.networks))
    await store.init()
    const id = 'sample_grid'
    if (await store.exists(id) && !force) {
        console.log(`network ${id}: exists, skipped`)
        return
    }
    const doc = newNetworkDocument(id, 'Sample grid', now)
    doc.description = 'Example network: CNO 230 kV yard with one wired bay, a line junction and one circuit section.'
    const yard = 'CNO_230KV'
    doc.substationGroups.push({id: 'CNO', groupName: 'CNO', name: 'Chonburi', coords: {latitude: 12.675490455599641, longitude: 101.33362016474413}})
    doc.substations.push({id: yard, groupId: 'CNO', yardName: '230KV', voltage: TransmissionVoltage.AC230KV, arrangement: SubstationArrangement.BREAKER_AND_A_HALF,
        coords: {latitude: 12.675588602194443, longitude: 101.33402919442857}})
    doc.buses.push({id: `${yard}_BUS1`, substationId: yard, busType: SubstationBusType.MAIN, busNumber: '1', bayNumber: '8001', row: 0, voltage: TransmissionVoltage.AC230KV})
    doc.buses.push({id: `${yard}_BUS2`, substationId: yard, busType: SubstationBusType.MAIN, busNumber: '2', bayNumber: '8002', row: 6, voltage: TransmissionVoltage.AC230KV})
    for (const [i, bay] of ['8041', '8042', '8043'].entries()) doc.bays.push({id: `${yard}_BAY_${bay}`, substationId: yard, bayNumber: bay, column: i, voltage: TransmissionVoltage.AC230KV})
    const bay = `${yard}_BAY_8041`
    doc.equipments.push({id: `${yard}_8041_DS1`, substationId: yard, bayId: bay, code: '8041-1', equipmentType: SubstationEquipmentType.DISCONNECTING_SWITCH, terminals: [{key: 'A'}, {key: 'B'}], row: 1})
    doc.equipments.push({id: `${yard}_8041_CB`, substationId: yard, bayId: bay, code: '8041', equipmentType: SubstationEquipmentType.CIRCUIT_BREAKER, terminals: [{key: 'A'}, {key: 'B'}], row: 2})
    doc.equipments.push({id: `${yard}_8041_CT`, substationId: yard, bayId: bay, code: '8041-CT', equipmentType: SubstationEquipmentType.CURRENT_TRANSFORMER, terminals: [{key: 'A'}, {key: 'B'}], row: 3})
    doc.takeOffs.push({id: `${yard}_TO_CTI_L1`, substationId: yard, bayId: bay, lineName: 'CTI_L1', row: 4, takeOffColumn: true})
    doc.junctions.push({id: 'CNO_JT_1', name: 'CNO_JT_1', coords: {latitude: 12.6912, longitude: 101.3601}})
    doc.paths.push({id: 'CNO_CTI_L1_S1_PATH', name: 'CNO–JT1 tower line', from: {kind: ConnectionJunctionKind.SUBSTATION_GROUP, id: 'CNO'}, to: {kind: ConnectionJunctionKind.TRANSMISSION_JUNCTION, id: 'CNO_JT_1'}, waypoints: [{latitude: 12.6832, longitude: 101.3468}]})
    doc.circuits.push({id: 'TCC_230KV_CNO_CTI_L1_S1', name: '230KV_CNO_CTI_L1_S1', pathId: 'CNO_CTI_L1_S1_PATH',
        voltage: TransmissionVoltage.AC230KV, energizedVoltage: TransmissionVoltage.AC230KV, bundle: 4,
        conductor: {size: 1272, unit: TransmissionWireUnit.MCM, type: TransmissionWireType.ACSR_GA}, lengthKm: 3.4})
    const at = {kind: ConnectionJunctionKind.SUBSTATION, id: yard}
    doc.connections.push({id: `${yard}_X1`, scope: ConnectionScope.SUBSTATION, junction: at, nodes: [{kind: NetworkNodeKind.SUBSTATION_BUS, id: `${yard}_BUS1`}, {kind: NetworkNodeKind.EQUIPMENT_TERMINAL, id: `${yard}_8041_DS1`, terminal: 'A'}]})
    doc.connections.push({id: `${yard}_X2`, scope: ConnectionScope.SUBSTATION, junction: at, nodes: [{kind: NetworkNodeKind.EQUIPMENT_TERMINAL, id: `${yard}_8041_DS1`, terminal: 'B'}, {kind: NetworkNodeKind.EQUIPMENT_TERMINAL, id: `${yard}_8041_CB`, terminal: 'A'}]})
    doc.connections.push({id: `${yard}_X3`, scope: ConnectionScope.SUBSTATION, junction: at, nodes: [{kind: NetworkNodeKind.EQUIPMENT_TERMINAL, id: `${yard}_8041_CB`, terminal: 'B'}, {kind: NetworkNodeKind.EQUIPMENT_TERMINAL, id: `${yard}_8041_CT`, terminal: 'A'}]})
    doc.connections.push({id: `${yard}_X4`, scope: ConnectionScope.SUBSTATION, junction: at, nodes: [{kind: NetworkNodeKind.EQUIPMENT_TERMINAL, id: `${yard}_8041_CT`, terminal: 'B'}, {kind: NetworkNodeKind.SUBSTATION_TAKE_OFF, id: `${yard}_TO_CTI_L1`}]})
    doc.connections.push({id: `${yard}_L1`, scope: ConnectionScope.TRANSMISSION, junction: at, nodes: [{kind: NetworkNodeKind.SUBSTATION_TAKE_OFF, id: `${yard}_TO_CTI_L1`}, {kind: NetworkNodeKind.TRANSMISSION_CIRCUIT, id: 'TCC_230KV_CNO_CTI_L1_S1', terminal: CIRCUIT_END_FROM}]})
    doc.connections.push({id: 'CNO_JT_1_C1', name: 'CNO_JT_1_1', voltage: TransmissionVoltage.AC230KV, scope: ConnectionScope.TRANSMISSION, junction: {kind: ConnectionJunctionKind.TRANSMISSION_JUNCTION, id: 'CNO_JT_1'}, nodes: [{kind: NetworkNodeKind.TRANSMISSION_CIRCUIT, id: 'TCC_230KV_CNO_CTI_L1_S1', terminal: CIRCUIT_END_TO}]})
    const issues = validateNetworkDocument(doc)
    if (issues.length) throw new Error(`Sample network invalid: ${JSON.stringify(issues)}`)
    await store.save(doc)
    await store.deleteJournal(id)
    console.log(`network ${id}: written`)
}

main().catch(err => {
    console.error(err)
    process.exit(1)
})
