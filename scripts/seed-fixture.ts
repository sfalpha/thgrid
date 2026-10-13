/**
 * Seeds a network from the test fixture (`web/test/fixture.ts`, docs/testing.md "Fixture"), to try the wizards and
 * operations by hand on the same sites and junctions the tests use.
 *
 * Usage: npm run seed:fixture                 (network `test_fixture`)
 *        npm run seed:fixture -- --id <id>    (another network id)
 *
 * Every run starts over: the network is replaced and its journal and every archived version are removed. With the
 * backend running (PORT, default 3300) it goes through the API, so open editors pick the new network up (an import
 * with overwrite, then a purge of all versions; the revision continues from the replaced one); otherwise the files in
 * `data/networks` are written directly (revision 0).
 */
import path from "node:path";
import {dataLayout, loadConfig} from "../src/server/config";
import {NetworkStore} from "../src/server/storage/network.store";
import {validateNetworkDocument} from "../src/network/validation";
import {validateTemplateId} from "../src/templates/validation";
import {NetworkDocument} from "../src/network/records";
import {lineFixture} from "../web/test/fixture";

const argId = process.argv.indexOf('--id')
const id = argId >= 0 ? process.argv[argId + 1] ?? '' : 'test_fixture'

function fixtureNetwork(): NetworkDocument {
    const now = new Date().toISOString()
    return {
        ...lineFixture(),
        id,
        name: 'Test fixture',
        description: 'The network the creation tests run on (web/test/fixture.ts, docs/testing.md "Fixture"), seeded by npm run seed:fixture.',
        revision: 0,
        createdAt: now,
        updatedAt: now,
    }
}

/** The backend's base URL when it answers, else undefined. */
async function runningBackend(): Promise<string | undefined> {
    const {port} = loadConfig()
    const base = `http://127.0.0.1:${port}`
    try {
        const res = await fetch(`${base}/api/networks`, {signal: AbortSignal.timeout(1500)})
        return res.ok ? base : undefined
    } catch {
        return undefined
    }
}

async function viaApi(base: string, doc: NetworkDocument) {
    const imported = await fetch(`${base}/api/networks/import?id=${encodeURIComponent(id)}&overwrite=true`, {
        method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(doc),
    })
    if (!imported.ok) throw new Error(`import failed: ${imported.status} ${await imported.text()}`)
    const {document, replaced} = await imported.json() as { document: NetworkDocument; replaced: boolean }
    const purged = await fetch(`${base}/api/networks/${encodeURIComponent(id)}/versions?keep=0`, {method: 'DELETE'})
    if (!purged.ok) throw new Error(`purging the versions failed: ${purged.status} ${await purged.text()}`)
    const {deleted} = await purged.json() as { deleted: number }
    console.log(`network ${id}: ${replaced ? 'replaced' : 'created'} through ${base} (revision ${document.revision}), journal cleared, ${deleted} archived version(s) removed`)
}

async function viaFiles(doc: NetworkDocument) {
    const {dataDir} = loadConfig()
    const store = new NetworkStore(path.join(dataDir, dataLayout.networks))
    await store.init()
    const existed = await store.documents.delete(id)
    await store.deleteJournal(id)
    const removed = await store.purgeVersions(id, 0)
    await store.save(doc)
    console.log(`network ${id}: ${existed ? 'replaced' : 'created'} in ${store.rootDirectory} (revision 0), journal cleared, ${removed.length} archived version(s) removed`)
}

async function main() {
    const idIssues = validateTemplateId(id)
    if (idIssues.length) throw new Error(`invalid network id "${id}": ${idIssues.map(i => i.message).join('; ')}`)
    const doc = fixtureNetwork()
    const issues = validateNetworkDocument(doc)
    if (issues.length) throw new Error(`the fixture is invalid: ${JSON.stringify(issues)}`)
    const base = await runningBackend()
    if (base) await viaApi(base, doc)
    else await viaFiles(doc)
}

main().catch(err => {
    console.error(err)
    process.exit(1)
})
