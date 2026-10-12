/**
 * One-off data migration: keeps the substation and junction data of a network
 * and discards all circuits, transmission paths (waypoints) and the
 * TRANSMISSION-scope connections that referenced the circuits. Substation
 * wiring (SUBSTATION-scope connections), take-offs and lines are kept.
 *
 * The current file is archived under data/networks/history before it is
 * replaced, the revision is bumped and any journal is discarded.
 *
 * Usage: npx tsx scripts/strip-circuits.ts <network id>
 */
import path from "node:path";
import {dataLayout, loadConfig} from "../src/server/config";
import {NetworkStore} from "../src/server/storage/network.store";
import {ConnectionScope, NetworkDocument} from "../src/network/records";
import {migrateNetworkDocument} from "../src/network/migrate";
import {validateNetworkDocument} from "../src/network/validation";

async function main() {
    const id = process.argv[2]
    if (!id) throw new Error('usage: npx tsx scripts/strip-circuits.ts <network id>')
    const config = loadConfig()
    const store = new NetworkStore(path.join(config.dataDir, dataLayout.networks))
    await store.init()
    const current = await store.get(id)
    if (!current) throw new Error(`network "${id}" not found in ${store.rootDirectory}`)
    const before = migrateNetworkDocument(current).doc

    const next: NetworkDocument = {
        ...before,
        paths: [],
        circuits: [],
        connections: before.connections.filter(c => c.scope === ConnectionScope.SUBSTATION),
        revision: before.revision + 1,
        updatedAt: new Date().toISOString(),
    }
    const issues = validateNetworkDocument(next)
    if (issues.length) throw new Error(`result would be invalid: ${JSON.stringify(issues, null, 2)}`)

    const archived = await store.save(next)
    const journal = await store.getJournal(id)
    await store.deleteJournal(id)

    console.log(`network ${id}: revision ${before.revision} -> ${next.revision}${archived ? `, previous version archived as ${archived}` : ''}`)
    console.log(`  removed: ${before.circuits.length} circuits, ${(before.paths ?? []).length} paths, ${before.connections.length - next.connections.length} transmission connections${journal?.entries.length ? `, ${journal.entries.length} journal entries` : ''}`)
    console.log(`  kept: ${next.substationGroups.length} sites, ${next.substations.length} yards, ${next.buses.length} buses, ${next.bays.length} bays, ${next.equipments.length} equipment, ${next.takeOffs.length} take-offs, ${next.junctions.length} junctions, ${next.lines.length} lines, ${next.connections.length} substation connections`)
}

main().catch(err => {
    console.error(err.message ?? err)
    process.exit(1)
})
