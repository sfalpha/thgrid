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
import fs from "node:fs/promises";
import path from "node:path";
import {loadConfig, dataLayout, repoRoot} from "../src/server/config";
import {TemplateStore} from "../src/server/storage/template.store";
import {CollectionStore} from "../src/server/storage/collection.store";
import {slugifyTemplateId, TemplateKind, TemplateRecord} from "../src/templates/template";
import {TransmissionConductorTemplate} from "../src/templates/transmission.conductor";
import {TransmissionCircuitTemplateData} from "../src/templates/transmission.circuit";
import {PowerTransformerTemplate, TransformerWindingTemplate} from "../src/templates/power.transformer";
import {ConductorMountType, defaultMountTypes, TransmissionWireType, TransmissionWireUnit} from "../src/models/transmission.conductor";
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
import {NetworkDocument} from "../src/network/records";
import {migrateNetworkDocument} from "../src/network/migrate";
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
// Distribution: all-aluminium (AAC) overhead conductors in sq.mm, for 22 and 33 kV lines.
const AAC_SQMM = [25, 50, 95, 185, 200, 400]
for (const size of AAC_SQMM) conductors.push({name: `TC_${size}SQMM_AAC`, size, unit: TransmissionWireUnit.SQMM, type: TransmissionWireType.AAC})
// XLPE cables in sq.mm: 22 and 33 kV (all sizes) and 115 kV (300 sq.mm and up).
const XLPE_SQMM = [35, 50, 150, 300, 400, 500, 630, 800]
const XLPE_115KV_SQMM = [300, 400, 500, 630, 800]
for (const size of XLPE_SQMM) conductors.push({name: `TC_${size}SQMM_XLPE`, size, unit: TransmissionWireUnit.SQMM, type: TransmissionWireType.XLPE})
// every conductor lists the mounts that suit it: an XLPE cable's cable ladder, U-trench, duct bank and submarine; an aerial
// conductor's every other one (suspension strings, line posts, horizontal vee)
for (const c of conductors) c.mountTypes = defaultMountTypes(c.type)

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
/**
 * Circuits of sq.mm conductors: one per size and bundle, single unless `bundles` lists more for a size. XLPE cable
 * circuits are buried, in duct banks.
 */
const sqmmCircuits = (voltage: TransmissionVoltage, vLabel: string, suffix: string, sizes: number[], bundles: Record<number, number[]> = {}) => {
    for (const size of sizes) for (const bundle of bundles[size] ?? [1]) {
        circuits.push({
            name: `TCT_${vLabel}_${bundle}x${size}SQMM_${suffix}`, voltage, bundle, conductorId: slugifyTemplateId(`TC_${size}SQMM_${suffix}`),
            ...(suffix === 'XLPE' ? {mountType: ConductorMountType.DUCT_BANK} : {}),
        })
    }
}
// Distribution circuits at 22 and 33 kV: AAC (400 sq.mm also doubled) and XLPE cable (800 sq.mm also doubled).
for (const [voltage, vLabel] of [[TransmissionVoltage.AC22KV, '22KV'], [TransmissionVoltage.AC33KV, '33KV']] as const) {
    sqmmCircuits(voltage, vLabel, 'AAC', AAC_SQMM, {400: [1, 2]})
    sqmmCircuits(voltage, vLabel, 'XLPE', XLPE_SQMM, {800: [1, 2]})
}
// 115 kV XLPE cable circuits (800 sq.mm also double and quad).
sqmmCircuits(TransmissionVoltage.AC115KV, '115KV', 'XLPE', XLPE_115KV_SQMM, {800: [1, 2, 4]})

/* ---------- order: smaller conductors first (the collection and the pickers follow this order) ---------- */

const TYPE_ORDER = [TransmissionWireType.ACSR_GA, TransmissionWireType.ACSR_AW, TransmissionWireType.AAC, TransmissionWireType.HTLS_INVAR, TransmissionWireType.HTLS_ACCC, TransmissionWireType.XLPE]
const kv = (v?: TransmissionVoltage) => Number(String(v ?? '').replace(/\D/g, '')) || 0
/** A conductor's cross-section in sq.mm, so MCM and sq.mm sizes sort together (1 MCM = 0.5067 sq.mm). */
const areaMm2 = (c: TransmissionConductorTemplate) => c.unit === TransmissionWireUnit.MCM ? c.size * 0.5067 : c.size
conductors.sort((a, b) => areaMm2(a) - areaMm2(b) || TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type))
const conductorOf = (c: TransmissionCircuitTemplateData) => conductors.find(x => slugifyTemplateId(x.name) === c.conductorId)!
circuits.sort((a, b) => kv(a.voltage) - kv(b.voltage) || areaMm2(conductorOf(a)) - areaMm2(conductorOf(b)) || a.bundle - b.bundle || TYPE_ORDER.indexOf(conductorOf(a).type) - TYPE_ORDER.indexOf(conductorOf(b).type))

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
    /** Templates this run adds (not there before): an existing collection takes them in. */
    const added = new Set<string>()
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
        if (!existing) added.add(`${record.kind}:${record.id}`)
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
        // an existing collection takes in the templates added now, in the seed's order (smaller conductors first); the
        // seed's items it has keep that order too, and items added by hand stay after them
        const key = (i: { kind: string; id: string }) => `${i.kind}:${i.id}`
        const have = new Set(existingCollection.items.map(key))
        const seedItems = records.map(r => ({kind: r.kind, id: r.id}))
        const fresh = seedItems.filter(i => added.has(key(i)) && !have.has(key(i)))
        if (fresh.length) {
            const seedKeys = new Set(seedItems.map(key))
            const items = [...seedItems.filter(i => have.has(key(i)) || added.has(key(i))), ...existingCollection.items.filter(i => !seedKeys.has(key(i)))]
            await collections.put({...existingCollection, items, updatedAt: now})
            console.log(`collection ${collectionId}: ${fresh.length} new item(s) added (${items.length} items)`)
        } else console.log(`collection ${collectionId}: exists, nothing to add`)
    }
    console.log(`templates: ${written} written, ${skipped} skipped (use --force to overwrite)`)

    await seedSampleNetwork(config.dataDir)
    console.log(`data directory: ${config.dataDir}`)
}

/**
 * The sample grid, so the editors have something to show: written from `scripts/sample-grid.json`, the part of the
 * EGAT network around PDG (Pluak Daeng) that `npm run sample:grid` takes: PDG, the lines connected to it and the sites
 * one line away.
 */
async function seedSampleNetwork(dataDir: string) {
    const store = new NetworkStore(path.join(dataDir, dataLayout.networks))
    await store.init()
    const id = 'sample_grid'
    if (await store.exists(id) && !force) {
        console.log(`network ${id}: exists, skipped`)
        return
    }
    const sample = JSON.parse(await fs.readFile(path.join(repoRoot, 'scripts', 'sample-grid.json'), 'utf8')) as NetworkDocument
    const doc: NetworkDocument = {...migrateNetworkDocument(sample).doc, id, revision: 0, createdAt: now, updatedAt: now}
    const issues = validateNetworkDocument(doc).filter(i => i.severity !== 'warning')
    if (issues.length) throw new Error(`Sample network invalid: ${JSON.stringify(issues)}`)
    await store.save(doc)
    await store.deleteJournal(id)
    console.log(`network ${id}: written (${doc.substationGroups.length} sites, ${doc.lines.length} lines)`)
}

main().catch(err => {
    console.error(err)
    process.exit(1)
})
