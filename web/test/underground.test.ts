/**
 * Mount types and cable groups (docs/testing.md section 9): circuits with the Cable Ladder, U-Trench, Duct Bank and
 * Submarine mounts lie in groups of that kind, each kind numbered apart from the towers and the others
 * (`towerLayout.ts`); the map lays them after the towers; a position taken twice warns per kind; the line and circuit wizards set their circuits' mount and tower type; reversing a path mirrors towers and
 * duct banks each among themselves; the older `underground` flag migrates to the Duct Bank mount; a tower type is for
 * an aerial mount only; conductors list the mounts that suit them, and circuits take theirs from the templates.
 */
import {TransmissionVoltage as V} from '@shared/models/transmission.voltage'
import {AERIAL_MOUNT_TYPES, ConductorMountType as M, defaultMountTypes, preferredMountType, TransmissionWireType} from '@shared/models/transmission.conductor'
import {TowerType, towerTypeApplies} from '@shared/models/transmission.tower'
import {conductorMountTypes} from '@shared/templates/transmission.conductor'
import {validateTransmissionCircuitTemplate, validateTransmissionConductorTemplate} from '@shared/templates/validation'
import {applyOps} from '@shared/network/ops'
import {migrateNetworkDocument} from '@shared/network/migrate'
import {validateNetworkDocument} from '@shared/network/validation'
import {CIRCUIT_GROUP_NAMES, NetworkDocument, TransmissionCircuitRecord} from '@shared/network/records'
import {bundleLayout, towerLanePositions, towerSlots} from '../src/network/towerLayout'
import {templateMount} from '../src/network/circuitMount'
import {buildNewLinePlan} from '../src/network/lineWizard'
import {buildNewCircuitPlan} from '../src/network/circuitWizard'
import {buildSwapPathPlan} from '../src/network/swapPath'
import {test} from './harness'
import {G, lineFixture, Y} from './fixture'
import {lineNamed, spec} from './verify'

const circuit = (name: string, ductBank?: boolean, lineGroup?: number, groupCircuit?: number): TransmissionCircuitRecord =>
    ({id: name, name, ...(ductBank ? {mountType: M.DUCT_BANK} : {}), ...(lineGroup !== undefined ? {lineGroup} : {}), ...(groupCircuit !== undefined ? {groupCircuit} : {})})
const at = (s: ReturnType<typeof towerSlots>[number]) => `${CIRCUIT_GROUP_NAMES[s.kind].prefix}${s.group}/${s.number}`
/** Two circuits sharing the path of 230KV_QA_QB_L1. */
const pathPair = (base: NetworkDocument) => {
    const pathId = base.circuits.find(x => x.id === lineNamed(base, '230KV_QA_QB_L1').circuitIds[0])!.pathId!
    const [a, b] = base.circuits.filter(c => c.pathId === pathId)
    return {pathId, a, b}
}
const upsert = (record: TransmissionCircuitRecord) => ({type: 'upsert' as const, collection: 'circuits' as const, record})

test('UG-1', 'towers and each kind of cable group are numbered apart: two each, auto, each kind from 1', t => {
    const slots = towerSlots([circuit('A'), circuit('B'), circuit('C', true), circuit('D', true)])
    t.eq(slots.map(at).join(' '), 'T1/1 T1/2 D1/1 D1/2', 'A, B on tower 1; C, D in duct bank 1')
    const set = towerSlots([circuit('A', false, 2, 1), circuit('C', true), circuit('D', true, 3, 2)])
    t.eq(set.map(at).join(' '), 'T2/1 D4/1 D3/2', 'a tower group does not move the duct banks: the next new duct bank follows the highest duct bank (3)')
    const mounted = (name: string, mountType: M) => ({...circuit(name), mountType})
    const kinds = towerSlots([mounted('S', M.SUBMARINE), mounted('L', M.CABLE_LADDER), mounted('U', M.U_TRENCH), mounted('U2', M.U_TRENCH), mounted('P', M.LINE_POST), mounted('V', M.HORIZONTAL_VEE)])
    t.eq(kinds.map(at).join(' '), 'S1/1 C1/1 U1/1 U1/2 T1/1 T1/2', 'submarine groups, cable ladders and U-trenches each numbered from 1; the aerial mounts on towers')
})

test('UG-2', 'on the map the duct banks lie after the towers (to the right, looking from the FROM end)', t => {
    const pos = towerLanePositions([circuit('A'), circuit('B'), circuit('C', true), circuit('D', true)])
    t.eq(['A', 'B', 'C', 'D'].map(id => pos.get(id)).join(' '), '1.5 0.5 -0.5 -1.5', 'tower lanes left, duct bank lanes right, centred')
    const all = towerLanePositions([circuit('A'), {...circuit('B'), mountType: M.SUBMARINE}, {...circuit('C'), mountType: M.CABLE_LADDER}, {...circuit('D'), mountType: M.U_TRENCH}, circuit('E', true)])
    t.eq(['A', 'C', 'D', 'E', 'B'].map(id => all.get(id)).join(' '), '2 1 0 -1 -2', 'left to right: tower, cable ladder, U-trench, duct bank, submarine group')
})

test('UG-3', 'a position taken twice warns per kind: tower 1 / 1 and duct bank 1 / 1 on one path are fine together', t => {
    const base = lineFixture()
    const {a, b} = pathPair(base)
    const warnings = (doc: typeof base) => validateNetworkDocument(doc).filter(i => /position of/.test(i.message)).map(i => i.message)
    const mixed = applyOps(base, [upsert({...a, lineGroup: 1, groupCircuit: 1}), upsert({...b, lineGroup: 1, groupCircuit: 1, mountType: M.DUCT_BANK})])
    t.eq(warnings(mixed).length, 0, 'tower 1 / 1 and duct bank 1 / 1: no warning')
    const buried = applyOps(base, [upsert({...a, lineGroup: 1, groupCircuit: 1, mountType: M.DUCT_BANK}), upsert({...b, lineGroup: 1, groupCircuit: 1, mountType: M.DUCT_BANK})])
    t.check(warnings(buried).some(w => /takes the duct bank position of .* \(duct bank 1, circuit 1\)/.test(w)), 'both in duct bank 1 / 1: warned as a duct bank position', warnings(buried))
    const wet = applyOps(base, [upsert({...a, lineGroup: 1, groupCircuit: 1, mountType: M.DUCT_BANK}), upsert({...b, lineGroup: 1, groupCircuit: 1, mountType: M.SUBMARINE})])
    t.eq(warnings(wet).length, 0, 'duct bank 1 / 1 and submarine group 1 / 1: no warning')
    const sea = applyOps(base, [upsert({...a, lineGroup: 1, groupCircuit: 1, mountType: M.SUBMARINE}), upsert({...b, lineGroup: 1, groupCircuit: 1, mountType: M.SUBMARINE})])
    t.check(warnings(sea).some(w => /takes the submarine group position of .* \(submarine group 1, circuit 1\)/.test(w)), 'both in submarine group 1 / 1: warned', warnings(sea))
    const odd = applyOps(base, [upsert({...a, mountType: 'BURIED', towerType: 'PYLON'} as unknown as TransmissionCircuitRecord)])
    const paths = validateNetworkDocument(odd).filter(i => /must be one of/.test(i.message)).map(i => i.path)
    t.check(paths.some(p => p.endsWith('.mountType')) && paths.some(p => p.endsWith('.towerType')), 'mountType and towerType must be known values', paths)
})

test('UG-4', 'the line and circuit wizards set their circuits\' mount and tower type when asked', t => {
    const doc = lineFixture()
    const line = buildNewLinePlan(doc, spec({from: Y('SA', '230KV'), to: Y('SB', '230KV'), voltage: V.AC230KV, circuits: 2, mountType: M.DUCT_BANK}))
    t.eq(line.errors.join('; '), '', 'the line plan goes through')
    const sections = line.circuits.flatMap(c => c.sections)
    t.check(sections.length === 2 && sections.every(c => c.mountType === M.DUCT_BANK && c.towerType === undefined), 'both circuits in a duct bank', sections.map(c => c.mountType))
    const towers = buildNewLinePlan(doc, spec({from: Y('SA', '230KV'), to: Y('SB', '230KV'), voltage: V.AC230KV, mountType: M.SUSPENSION_V_STRING, towerType: TowerType.MONOPOLE_DOUBLE_CIRCUIT}))
    t.check(towers.circuits.flatMap(c => c.sections).every(c => c.mountType === M.SUSPENSION_V_STRING && c.towerType === TowerType.MONOPOLE_DOUBLE_CIRCUIT), 'an aerial mount with its tower type')
    const one = buildNewCircuitPlan(doc, {from: {place: G('SA')}, to: {place: G('SB')}, voltage: V.AC230KV, bundle: 1, mountType: M.DUCT_BANK})
    t.check(one.errors.length === 0 && one.circuit?.mountType === M.DUCT_BANK, 'the circuit wizard sets its circuit\'s mount', one.circuit)
    const overhead = buildNewLinePlan(doc, spec({from: Y('SA', '230KV'), to: Y('SB', '230KV'), voltage: V.AC230KV}))
    t.check(overhead.circuits.flatMap(c => c.sections).every(c => !('mountType' in c) && !('towerType' in c)), 'not asked: neither set')
})

test('UG-5', 'reversing a path mirrors the towers and the duct banks each among themselves', t => {
    const base = lineFixture()
    const {pathId, a, b} = pathPair(base)
    const doc = applyOps(base, [upsert({...a, lineGroup: 2, groupCircuit: 1}), upsert({...b, lineGroup: 1, groupCircuit: 1, mountType: M.DUCT_BANK})])
    const plan = buildSwapPathPlan(doc, pathId)
    const after = applyOps(doc, plan.ops)
    const pos = (id: string) => { const c = after.circuits.find(x => x.id === id)!; return `${c.mountType === M.DUCT_BANK ? 'D' : 'T'}${c.lineGroup}/${c.groupCircuit}` }
    t.eq(`${pos(a.id)} ${pos(b.id)}`, 'T2/2 D1/2', 'tower 2 stays tower 2 (the only tower), duct bank 1 stays 1; both change sides')
})

test('UG-6', 'bundles on the towers: one circle, two side by side, a triangle (two on top), a square; never touching', t => {
    const shape = (n: number) => bundleLayout(n).pts.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10])
    t.eq(JSON.stringify(shape(1)), '[[0,0]]', 'single: one circle at the centre')
    const twin = shape(2)
    t.check(twin.length === 2 && twin[0][1] === twin[1][1] && twin[0][0] === -twin[1][0], 'twin: two side by side', twin)
    const ys = shape(3).map(p => p[1]).sort((a, b) => a - b)
    t.check(ys[0] === ys[1] && ys[2] > ys[0], 'triple: two on top, one below (a triangle hanging point down)', shape(3))
    const quad = shape(4)
    t.check(new Set(quad.map(p => p[0])).size === 2 && new Set(quad.map(p => p[1])).size === 2, 'quad: a square', quad)
    for (const n of [2, 3, 4, 5, 6, 8]) {
        const {r, pts} = bundleLayout(n)
        const gaps = pts.flatMap((p, i) => pts.slice(i + 1).map(q => Math.hypot(p[0] - q[0], p[1] - q[1]) - 2 * r))
        t.check(Math.min(...gaps) > 0.5, `${n}: the sub-conductors keep apart`, Math.min(...gaps))
    }
    const b = bundleLayout(4)
    t.check(Math.abs(Math.min(...b.pts.map(p => p[1])) - b.r + b.hang) < 1e-9, 'the bundle hangs with its top at the insulator end')
})

test('UG-7', 'an older document: an underground circuit gets the Duct Bank mount, the flag is dropped', t => {
    const base = lineFixture()
    const {a, b} = pathPair(base)
    const old = {...base, circuits: base.circuits.map(c => c.id === a.id ? {...c, underground: true} : c.id === b.id ? {...c, underground: false} : c)} as NetworkDocument
    t.check(validateNetworkDocument(old).some(i => /underground is replaced by mountType/.test(i.message)), 'unmigrated: the flag is reported')
    const {doc, changes} = migrateNetworkDocument(old)
    const of = (id: string) => doc.circuits.find(c => c.id === id) as TransmissionCircuitRecord & { underground?: boolean }
    t.check(of(a.id).mountType === M.DUCT_BANK && of(a.id).underground === undefined, 'underground: true → the Duct Bank mount', of(a.id))
    t.check(of(b.id).mountType === undefined && of(b.id).underground === undefined, 'underground: false → dropped, no mount', of(b.id))
    t.eq(changes.filter(c => /underground/.test(c)).length, 2, 'both changes noted')
    t.eq(validateNetworkDocument(doc).filter(i => /underground/.test(i.message)).length, 0, 'migrated: nothing reported')
    t.eq(migrateNetworkDocument(doc).changes.length, 0, 'a second migration changes nothing')
})

test('UG-8', 'a tower type is for an aerial mount only (without a mount: a conductor that is not a cable)', t => {
    t.check(AERIAL_MOUNT_TYPES.every(m => towerTypeApplies(m, TransmissionWireType.XLPE)), 'every aerial mount takes a tower type')
    t.check([M.CABLE_LADDER, M.U_TRENCH, M.DUCT_BANK, M.SUBMARINE].every(m => !towerTypeApplies(m, TransmissionWireType.ACSR_GA)), 'no cable mount does')
    t.check(towerTypeApplies(undefined, TransmissionWireType.ACSR_GA) && !towerTypeApplies(undefined, TransmissionWireType.XLPE), 'no mount: by the conductor')
    const base = lineFixture()
    const {a, b} = pathPair(base)
    const doc = applyOps(base, [upsert({...a, mountType: M.DUCT_BANK, towerType: TowerType.LATTICE_STEEL_DELTA}), upsert({...b, mountType: M.HORIZONTAL_VEE, towerType: TowerType.LATTICE_STEEL_DELTA})])
    const warnings = validateNetworkDocument(doc).filter(i => /tower type/.test(i.message))
    t.check(warnings.length === 1 && warnings[0].severity === 'warning' && /Duct Bank\) is not an aerial one/.test(warnings[0].message), 'the duct bank circuit warned, the horizontal vee one not', warnings)
})

test('UG-9', 'conductors list the mounts that suit them; circuits take theirs from the templates', t => {
    t.eq(defaultMountTypes(TransmissionWireType.XLPE).join(' '), 'CABLE_LADDER U_TRENCH DUCT_BANK SUBMARINE', 'XLPE: the cable mounts')
    t.eq(defaultMountTypes(TransmissionWireType.AAC).join(' '), 'SUSPENSION_I_STRING SUSPENSION_V_STRING SUSPENSION_V_STRING_COMPACT LINE_POST HORIZONTAL_LINE_POST HORIZONTAL_VEE', 'an aerial conductor: every other mount')
    t.eq(conductorMountTypes({type: TransmissionWireType.ACSR_GA, mountTypes: [M.LINE_POST]}).join(' '), 'LINE_POST', 'a template\'s own list wins over the type\'s')
    t.eq(`${preferredMountType(defaultMountTypes(TransmissionWireType.XLPE))} ${preferredMountType(defaultMountTypes(TransmissionWireType.AAC))} ${preferredMountType([M.SUBMARINE])}`,
        'DUCT_BANK SUSPENSION_I_STRING SUBMARINE', 'preferred: a duct bank for a cable, an I-string for an aerial conductor, else the first listed')
    const xlpe = defaultMountTypes(TransmissionWireType.XLPE), aac = defaultMountTypes(TransmissionWireType.AAC)
    t.eq(JSON.stringify(templateMount({}, xlpe, undefined, TransmissionWireType.XLPE)), '{"mountType":"DUCT_BANK"}', 'an XLPE conductor template: the circuit lies in a duct bank')
    t.eq(templateMount({mountType: M.SUBMARINE}, xlpe, undefined, TransmissionWireType.XLPE).mountType, M.SUBMARINE, 'a mount the conductor lists is kept')
    t.eq(JSON.stringify(templateMount({mountType: M.DUCT_BANK, towerType: TowerType.MONOPOLE_SINGLE_CIRCUIT}, aac, undefined, TransmissionWireType.AAC)),
        '{"mountType":"SUSPENSION_I_STRING","towerType":"MONOPOLE_SINGLE_CIRCUIT"}', 'an aerial conductor after a cable: an I-string, the tower type kept')
    t.eq(JSON.stringify(templateMount({mountType: M.LINE_POST, towerType: TowerType.LATTICE_STEEL_DELTA}, aac, M.DUCT_BANK, TransmissionWireType.XLPE)),
        '{"mountType":"DUCT_BANK"}', 'the circuit template\'s mount wins; the tower type goes with the aerial mount')
    t.eq(templateMount({mountType: M.HORIZONTAL_VEE}, undefined, undefined, undefined).mountType, M.HORIZONTAL_VEE, 'no conductor template: unchanged')
})

test('UG-10', 'template payloads: a conductor\'s mountTypes and a circuit template\'s mountType are checked', t => {
    const conductor = {name: 'TC_X', size: 1, unit: 'SQMM', type: 'XLPE'}
    t.eq(validateTransmissionConductorTemplate({...conductor, mountTypes: ['DUCT_BANK', 'SUBMARINE']}).length, 0, 'a list of known mounts')
    t.check(validateTransmissionConductorTemplate({...conductor, mountTypes: []}).some(i => i.path === 'mountTypes'), 'an empty list is refused')
    t.check(validateTransmissionConductorTemplate({...conductor, mountTypes: ['BURIED']}).some(i => i.path === 'mountTypes'), 'an unknown mount is refused')
    t.check(validateTransmissionConductorTemplate({...conductor, mountTypes: ['TWISTED_AERIAL']}).some(i => i.path === 'mountTypes'), 'Twisted Aerial is no longer a mount type')
    t.check(validateTransmissionConductorTemplate({...conductor, mountTypes: ['DUCT_BANK', 'DUCT_BANK']}).some(i => /twice/.test(i.message)), 'a mount listed twice is refused')
    t.check(validateTransmissionConductorTemplate({...conductor, underground: true}).some(i => i.path === 'underground'), 'the older underground flag is refused')
    const exists = {exists: () => true}
    const circuitTemplate = {name: 'TCT_X', bundle: 1, conductorId: 'tc_x'}
    t.eq(validateTransmissionCircuitTemplate({...circuitTemplate, mountType: 'DUCT_BANK'}, exists).length, 0, 'a circuit template with a mount')
    t.check(validateTransmissionCircuitTemplate({...circuitTemplate, mountType: 'BURIED'}, exists).some(i => i.path === 'mountType'), 'an unknown mount is refused')
})
