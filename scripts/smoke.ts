/**
 * End-to-end smoke test of the backend API. Starts the app in-process on a
 * random port against a temporary data directory, walks through the template
 * and collection lifecycle and asserts status codes and payloads.
 *
 * Usage: npm run smoke
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {AddressInfo} from "node:net";
import {createApp, createContext} from "../src/server/app";
import {loadConfig} from "../src/server/config";
import {applyOps, renameRecordOps, checkNewId, cascadeDeleteOps, emptyLinesOps} from "../src/network/ops";
import {connectedCircuitGroup, lineWarnings, orderLineCircuits, proposalsForCircuit} from "../src/network/lines";
import {newNetworkDocument} from "../src/network/records";
import {validateNetworkDocument, validateNetworkOps, validateNetworkRecordShape} from "../src/network/validation";
import {migrateNetworkDocument} from "../src/network/migrate";
import {circuitNaming, junctionConnectionNaming, lineNaming, regenerateNamingOps, takeOffLineName, yardNaming} from "../src/network/naming";
import {suggestedParentSite} from "../src/network/extensions";
import {SubstationTakeOff} from "../src/models/substation.take.off";
import {Substation} from "../src/models/substation";
import {yardNameForVoltage} from "../src/models/naming";
import {SubstationBus} from "../src/models/substation.bus";
import {SubstationCircuitBreaker} from "../src/models/substation.circuit.breaker";
import {TransmissionCircuit} from "../src/models/transmission.circuit";
import {TransmissionLine} from "../src/models/transmission.line";

let failures = 0

function check(condition: boolean, label: string, extra?: unknown) {
    if (condition) {
        console.log(`  ok   ${label}`)
    } else {
        failures++
        console.log(`  FAIL ${label}${extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''}`)
    }
}

async function main() {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'thgrid-smoke-'))
    const config = {...loadConfig({}), dataDir, webDist: path.join(dataDir, 'no-web')}
    const ctx = await createContext(config)
    const server = createApp(ctx).listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server.once('listening', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

    const call = async (method: string, url: string, body?: unknown) => {
        const res = await fetch(base + url, {
            method,
            headers: body !== undefined ? {'Content-Type': 'application/json'} : undefined,
            body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
        })
        const text = await res.text()
        let json: any = undefined
        try {
            json = text ? JSON.parse(text) : undefined
        } catch {
            json = text
        }
        return {status: res.status, json}
    }

    try {
        console.log(`data dir: ${dataDir}`)

        let r = await call('GET', '/api/health')
        check(r.status === 200 && r.json.ok === true, 'GET /api/health')

        r = await call('GET', '/api/meta')
        check(r.status === 200 && r.json.kinds.length === 5 && r.json.enums.bayTemplateType.includes('BUS_TIE') && r.json.enums.transmissionVoltage.includes('AC230KV'), 'GET /api/meta')

        r = await call('GET', '/api/templates')
        check(r.status === 200 && Array.isArray(r.json) && r.json.length === 0, 'GET /api/templates (empty)')

        r = await call('GET', '/api/templates/NOPE')
        check(r.status === 400, 'unknown kind -> 400', r)

        r = await call('POST', '/api/templates/TRANSMISSION_CONDUCTOR', '{bad')
        check(r.status === 400 && r.json.error.code === 'BAD_JSON', 'malformed JSON -> 400')

        r = await call('POST', '/api/templates/TRANSMISSION_CONDUCTOR', {data: {name: 'X', size: -1, unit: 'FOO', type: 'AAC'}})
        check(r.status === 422 && r.json.error.issues.length === 2, 'invalid conductor -> 422 with 2 issues', r.json)

        r = await call('POST', '/api/templates/TRANSMISSION_CONDUCTOR/validate', {data: {name: 'X', size: 1, unit: 'MCM', type: 'AAC'}})
        check(r.status === 200 && r.json.valid === true, 'validate endpoint')

        r = await call('POST', '/api/templates/TRANSMISSION_CONDUCTOR', {description: 'smoke', tags: ['t'], data: {name: 'TC_SMOKE', size: 100, unit: 'SQMM', type: 'AAC'}})
        check(r.status === 201 && r.json.id === 'tc_smoke' && r.json.createdAt, 'create conductor -> 201, id derived from name', r.json)

        r = await call('POST', '/api/templates/TRANSMISSION_CONDUCTOR', {data: {name: 'TC_SMOKE', size: 100, unit: 'SQMM', type: 'AAC'}})
        check(r.status === 409, 'duplicate conductor -> 409')

        r = await call('POST', '/api/templates/TRANSMISSION_CONDUCTOR', {id: 'Bad Id', data: {name: 'TC_SMOKE2', size: 100, unit: 'SQMM', type: 'AAC'}})
        check(r.status === 422 && r.json.error.issues[0].path === 'id', 'bad explicit id -> 422')

        r = await call('PUT', '/api/templates/TRANSMISSION_CONDUCTOR/tc_smoke', {data: {name: 'TC_SMOKE', size: 120, unit: 'SQMM', type: 'AAC'}})
        check(r.status === 200 && r.json.data.size === 120 && r.json.description === undefined, 'update conductor -> 200 (envelope replaced)')

        r = await call('PUT', '/api/templates/TRANSMISSION_CONDUCTOR/tc_smoke', {id: 'other', data: {name: 'TC_SMOKE', size: 120, unit: 'SQMM', type: 'AAC'}})
        check(r.status === 400, 'changing id on update -> 400')

        r = await call('POST', '/api/templates/TRANSMISSION_CIRCUIT', {data: {name: 'TCT_SMOKE', bundle: 2, voltage: 'AC115KV', conductorId: 'missing'}})
        check(r.status === 422 && r.json.error.issues[0].path === 'data.conductorId', 'circuit with missing conductor -> 422')

        r = await call('POST', '/api/templates/TRANSMISSION_CIRCUIT', {data: {name: 'TCT_SMOKE', bundle: 2, voltage: 'AC115KV', conductorId: 'tc_smoke'}})
        check(r.status === 201, 'create circuit -> 201')

        r = await call('GET', '/api/templates/TRANSMISSION_CIRCUIT/tct_smoke/resolved')
        check(r.status === 200 && r.json.conductor.size === 120, 'resolved circuit embeds conductor')

        r = await call('POST', '/api/templates/POWER_TRANSFORMER', {
            data: {
                name: 'TR_SMOKE', modules: 1, windings: {
                    H: {windingSide: 'PRIMARY', wiring: 'STAR', voltage: 'AC230KV', tapChanger: 'ONLOAD', ratings: [{cooling: 'ONAN', power: 1000, perModule: false}]},
                    X: {windingSide: 'SECONDARY', wiring: 'STAR', voltage: 'AC115KV', tapChanger: 'NONE'},
                },
            },
        })
        check(r.status === 201, 'create power transformer -> 201', r.json)

        r = await call('POST', '/api/templates/POWER_TRANSFORMER', {
            data: {name: 'TR_BAD', modules: 1, windings: {X: {windingSide: 'SECONDARY', wiring: 'STAR', voltage: 'AC115KV', tapChanger: 'NONE'}}},
        })
        check(r.status === 422 && r.json.error.issues.some((i: any) => i.message.includes('PRIMARY')), 'transformer without high side -> 422')

        r = await call('POST', '/api/templates/SUBSTATION_YARD', {data: {name: 'YARD_SMOKE', arrangement: 'SINGLE_MAIN_AND_TRANSFER_BUS', buses: [{name: 'MAIN_BUS_1', busType: 'MAIN', busNumber: '1', row: 0}, {name: 'TRANSFER_BUS', busType: 'TRANSFER', row: 8}]}})
        check(r.status === 201 && r.json.id === 'yard_smoke', 'create substation yard template -> 201', r.json)

        r = await call('POST', '/api/templates/SUBSTATION_YARD', {data: {name: 'YARD_BAD', arrangement: 'NOPE', buses: [{name: 'A', busType: 'MAIN', busNumber: '1', row: 0}, {name: 'B', busType: 'MAIN', busNumber: '1', row: 0}]}})
        check(r.status === 422 && r.json.error.issues.some((i: any) => i.path === 'data.arrangement') && r.json.error.issues.some((i: any) => i.message.includes('duplicate bus')), 'yard template with bad arrangement and duplicate bus -> 422', r.json)

        r = await call('POST', '/api/templates/SUBSTATION_BAY', {data: {name: 'BAY_SMOKE', bayTemplateType: 'TAKEOFF', arrangements: ['SINGLE_MAIN_AND_TRANSFER_BUS'], equipments: [{equipmentType: 'DISCONNECTING_SWITCH', sequence: 1}, {equipmentType: 'CIRCUIT_BREAKER', sequence: 2}, {equipmentType: 'DISCONNECTING_SWITCH', sequence: 3, lineSide: true}]}})
        check(r.status === 201 && r.json.id === 'bay_smoke', 'create substation bay template -> 201', r.json)

        r = await call('POST', '/api/templates/SUBSTATION_BAY', {data: {name: 'BAY_BAD', bayTemplateType: 'TAKEOFF', arrangements: [], equipments: [{equipmentType: 'CIRCUIT_BREAKER', sequence: 1}, {equipmentType: 'CIRCUIT_BREAKER', sequence: 1, busTie: 'yes'}]}})
        check(r.status === 422 && r.json.error.issues.some((i: any) => i.path === 'data.arrangements') && r.json.error.issues.some((i: any) => i.path === 'data.equipments.1.sequence') && r.json.error.issues.some((i: any) => i.path === 'data.equipments.1.busTie'), 'bay template without arrangements, repeated sequence and bad flag -> 422', r.json)

        r = await call('DELETE', '/api/templates/TRANSMISSION_CONDUCTOR/tc_smoke')
        check(r.status === 409 && r.json.error.details.templates[0].id === 'tct_smoke', 'delete referenced conductor -> 409 with usage')

        r = await call('GET', '/api/templates/TRANSMISSION_CONDUCTOR/tc_smoke/usage')
        check(r.status === 200 && r.json.templates.length === 1, 'usage lists dependent circuit')

        r = await call('POST', '/api/collections', {name: 'Smoke set', items: [{kind: 'TRANSMISSION_CIRCUIT', id: 'tct_smoke'}, {kind: 'POWER_TRANSFORMER', id: 'tr_smoke', note: 'main'}]})
        check(r.status === 201 && r.json.id === 'smoke_set', 'create collection -> 201', r.json)

        r = await call('POST', '/api/collections', {name: 'Bad', items: [{kind: 'TRANSMISSION_CIRCUIT', id: 'nope'}]})
        check(r.status === 422, 'collection with missing template -> 422')

        r = await call('GET', '/api/collections')
        check(r.status === 200 && r.json[0].itemCount === 2, 'list collections (summaries)')

        r = await call('GET', '/api/collections/smoke_set/export')
        const bundle = r.json
        check(r.status === 200 && bundle.templates.length === 3, 'export bundle includes transitive conductor', bundle.templates?.map((t: any) => t.id))

        r = await call('POST', '/api/collections/import', bundle)
        check(r.status === 409, 'import existing bundle without overwrite -> 409')

        r = await call('POST', '/api/collections/import?overwrite=true', bundle)
        check(r.status === 201 && r.json.overwritten.length === 3, 'import with overwrite -> 201')

        r = await call('DELETE', '/api/templates/TRANSMISSION_CIRCUIT/tct_smoke?force=true')
        check(r.status === 200 && r.json.prunedFrom[0].id === 'smoke_set', 'force delete prunes collection')

        r = await call('GET', '/api/collections/smoke_set')
        check(r.status === 200 && r.json.items.length === 1, 'collection pruned to 1 item')

        r = await call('DELETE', '/api/templates/TRANSMISSION_CONDUCTOR/tc_smoke')
        check(r.status === 200, 'delete now-unreferenced conductor -> 200')

        r = await call('DELETE', '/api/collections/smoke_set')
        check(r.status === 200, 'delete collection -> 200')


        r = await call('GET', '/api/nope')
        check(r.status === 404, 'unknown api route -> 404')

        const files = await fs.readdir(path.join(dataDir, 'templates', 'power-transformer'))
        check(files.length === 1 && files[0] === 'tr_smoke.json', 'file layout data/templates/power-transformer/<id>.json', files)

        /* ---------- networks ---------- */
        console.log('networks:')
        r = await call('GET', '/api/networks')
        check(r.status === 200 && r.json.length === 0, 'GET /api/networks (empty)')

        r = await call('POST', '/api/networks', {name: 'Smoke Grid'})
        check(r.status === 201 && r.json.id === 'smoke_grid' && r.json.revision === 0, 'create network -> 201', r.json)

        r = await call('POST', '/api/networks', {name: 'Smoke Grid'})
        check(r.status === 409, 'duplicate network -> 409')

        const coords = {latitude: 12.6755, longitude: 101.3336}
        const ops1 = [
            {type: 'upsert', collection: 'substationGroups', record: {id: 'CNO', groupName: 'CNO', name: 'Chonburi', coords}},
            {type: 'upsert', collection: 'substations', record: {id: 'CNO_230', groupId: 'CNO', yardName: '230KV', voltage: 'AC230KV'}},
            {type: 'upsert', collection: 'bays', record: {id: 'CNO_230_8041', substationId: 'CNO_230', bayNumber: '8041', column: 0}},
            {type: 'upsert', collection: 'buses', record: {id: 'CNO_230_BUS1', substationId: 'CNO_230', busType: 'MAIN', busNumber: '1', row: 0}},
            {type: 'upsert', collection: 'equipments', record: {id: 'CNO_230_8041_CB', substationId: 'CNO_230', bayId: 'CNO_230_8041', code: '8041', equipmentType: 'CIRCUIT_BREAKER', terminals: [{key: 'A'}, {key: 'B'}], row: 1}},
            {type: 'upsert', collection: 'takeOffs', record: {id: 'CNO_230_CTI_L1', substationId: 'CNO_230', bayId: 'CNO_230_8041', lineName: 'CTI_L1', row: 2, takeOffColumn: true}},
            {type: 'upsert', collection: 'junctions', record: {id: 'JT1', name: 'JT1', coords: {latitude: 12.70, longitude: 101.40}}},
            {type: 'upsert', collection: 'paths', record: {id: 'P1', name: 'CNO-JT1 route', waypoints: [{latitude: 12.68, longitude: 101.35}]}},
            {type: 'upsert', collection: 'circuits', record: {id: 'C1', name: 'CNO_CTI_S1', pathId: 'P1', voltage: 'AC230KV', bundle: 4}},
            {type: 'upsert', collection: 'connections', record: {id: 'X1', scope: 'SUBSTATION', junction: {kind: 'SUBSTATION', id: 'CNO_230'}, nodes: [{kind: 'SUBSTATION_BUS', id: 'CNO_230_BUS1'}, {kind: 'EQUIPMENT_TERMINAL', id: 'CNO_230_8041_CB', terminal: 'A'}]}},
            {type: 'upsert', collection: 'connections', record: {id: 'X2', scope: 'SUBSTATION', junction: {kind: 'SUBSTATION', id: 'CNO_230'}, nodes: [{kind: 'EQUIPMENT_TERMINAL', id: 'CNO_230_8041_CB', terminal: 'B'}, {kind: 'SUBSTATION_TAKE_OFF', id: 'CNO_230_CTI_L1'}]}},
            {type: 'upsert', collection: 'connections', record: {id: 'T1', scope: 'TRANSMISSION', junction: {kind: 'SUBSTATION', id: 'CNO_230'}, nodes: [{kind: 'SUBSTATION_TAKE_OFF', id: 'CNO_230_CTI_L1'}, {kind: 'TRANSMISSION_CIRCUIT', id: 'C1', terminal: 'FROM'}]}},
            {type: 'upsert', collection: 'connections', record: {id: 'T2', scope: 'TRANSMISSION', junction: {kind: 'TRANSMISSION_JUNCTION', id: 'JT1'}, nodes: [{kind: 'TRANSMISSION_CIRCUIT', id: 'C1', terminal: 'TO'}]}},
        ]
        {
            // rename a record locally and check that references follow and the document stays valid
            const base = migrateNetworkDocument(applyOps(newNetworkDocument('x', 'x'), ops1 as any)).doc
            const renamed = applyOps(base, renameRecordOps(base, 'substations', 'CNO_230', 'CNO_230KV'))
            const refsOk = renamed.substations.some(s => s.id === 'CNO_230KV') && !renamed.substations.some(s => s.id === 'CNO_230')
                && renamed.bays.every(b => b.substationId === 'CNO_230KV') && renamed.connections.filter(c => c.junction.id === 'CNO_230KV').length === 3
                && renamed.paths[0].from?.kind === 'SUBSTATION_GROUP' && renamed.paths[0].from?.id === base.paths[0].from?.id   // path ends name the site, not the renamed yard
            check(refsOk && validateNetworkDocument(renamed).length === 0, 'renameRecordOps rewrites every reference', validateNetworkDocument(renamed))
            const renamedCircuit = applyOps(base, renameRecordOps(base, 'circuits', 'C1', 'C1_NEW'))
            check(renamedCircuit.connections.filter(c => c.nodes.some(n => n.id === 'C1_NEW')).length === 2 && validateNetworkDocument(renamedCircuit).length === 0, 'rename circuit updates connection nodes')
            check(checkNewId(base, 'C1', 'JT1') !== undefined && checkNewId(base, 'C1', 'bad id!') !== undefined && checkNewId(base, 'C1', 'C1_OK') === undefined, 'checkNewId enforces uniqueness and pattern')
            // site junction: one per site, deleted with the site, a connection there counts as "at the site" for path ends
            const groupId = base.substations.find(s => s.id === 'CNO_230')!.groupId
            const withSiteJunction = applyOps(base, [
                {type: 'upsert', collection: 'junctions', record: {id: 'TJT_CNO', name: 'CNO', coords: base.substationGroups[0].coords, groupId}},
                {type: 'upsert', collection: 'circuits', record: {id: 'C9', name: 'C9', pathId: 'P1', voltage: 'AC230KV'}},
                {type: 'upsert', collection: 'connections', record: {id: 'T9', name: 'CNO_1', scope: 'TRANSMISSION', junction: {kind: 'TRANSMISSION_JUNCTION', id: 'TJT_CNO'}, nodes: [{kind: 'TRANSMISSION_CIRCUIT', id: 'C9', terminal: 'FROM'}]}},
            ] as any)
            check(validateNetworkDocument(withSiteJunction).length === 0, 'a circuit end in the site junction lies at the site path end', validateNetworkDocument(withSiteJunction))
            const twoSiteJunctions = applyOps(withSiteJunction, [{type: 'upsert', collection: 'junctions', record: {id: 'TJT_CNO_2', name: 'CNO 2', coords: base.substationGroups[0].coords, groupId}}] as any)
            check(validateNetworkDocument(twoSiteJunctions).some(i => /at most one junction/.test(i.message)), 'a second site junction is a validation issue')
            const siteGone = applyOps(withSiteJunction, cascadeDeleteOps(withSiteJunction, 'substationGroups', groupId))
            check(!siteGone.junctions.some(j => j.id === 'TJT_CNO') && !siteGone.connections.some(c => c.id === 'T9'), 'deleting a site removes its junction and the connections there')
            // planned: a planned yard with a built take-off / connection is a warning, not an error
            const plannedYard = applyOps(base, [{type: 'upsert', collection: 'substations', record: {...base.substations.find(s => s.id === 'CNO_230')!, planned: true}}] as any)
            const plannedIssues = validateNetworkDocument(plannedYard)
            check(plannedIssues.length > 0 && plannedIssues.every(i => i.severity === 'warning') && plannedIssues.some(i => /take-off CTI_L1 is built but its yard is planned/.test(i.message)), 'planned yard used by built records -> warnings only', plannedIssues)
            check(validateNetworkRecordShape('circuits', {id: 'C', name: 'C', pathId: 'P1', planned: 'yes'}).some(i => i.path === 'planned'), 'planned must be a boolean')
            // energized voltage: filled on load from the first connected end whose voltage is known (T1 sits at the 230 kV yard)
            check(base.circuits[0].energizedVoltage === 'AC230KV', 'migration energizes a circuit at its connection voltage', base.circuits[0])
            const badVoltage = validateNetworkOps([{type: 'upsert', collection: 'circuits', record: {id: 'C2', name: 'x', pathId: 'P1', energizedVoltage: 'AC999KV'}}])
            check(badVoltage.some(i => i.path === 'ops.0.record.energizedVoltage'), 'energizedVoltage must be a TransmissionVoltage', badVoltage)
            const badConductor = validateNetworkOps([{type: 'upsert', collection: 'circuits', record: {id: 'C2', name: 'x', pathId: 'P1', conductor: {size: 'big', unit: 'MCM', type: 'COPPER'}}}])
            const goodConductor = validateNetworkOps([{type: 'upsert', collection: 'circuits', record: {id: 'C2', name: 'x', pathId: 'P1', conductor: {size: 1272, unit: 'MCM', type: 'ACSR/GA', code: 'TC1272'}}}])
            const genericOk = validateNetworkOps([{type: 'upsert', collection: 'circuits', record: {id: 'C2', name: 'x', pathId: 'P1', conductor: {size: 0, unit: 'SQMM', type: 'GENERIC'}}}])
            check(badConductor.some(i => i.path === 'ops.0.record.conductor.size') && badConductor.some(i => i.path === 'ops.0.record.conductor.type') && goodConductor.length === 0 && genericOk.length === 0, 'circuit conductor values are validated (GENERIC allowed)', badConductor)
            check(base.circuits.every(c => c.conductor?.type === 'GENERIC' && c.conductor.size === 0 && c.conductor.unit === 'SQMM'), 'migration gives circuits without conductor the GENERIC one', base.circuits)
            const badGen = validateNetworkOps([{type: 'upsert', collection: 'substationGroups', record: {id: 'G1', groupName: 'G1', coords, generation: 'yes', generationTypes: ['SOLAR', 'NUCLEAR', 'SOLAR']}}])
            const goodGen = validateNetworkOps([{type: 'upsert', collection: 'substationGroups', record: {id: 'G1', groupName: 'G1', coords, generation: true, generationTypes: ['SOLAR', 'BESS']}}])
            check(badGen.some(i => i.path === 'ops.0.record.generation') && badGen.some(i => i.path === 'ops.0.record.generationTypes.1') && badGen.some(i => i.path === 'ops.0.record.generationTypes.2') && goodGen.length === 0, 'site generation flag and types are validated', badGen)
            // static naming of the model classes, and the record-based helpers the editors use
            check(Substation.defaultId({groupName: 'CNO', yardName: '230KV'}) === 'SSY_CNO_230KV' && Substation.defaultName({yardName: '230KV'}) === '230KV'
                && SubstationBus.defaultName({busType: 'TRANSFER'}) === 'TRANSFER_BUS' && SubstationCircuitBreaker.defaultId({groupName: 'CNO', yardName: '230KV', code: '8041'}) === 'SCB_CNO_230KV_8041'
                && TransmissionCircuit.defaultName({from: 'CNO', to: 'CTI', voltage: 'AC230KV', sequence: 1}) === '230KV_CNO_CTI_S1'
                && TransmissionLine.defaultName({from: 'CNO', to: 'CTI', voltage: 'AC230KV'}) === '230KV_CNO_CTI_L1' && TransmissionLine.defaultName({from: 'CNO', to: 'CTI', sequence: 2}) === 'CNO_CTI_L2', 'model statics derive ids / names with the class prefix')
            check(yardNaming(base, 'CNO', '115KV').id === 'SSY_CNO_115KV', 'yardNaming builds the yard id from the site code')
            const dcYard = yardNaming(base, 'CNO', '', 'DC300KV'), acYard = yardNaming(base, 'CNO', undefined, 'AC115KV')
            check(dcYard.name === '300KVDC' && dcYard.id === 'SSY_CNO_300KVDC' && acYard.name === '115KV' && yardNameForVoltage('AC400V') === '400V' && yardNameForVoltage('AC69KV') === '69KV' && yardNameForVoltage('0V') === '0V', 'yard name defaults to the voltage without AC, DC suffixed', [dcYard, acYard])
            // circuit names: <line>_<path> in a line, else <voltage>_<path>_S<n> (n among the path's circuits in no line; C1 holds S1), <FROM>-<TO> without a path
            const cn = circuitNaming(base, {pathId: 'P1', voltage: 'AC230KV'})
            const cnLine = circuitNaming(base, {pathId: 'P1', lineName: '230KV_CNO_CTI_L1'})
            const cnNoPath = circuitNaming(base, {from: {kind: 'SUBSTATION', id: 'CNO_230'} as never, to: {kind: 'TRANSMISSION_JUNCTION', id: 'JT1'} as never, voltage: 'AC230KV'})
            check(cn.name === '230KV_CNO-JT1 route_S2' && cn.id === 'TCC_230KV_CNO-JT1_route_S2' && cnLine.name === '230KV_CNO_CTI_L1_CNO-JT1 route' && cnNoPath.name === '230KV_CNO-JT1_S1',
                'circuitNaming: <line>_<path>, else <voltage>_<path>_S<n> numbered on the path, <FROM>-<TO> without a path', [cn, cnLine, cnNoPath])
            const jn = junctionConnectionNaming(base, 'JT1')
            check(jn.name === 'JT1_2' && jn.id === 'TCN_JT1_2', 'junctionConnectionNaming picks the next free <junction>_<n>', jn)

            // lines: a second yard joined at JT1 makes C1 + C2 a substation-to-substation chain; a legacy circuit.lineId is migrated into line.circuitIds
            const ops2 = [
                {type: 'upsert', collection: 'substationGroups', record: {id: 'CTI', groupName: 'CTI', coords: {latitude: 12.72, longitude: 101.45}}},
                {type: 'upsert', collection: 'substations', record: {id: 'CTI_230', groupId: 'CTI', yardName: '230KV', voltage: 'AC230KV'}},
                {type: 'upsert', collection: 'takeOffs', record: {id: 'CTI_230_CNO_L1', substationId: 'CTI_230', lineName: 'CNO_L1', takeOffColumn: true}},
                {type: 'upsert', collection: 'paths', record: {id: 'P2', name: 'JT1-CTI', waypoints: []}},
                {type: 'upsert', collection: 'circuits', record: {id: 'C2', name: 'JT1_CTI', pathId: 'P2', voltage: 'AC230KV', lineId: 'L_OLD'}},
                {type: 'upsert', collection: 'lines', record: {id: 'L_OLD', name: 'old line'}},
                {type: 'upsert', collection: 'connections', record: {id: 'T2', name: 'JT1_1', scope: 'TRANSMISSION', junction: {kind: 'TRANSMISSION_JUNCTION', id: 'JT1'}, nodes: [{kind: 'TRANSMISSION_CIRCUIT', id: 'C1', terminal: 'TO'}, {kind: 'TRANSMISSION_CIRCUIT', id: 'C2', terminal: 'FROM'}]}},
                {type: 'upsert', collection: 'connections', record: {id: 'T3', scope: 'TRANSMISSION', junction: {kind: 'SUBSTATION', id: 'CTI_230'}, nodes: [{kind: 'SUBSTATION_TAKE_OFF', id: 'CTI_230_CNO_L1'}, {kind: 'TRANSMISSION_CIRCUIT', id: 'C2', terminal: 'TO'}]}},
            ]
            const doc2 = migrateNetworkDocument(applyOps(base, ops2 as any)).doc
            const oldLine = doc2.lines.find(l => l.id === 'L_OLD')
            check(!!oldLine && oldLine.circuitIds.length === 1 && oldLine.circuitIds[0] === 'C2' && doc2.circuits.every(c => c.lineId === undefined) && oldLine.to?.id === 'CTI_230', 'migration moves circuit.lineId into line.circuitIds and derives the line ends', oldLine)
            check(validateNetworkDocument(doc2).length === 0, 'document with lines is valid', validateNetworkDocument(doc2))
            const group = connectedCircuitGroup(doc2, 'C1')
            check(group.circuitIds.length === 2 && group.terminals.length === 2 && group.junctionNodeIds.length === 1, 'connectedCircuitGroup walks through the junction node to both yards', group)
            const proposals = proposalsForCircuit(doc2, 'C1')
            const ends = proposals[0] ? [proposals[0].from.id, proposals[0].to.id].sort().join(',') : ''
            check(proposals.length === 1 && proposals[0].circuitIds.length === 2 && ends === 'CNO_230,CTI_230' && !proposals[0].existingLineId, 'proposalsForCircuit offers the yard-to-yard chain as a line', proposals)
            const line = {id: 'L1', name: '230KV_CNO_CTI', from: proposals[0].from, to: proposals[0].to, circuitIds: [...proposals[0].circuitIds].reverse()}
            const doc3 = applyOps(doc2, [{type: 'upsert', collection: 'lines', record: line}] as any)
            check(lineWarnings(doc3, doc3.lines.find(l => l.id === 'L1')!).length > 0 && orderLineCircuits(doc3, doc3.lines.find(l => l.id === 'L1')!).join(',') === proposals[0].circuitIds.join(','), 'lineWarnings flags reversed sections and orderLineCircuits walks them from the FROM yard')
            const doc4 = applyOps(doc3, [{type: 'upsert', collection: 'lines', record: {...line, circuitIds: proposals[0].circuitIds}}] as any)
            check(proposalsForCircuit(doc4, 'C2')[0]?.existingLineId === 'L1', 'proposalsForCircuit recognises an existing line with the same sections and ends')
            // take-off toward a site: <site code>_L<n>, n after the highest existing number from that yard (CNO_230 already has CTI_L1)
            // the yards are 230 kV; CNO_230 already has CTI_L1 (old style, still counted) and CTI_230 has CNO_L1
            check(takeOffLineName(doc4, 'CNO_230', 'CTI') === '230KV_CTI_L2' && takeOffLineName(doc4, 'CTI_230', 'CNO') === '230KV_CNO_L2' && takeOffLineName(doc4, 'CNO_230', 'nope') === undefined
                && SubstationTakeOff.defaultLineName({targetCode: 'CTI', voltage: 'AC230KV'}) === '230KV_CTI_L1' && SubstationTakeOff.defaultLineName({targetCode: 'CTI', voltage: 'DC300KV', sequence: 2}) === '300KVDC_CTI_L2'
                && SubstationTakeOff.defaultId({groupName: 'CNO', yardName: '230KV', voltage: 'AC230KV', targetCode: 'CTI', sequence: 3}) === 'STO_CNO_230KV_230KV_CTI_L3', 'take-off line names are <voltage>_<site>_L<n>, numbered per target site')
            const secondLine = lineNaming(doc4, undefined, proposals[0].to, proposals[0].from, 'AC230KV')
            check(secondLine.name === '230KV_CTI_CNO_L2' && secondLine.id === 'TLN_230KV_CTI_CNO_L2', 'lineNaming numbers lines per pair of substations, either direction', secondLine)
            // site extensions: one level, a renamed parent keeps its extensions, a deleted one leaves them sites of their own
            const cti = doc4.substationGroups.find(g => g.id === 'CTI')!, cno = doc4.substationGroups.find(g => g.id === 'CNO')!
            const ext = applyOps(doc4, [{type: 'upsert', collection: 'substationGroups', record: {...cti, extensionOf: 'CNO'}}] as any)
            const bad = (d: typeof doc4) => validateNetworkDocument(d).filter(i => i.path.endsWith('extensionOf')).length
            check(bad(ext) === 0 && bad(applyOps(doc4, [{type: 'upsert', collection: 'substationGroups', record: {...cti, extensionOf: 'CTI'}}] as any)) === 1
                && bad(applyOps(ext, [{type: 'upsert', collection: 'substationGroups', record: {...cno, extensionOf: 'CTI'}}] as any)) >= 1
                && bad(applyOps(doc4, [{type: 'upsert', collection: 'substationGroups', record: {...cti, extensionOf: 'NOPE'}}] as any)) === 1, 'extensionOf: an existing site, not itself, one level deep')
            const extRenamed = applyOps(ext, renameRecordOps(ext, 'substationGroups', 'CNO', 'SSG_CNO'))
            check(extRenamed.substationGroups.find(g => g.id === 'CTI')?.extensionOf === 'SSG_CNO', 'renaming a parent site keeps its extensions linked')
            const extDeleted = applyOps(ext, cascadeDeleteOps(ext, 'substationGroups', 'CNO'))
            check(!!extDeleted.substationGroups.find(g => g.id === 'CTI') && extDeleted.substationGroups.find(g => g.id === 'CTI')!.extensionOf === undefined, 'deleting a parent site leaves its extensions as sites of their own')
            check(suggestedParentSite({...doc4, substationGroups: [...doc4.substationGroups, {id: 'CNO_T', groupName: 'CNO_T', coords: {latitude: 12.701, longitude: 101.401}}]} as any, {id: 'CNO_T', groupName: 'CNO_T', coords: {latitude: 12.701, longitude: 101.401}})?.parent.id === 'CNO'
                && suggestedParentSite(doc4, {id: 'X_T', groupName: 'CTI_X', coords: {latitude: 15, longitude: 101}}) === undefined, 'suggestedParentSite: the code prefix names a nearby site')
            // tower position of a circuit: line group ≥ 1, circuit in group 1 or 2, a position taken twice on one path warns
            const towerShape = (r: object) => validateNetworkRecordShape('circuits', {id: 'CX', name: 'CX', ...r}).map(i => i.path)
            check(towerShape({lineGroup: 1, groupCircuit: 2}).length === 0 && towerShape({lineGroup: 0}).includes('lineGroup') && towerShape({groupCircuit: 0}).includes('groupCircuit') && towerShape({groupCircuit: 4}).length === 0
                && towerShape({lineGroup: 1.5}).includes('lineGroup'), 'circuit lineGroup / groupCircuit are checked', [towerShape({lineGroup: 0}), towerShape({groupCircuit: 0})])
            const towerC1 = doc4.circuits.find(c => c.id === 'C1')!
            const towerDup = applyOps(doc4, [{type: 'upsert', collection: 'circuits', record: {...towerC1, lineGroup: 1, groupCircuit: 1}},
                {type: 'upsert', collection: 'circuits', record: {...towerC1, id: 'C1B', name: 'C1B', lineGroup: 1, groupCircuit: 1}}] as any)
            check(validateNetworkDocument(towerDup).some(i => i.severity === 'warning' && /tower position/.test(i.message)), 'two circuits at one tower position of a path warn')
            const afterDelete = applyOps(doc4, cascadeDeleteOps(doc4, 'circuits', 'C2'))
            check(afterDelete.lines.find(l => l.id === 'L1')!.circuitIds.join(',') === 'C1' && validateNetworkDocument(afterDelete).length === 0, 'deleting a circuit removes it from its lines')
            // a line exists only while it has circuits: one whose only section is deleted goes with it
            const onlyC2 = doc4.lines.filter(l => l.circuitIds.length === 1 && l.circuitIds[0] === 'C2').map(l => l.id)
            check(onlyC2.length > 0 && onlyC2.every(id => !afterDelete.lines.some(l => l.id === id)) && cascadeDeleteOps(doc4, 'circuits', 'C2').some(o => o.type === 'delete' && o.collection === 'lines'),
                'deleting the only circuit of a line removes the line', onlyC2)
            const emptied = applyOps(doc4, [{type: 'upsert', collection: 'lines', record: {...doc4.lines[0], circuitIds: []}}] as any)
            check(emptyLinesOps(emptied).length === 1 && emptyLinesOps(doc4).length === 0, 'emptyLinesOps lists the lines without circuits')
            // a junction node stays while a circuit end is in it, and goes with the last one
            check(afterDelete.connections.find(c => c.id === 'T2')?.nodes.map(n => `${n.id}:${n.terminal}`).join(',') === 'C1:TO', 'a junction node keeps its remaining circuit end', afterDelete.connections.find(c => c.id === 'T2'))
            const bothGone = applyOps(afterDelete, cascadeDeleteOps(afterDelete, 'circuits', 'C1'))
            check(!bothGone.connections.some(c => c.id === 'T2'), 'a junction node without circuit ends is removed')
            // paths are optional: deleting a path keeps its circuits, without a path (drawn dashed between their attached ends)
            const pathGone = applyOps(doc4, cascadeDeleteOps(doc4, 'paths', 'P1'))
            const c1NoPath = pathGone.circuits.find(c => c.id === 'C1')
            check(!!c1NoPath && c1NoPath.pathId === undefined && !('pathId' in c1NoPath) && pathGone.circuits.length === doc4.circuits.length
                && validateNetworkDocument(pathGone).filter(i => i.severity !== 'warning').length === 0, 'deleting a path keeps its circuits without a path', validateNetworkDocument(pathGone))
            const renamedSection = applyOps(doc4, renameRecordOps(doc4, 'circuits', 'C1', 'C1_X'))
            check(renamedSection.lines.find(l => l.id === 'L1')!.circuitIds[0] === 'C1_X' && validateNetworkDocument(renamedSection).length === 0, 'renaming a circuit updates line sections')

            // mass regeneration of ids / names from the model rules (a site and a junction get their id only)
            const plan = regenerateNamingOps(doc4, [{collection: 'circuits', id: 'C1'}, {collection: 'substations', id: 'CNO_230'}, {collection: 'lines', id: 'L1'}, {collection: 'substationGroups', id: 'CNO'}, {collection: 'junctions', id: 'JT1'}], {id: true, name: true})
            const regenerated = applyOps(doc4, plan.ops)
            // C1 is in line L1, renamed 230KV_CNO_CTI_L1 in the same run: the circuit takes the new line name
            const c1 = regenerated.circuits.find(c => c.name === '230KV_CNO_CTI_L1_CNO-JT1 route')
            check(plan.skipped.length === 0 && plan.changes.length === 5, 'regenerateNamingOps plans every target', plan)
            const jt = regenerated.junctions.find(j => j.name === 'JT1')
            check(jt?.id === 'TJT_JT1' && plan.changes.some(c => c.collection === 'junctions' && c.newId === 'TJT_JT1' && c.newName === undefined)
                && regenerated.connections.some(c => c.id === 'T2' && c.junction.id === 'TJT_JT1') && regenerated.paths.some(p => p.to?.id === 'TJT_JT1'), 'a junction gets its id from its name (TJT_<name>), keeps the name, and nodes and paths follow', {jt, paths: regenerated.paths})
            const site = regenerated.substationGroups.find(g => g.groupName === 'CNO')
            check(!!c1 && c1.id === 'TCC_230KV_CNO_CTI_L1_CNO-JT1_route' && regenerated.substations.some(s => s.id === 'SSY_CNO_230KV' && s.groupId === 'SSG_CNO') && site?.id === 'SSG_CNO' && site.name === 'Chonburi'
                && plan.changes.some(c => c.collection === 'substationGroups' && c.newId === 'SSG_CNO' && c.newName === undefined), 'regeneration renames circuit and yard by the rules and gives a site its rule id but keeps its name', plan.changes)
            check(regenerated.paths.every(p => p.from?.id !== 'CNO' && p.to?.id !== 'CNO'), 'paths follow a regenerated site id', regenerated.paths)
            // the test line has no voltage of its own: it is named after the rated voltage of its sections (230 kV)
            check(regenerated.lines.find(l => l.id === 'TLN_230KV_CNO_CTI_L1')?.circuitIds[0] === 'TCC_230KV_CNO_CTI_L1_CNO-JT1_route' && regenerated.connections.every(c => c.junction.id !== 'CNO_230') && validateNetworkDocument(regenerated).length === 0, 'regeneration keeps every reference valid', regenerated.lines)
            check(regenerateNamingOps(regenerated, [{collection: 'circuits', id: 'TCC_230KV_CNO_CTI_L1_CNO-JT1_route'}], {id: true, name: true}).changes.length === 0, 'regeneration is idempotent')
            // Parallel lines are numbered by the numbers in their names, not by document order (a rename moves the record to the end),
            // and two lines trading ids swap them without a `_2` suffix.
            const l1 = regenerated.lines.find(l => l.id === 'TLN_230KV_CNO_CTI_L1')!
            const crossed = applyOps(regenerated, [{type: 'delete', collection: 'lines', id: l1.id}, {type: 'upsert', collection: 'lines', record: {...l1, id: 'TLN_230KV_CNO_CTI_L2', name: '230KV_CNO_CTI_L1'}},
                {type: 'upsert', collection: 'lines', record: {...l1, id: 'TLN_230KV_CNO_CTI_L1', name: '230KV_CNO_CTI_L2'}}] as any)
            const lineTargets = (d: typeof crossed) => d.lines.filter(l => l.name.startsWith('230KV_CNO_CTI_')).map(l => ({collection: 'lines' as const, id: l.id}))
            const swapPlan = regenerateNamingOps(crossed, lineTargets(crossed), {id: true, name: true})
            const swapped = applyOps(crossed, swapPlan.ops)
            check(swapPlan.changes.length === 2 && swapped.lines.find(l => l.name === '230KV_CNO_CTI_L1')?.id === 'TLN_230KV_CNO_CTI_L1' && swapped.lines.find(l => l.name === '230KV_CNO_CTI_L2')?.id === 'TLN_230KV_CNO_CTI_L2'
                && !swapped.lines.some(l => l.id.startsWith('regen_tmp')), 'lines trading ids swap them without a suffix', swapPlan.changes)
            check(regenerateNamingOps(swapped, lineTargets(swapped), {id: true, name: true}).changes.length === 0, 'regenerating parallel lines again changes nothing')
            // renaming only some of the parallel records never hands out a number a kept sibling still carries (records merged onto a path with S1..S4)
            const joined = applyOps(swapped, [{type: 'upsert', collection: 'lines', record: {...l1, id: 'X3', name: '230KV_CNO_CTI_L1'}}] as any)
            const partPlan = regenerateNamingOps(joined, [{collection: 'lines', id: 'X3'}], {id: true, name: true})
            check(partPlan.changes[0]?.newName === '230KV_CNO_CTI_L3' && partPlan.changes[0]?.newId === 'TLN_230KV_CNO_CTI_L3', 'a renamed sibling takes a number no kept sibling uses', partPlan.changes)
            // substation side: bay, bus, equipment and take-off get id and name from their number / code / line name
            const yardPlan = regenerateNamingOps(doc4, [{collection: 'bays', id: 'CNO_230_8041'}, {collection: 'buses', id: 'CNO_230_BUS1'}, {collection: 'equipments', id: 'CNO_230_8041_CB'}, {collection: 'takeOffs', id: 'CNO_230_CTI_L1'}], {id: true, name: true})
            const yardDoc = applyOps(doc4, yardPlan.ops)
            const bay = yardDoc.bays.find(b => b.id === 'SBA_CNO_230KV_8041'), cb = yardDoc.equipments.find(e => e.id === 'SCB_CNO_230KV_8041')
            check(!!bay && bay.name === 'BAY_8041' && yardDoc.buses.some(b => b.id === 'SBU_CNO_230KV_MAIN_BUS_1' && b.name === 'MAIN_BUS_1') && !!cb && cb.name === '8041' && cb.bayId === bay.id
                && yardDoc.takeOffs.some(t => t.id === 'STO_CNO_230KV_CTI_L1' && t.name === 'CTI_L1') && validateNetworkDocument(yardDoc).length === 0, 'substation items regenerate id and name from code and keep references', yardPlan.changes)
        }

        r = await call('POST', '/api/networks/smoke_grid/journal', {ops: ops1, expectedLastSeq: 0})
        check(r.status === 200 && r.json.lastSeq === ops1.length, 'append ops -> journal', r.json)

        r = await call('POST', '/api/networks/smoke_grid/journal', {ops: [{type: 'delete', collection: 'circuits', id: 'nope'}]})
        check(r.status === 422, 'op that cannot apply -> 422')

        // paths are optional: a circuit without one is accepted, and one that is not attached at both ends gets a "cannot be drawn" warning
        r = await call('POST', '/api/networks/smoke_grid/journal', {ops: [{type: 'upsert', collection: 'circuits', record: {id: 'C9', name: 'no path'}}]})
        check(r.status === 200, 'circuit without a path is accepted', r.json)
        r = await call('GET', '/api/networks/smoke_grid/working')
        check(r.json.issues.some((i: any) => i.severity === 'warning' && /no path/.test(i.message) && i.path === `circuits.${r.json.document.circuits.findIndex((c: any) => c.id === 'C9')}`), 'a circuit without a path and without its ends attached gets a warning', r.json.issues)
        r = await call('POST', '/api/networks/smoke_grid/journal', {ops: [{type: 'delete', collection: 'circuits', id: 'C9'}]})
        check(r.status === 200, 'remove the circuit without a path')
        r = await call('POST', '/api/networks/smoke_grid/journal', {ops: [{type: 'upsert', collection: 'circuits', record: {id: 'C10', name: 'bad path', pathId: ''}}]})
        check(r.status === 422 && r.json.error.issues.some((i: any) => i.path === 'ops.0.record.pathId'), 'an empty pathId -> 422')

        r = await call('POST', '/api/networks/smoke_grid/journal', {ops: [{type: 'upsert', collection: 'bays', record: {id: 'b', substationId: 'x'}}]})
        check(r.status === 422 && r.json.error.issues.some((i: any) => i.path === 'ops.0.record.bayNumber'), 'malformed record -> 422')

        r = await call('POST', '/api/networks/smoke_grid/journal', {ops: [{type: 'meta', name: 'Smoke Grid 2'}], expectedLastSeq: 1})
        check(r.status === 409, 'stale expectedLastSeq -> 409')

        r = await call('GET', '/api/networks/smoke_grid/working')
        check(r.status === 200 && r.json.document.circuits.length === 1 && r.json.journal.entries === ops1.length + 2 && r.json.issues.length === 0, 'working state applies journal and validates', r.json.issues)

        r = await call('GET', '/api/networks/smoke_grid')
        check(r.status === 200 && r.json.circuits.length === 0, 'saved document untouched before save')

        // a take-off-less transmission connection at a substation must be rejected on save
        r = await call('POST', '/api/networks/smoke_grid/journal', {ops: [{type: 'upsert', collection: 'connections', record: {id: 'T3', scope: 'TRANSMISSION', junction: {kind: 'SUBSTATION', id: 'CNO_230'}, nodes: [{kind: 'TRANSMISSION_CIRCUIT', id: 'C1', terminal: 'FROM'}]}}]})
        check(r.status === 200, 'append invalid connection (journal accepts)')
        r = await call('POST', '/api/networks/smoke_grid/save')
        check(r.status === 422 && r.json.error.issues.some((i: any) => /take-off/.test(i.message)), 'save with issues -> 422 (take-off rule)', r.json.error?.issues)
        r = await call('POST', '/api/networks/smoke_grid/journal', {ops: [{type: 'delete', collection: 'connections', id: 'T3'}]})
        check(r.status === 200, 'remove invalid connection')

        r = await call('POST', '/api/networks/smoke_grid/save')
        check(r.status === 200 && r.json.document.revision === 1 && r.json.archivedVersion && r.json.appliedEntries === ops1.length + 4, 'save -> revision 1, archived version', r.json)
        check(r.json.document.connections.find((c: any) => c.id === 'T2')?.name === 'JT1_1', 'migration names unnamed junction connections <junction>_<n>', r.json.document.connections)
        check(r.json.document.paths[0]?.from?.kind === 'SUBSTATION_GROUP' && r.json.document.paths[0]?.from?.id === r.json.document.substations.find((s: any) => s.id === 'CNO_230')?.groupId && r.json.document.paths[0]?.to?.id === 'JT1', 'migration derives path ends (site / junction) from its circuits', r.json.document.paths)
        const v0 = r.json.archivedVersion

        r = await call('GET', '/api/networks/smoke_grid/journal')
        check(r.status === 200 && r.json.entries.length === 0, 'journal cleared after save')

        r = await call('POST', '/api/networks/smoke_grid/journal', {ops: [{type: 'delete', collection: 'junctions', id: 'JT1'}, {type: 'delete', collection: 'connections', id: 'T2'}]})
        check(r.status === 200, 'append second round')
        r = await call('DELETE', '/api/networks/smoke_grid/journal')
        check(r.status === 200 && r.json.discarded === 2, 'discard journal')

        // Live editing by several editors: change events name the client that caused them (X-Thgrid-Client), and
        // ?after= returns only the newer entries, with the journal epoch (startedAt) to tell a continuation from a restart.
        {
            const seen: any[] = []
            const onChange = (e: any) => seen.push(e)
            ctx.networkService.events.on('change', onChange)
            const as = async (client: string, method: string, url: string, body?: unknown) =>
                (await fetch(base + url, {method, headers: {'Content-Type': 'application/json', 'X-Thgrid-Client': client}, body: body === undefined ? undefined : JSON.stringify(body)})).json()
            const a1 = await as('smoke-a', 'POST', '/api/networks/smoke_grid/journal', {ops: [{type: 'meta', description: 'live 1'}], expectedLastSeq: 0})
            const b1 = await as('smoke-b', 'POST', '/api/networks/smoke_grid/journal', {ops: [{type: 'meta', description: 'live 2'}, {type: 'meta', description: 'live 3'}], expectedLastSeq: 1})
            r = await call('GET', '/api/networks/smoke_grid/journal?after=1')
            check(a1.lastSeq === 1 && typeof a1.startedAt === 'string' && b1.startedAt === a1.startedAt && r.json.entries.map((e: any) => e.seq).join() === '2,3'
                && r.json.lastSeq === 3 && r.json.startedAt === a1.startedAt && r.json.savedRevision === 1, 'journal?after= returns the newer entries with the journal epoch', r.json)
            check(seen.length === 2 && seen[0].type === 'journal' && seen[0].client === 'smoke-a' && seen[1].client === 'smoke-b' && seen[1].lastSeq === 3, 'appends emit change events naming the client', seen)
            r = await call('GET', '/api/networks/smoke_grid/journal?after=x')
            check(r.status === 400, 'journal?after= must be a whole number')
            // the same events as server-sent events over HTTP
            const ac = new AbortController()
            const timer = setTimeout(() => ac.abort(), 5000)
            const stream = await fetch(base + '/api/networks/smoke_grid/events', {signal: ac.signal})
            const reader = stream.body!.getReader()
            await as('smoke-a', 'POST', '/api/networks/smoke_grid/journal', {ops: [{type: 'meta', description: 'live 4'}]})
            let text = ''
            try {
                while (!text.includes('"lastSeq":4')) {
                    const {value, done} = await reader.read()
                    if (done) break
                    text += new TextDecoder().decode(value)
                }
            } catch {
                // aborted by the timer: checked below
            }
            clearTimeout(timer)
            ac.abort()
            check(stream.headers.get('content-type')?.startsWith('text/event-stream') === true && text.includes('"type":"journal"') && text.includes('"client":"smoke-a"'), 'events stream journal appends as server-sent events', text)
            await as('smoke-b', 'DELETE', '/api/networks/smoke_grid/journal')
            check(seen.at(-1)?.type === 'discarded' && seen.at(-1)?.client === 'smoke-b', 'discard emits a change event', seen.at(-1))
            ctx.networkService.events.off('change', onChange)
        }

        r = await call('POST', '/api/networks/smoke_grid/journal', {ops: [{type: 'meta', name: 'Renamed grid'}]})
        r = await call('POST', '/api/networks/smoke_grid/save')
        check(r.status === 200 && r.json.document.revision === 2 && r.json.document.name === 'Renamed grid', 'second save -> revision 2')

        r = await call('GET', '/api/networks/smoke_grid/versions')
        check(r.status === 200 && r.json.length === 2 && r.json[1].stamp === v0 && r.json[0].revision === 1, 'versions listed newest first', r.json)

        r = await call('POST', `/api/networks/smoke_grid/versions/${v0}/rollback`)
        check(r.status === 200 && r.json.document.revision === 3 && r.json.document.circuits.length === 0 && r.json.document.name === 'Smoke Grid', 'rollback to initial version -> revision 3, empty grid')

        r = await call('GET', '/api/networks/smoke_grid/versions/not-a-stamp')
        check(r.status === 400, 'bad stamp -> 400')

        r = await call('GET', '/api/networks/smoke_grid/versions')
        check(r.status === 200 && r.json.length === 3, 'three versions archived after rollback', r.json)
        const newest = r.json[0].stamp
        r = await call('DELETE', '/api/networks/smoke_grid/versions?keep=1')
        check(r.status === 200 && r.json.deleted === 2 && r.json.kept === 1 && r.json.stamps.length === 2 && !r.json.stamps.includes(newest), 'purge keeping the newest version', r.json)
        r = await call('GET', '/api/networks/smoke_grid/versions')
        check(r.status === 200 && r.json.length === 1 && r.json[0].stamp === newest, 'newest version survives the purge', r.json)
        r = await call('DELETE', '/api/networks/smoke_grid/versions?keep=x')
        check(r.status === 400, 'purge with a malformed keep -> 400')
        r = await call('DELETE', '/api/networks/smoke_grid/versions')
        check(r.status === 200 && r.json.deleted === 1 && r.json.kept === 0, 'purge all', r.json)
        r = await call('GET', '/api/networks/smoke_grid/versions')
        check(r.status === 200 && r.json.length === 0, 'history empty after purge')
        r = await call('GET', '/api/networks/smoke_grid')
        check(r.status === 200 && r.json.revision === 3, 'current document untouched by the purge')

        r = await call('GET', '/api/networks/smoke_grid/export?download=true')
        check(r.status === 200 && r.json.format === 'thgrid.network', 'export document')
        const exported = r.json

        r = await call('POST', '/api/networks/import', {...exported, id: undefined, name: 'Imported grid'})
        check(r.status === 201 && r.json.document.id === 'imported_grid', 'import as new network -> 201', r.json)

        r = await call('POST', '/api/networks/import', exported)
        check(r.status === 409, 'import over existing without overwrite -> 409')

        r = await call('POST', '/api/networks/import?overwrite=true', {...exported, paths: undefined, circuits: [{id: 'Z', name: 'Z', path: [{latitude: 1, longitude: 2}]}]})
        check(r.status === 200 && r.json.replaced && r.json.document.revision === 4 && r.json.document.circuits.length === 1, 'import with overwrite archives and bumps revision')
        check(r.json.document.paths.length === 1 && r.json.document.circuits[0].pathId === r.json.document.paths[0].id && r.json.document.paths[0].waypoints.length === 1 && r.json.document.circuits[0].path === undefined, 'legacy circuit waypoints migrated into a transmission path', r.json.document.paths)

        r = await call('POST', '/api/networks/import', {...exported, id: 'bad_doc', connections: [{id: 'q', scope: 'SUBSTATION', junction: {kind: 'SUBSTATION', id: 'nope'}, nodes: [{kind: 'SUBSTATION_BUS', id: 'b'}]}]})
        check(r.status === 422, 'import invalid document -> 422')

        r = await call('GET', '/api/networks')
        check(r.status === 200 && r.json.length === 2 && r.json.every((n: any) => n.journalEntries === 0), 'list networks with journal counts')

        r = await call('DELETE', '/api/networks/imported_grid')
        check(r.status === 200 && r.json.archivedVersion, 'delete network archives it')

        const history = await fs.readdir(path.join(dataDir, 'networks', 'history'))
        check(history.filter(f => f.startsWith('smoke_grid.')).length === 1 && history.some(f => f.startsWith('imported_grid.')), 'history files: one archived by the overwrite import after the purge, one by the delete', history)
    } finally {
        server.close()
        await fs.rm(dataDir, {recursive: true, force: true})
    }

    console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed')
    process.exit(failures ? 1 : 0)
}

main().catch(err => {
    console.error(err)
    process.exit(1)
})
