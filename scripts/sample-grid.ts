/**
 * Makes the sample grid from a network: a site, the lines connected to it and the sites one line away
 * (`extractAround`), by default PDG (Pluak Daeng) in the EGAT network. Writes the result to
 * `scripts/sample-grid.json` (what `npm run seed` seeds the `sample_grid` network from) and replaces the `sample_grid`
 * network with it.
 *
 * Usage: npm run sample:grid                                  (PDG, 1 hop, from the network `egat`)
 *        npm run sample:grid -- --site <code> --hops <n> --from <network id>
 *
 * With the backend running (PORT, default 3300) the network is replaced through the API (an import with overwrite: the
 * old version is archived, the journal discarded), so open editors pick it up; otherwise the files in `data/networks`
 * are written directly (the old version archived too).
 */
import fs from "node:fs/promises";
import path from "node:path";
import {dataLayout, loadConfig, repoRoot} from "../src/server/config";
import {NetworkStore} from "../src/server/storage/network.store";
import {migrateNetworkDocument} from "../src/network/migrate";
import {validateNetworkDocument} from "../src/network/validation";
import {extractAround} from "../src/network/extract";
import {NetworkDocument} from "../src/network/records";

const arg = (name: string, fallback: string) => {
    const i = process.argv.indexOf(`--${name}`)
    return i >= 0 ? process.argv[i + 1] ?? fallback : fallback
}
const SITE = arg('site', 'PDG')
const HOPS = Number(arg('hops', '1'))
const FROM = arg('from', 'egat')
const ID = 'sample_grid'
/** The snapshot `npm run seed` writes the sample grid from. */
const SAMPLE_GRID_FILE = path.join(repoRoot, 'scripts', 'sample-grid.json')

async function source(): Promise<NetworkDocument> {
    const {dataDir} = loadConfig()
    const store = new NetworkStore(path.join(dataDir, dataLayout.networks))
    await store.init()
    const doc = await store.get(FROM)
    if (!doc) throw new Error(`network ${FROM} not found in ${store.rootDirectory}`)
    const journal = await store.getJournal(FROM)
    if (journal?.entries.length) console.warn(`network ${FROM} has ${journal.entries.length} unsaved journal entries: the sample is taken from its last saved version (revision ${doc.revision})`)
    return migrateNetworkDocument(doc).doc
}

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

async function main() {
    if (!Number.isInteger(HOPS) || HOPS < 1) throw new Error(`--hops must be a whole number from 1, not ${HOPS}`)
    const from = await source()
    const site = from.substationGroups.find(g => g.groupName === SITE || g.id === SITE)
    if (!site) throw new Error(`site ${SITE} not found in ${FROM}`)
    const {doc: part, sitesByHop} = extractAround(from, site.id, HOPS)
    const now = new Date().toISOString()
    const label = (id: string) => from.substationGroups.find(g => g.id === id)?.groupName ?? id
    const doc: NetworkDocument = {
        ...part,
        id: ID,
        name: 'Sample grid',
        description: `${site.groupName}${site.name ? ` (${site.name})` : ''}, the lines connected to it and the sites ${HOPS === 1 ? 'one line' : `up to ${HOPS} lines`} away: ${sitesByHop.slice(1).flat().map(label).join(', ')}. Taken from the network ${FROM} (revision ${from.revision}) by npm run sample:grid.`,
        revision: 0,
        createdAt: now,
        updatedAt: now,
    }
    const issues = validateNetworkDocument(doc).filter(i => i.severity !== 'warning')
    if (issues.length) throw new Error(`the sample is invalid: ${JSON.stringify(issues.slice(0, 5))}`)
    await fs.writeFile(SAMPLE_GRID_FILE, JSON.stringify(doc, null, 2) + '\n')
    console.log(`${path.relative(process.cwd(), SAMPLE_GRID_FILE)}: ${doc.substationGroups.length} sites, ${doc.lines.length} lines, ${doc.circuits.length} circuits, ${doc.junctions.length} junctions (from ${FROM} revision ${from.revision}, around ${site.groupName}, ${HOPS} hop${HOPS === 1 ? '' : 's'})`)

    const base = await runningBackend()
    if (base) {
        const res = await fetch(`${base}/api/networks/import?id=${ID}&overwrite=true`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(doc)})
        if (!res.ok) throw new Error(`import failed: ${res.status} ${await res.text()}`)
        const {document, replaced, archivedVersion} = await res.json() as { document: NetworkDocument; replaced: boolean; archivedVersion?: string }
        console.log(`network ${ID}: ${replaced ? 'replaced' : 'created'} through ${base} (revision ${document.revision}${archivedVersion ? `, the old version archived as ${archivedVersion}` : ''})`)
    } else {
        const {dataDir} = loadConfig()
        const store = new NetworkStore(path.join(dataDir, dataLayout.networks))
        await store.init()
        const old = await store.get(ID)
        const archived = await store.save({...doc, revision: old ? old.revision + 1 : 0, createdAt: old?.createdAt ?? now})
        await store.deleteJournal(ID)
        console.log(`network ${ID}: ${old ? 'replaced' : 'created'} in ${store.rootDirectory}${archived ? ` (the old version archived as ${archived})` : ''}`)
    }
}

main().catch(err => {
    console.error(err)
    process.exit(1)
})
