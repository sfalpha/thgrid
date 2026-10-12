/**
 * Storage of networks:
 *
 *   <root>/<id>.json                      current saved document
 *   <root>/history/<id>.<stamp>.json      previous versions (written whenever the current file is replaced)
 *   <root>/journal/<id>.json              unsaved ops since the current document was saved
 *
 * `<stamp>` is the UTC time of archival, `YYYYMMDDTHHMMSSmmmZ`, so versions sort by name.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {JsonFileStore} from "./json.file.store";
import {NetworkDocument} from "../../network/records";
import {NetworkJournal} from "../../network/ops";
import {TEMPLATE_ID_PATTERN} from "../../templates/template";

export interface StoredJournal extends NetworkJournal {
    id: string
}

export interface NetworkVersionInfo {
    stamp: string
    /** When the version was archived (moved to history). */
    archivedAt: string
    /** Metadata of the archived document. */
    revision: number
    updatedAt: string
    name: string
    bytes: number
}

const STAMP_PATTERN = /^\d{8}T\d{9}Z$/

export function makeStamp(date = new Date()): string {
    return date.toISOString().replace(/[-:.]/g, '')  // 2026-10-08T14:02:50.356Z -> 20261008T140250356Z
}

export function stampToIso(stamp: string): string {
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z$/.exec(stamp)
    if (!m) return stamp
    return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z`
}

export class NetworkStore {
    readonly documents: JsonFileStore<NetworkDocument>
    readonly journals: JsonFileStore<StoredJournal>
    readonly historyDirectory: string

    constructor(public readonly rootDirectory: string) {
        this.documents = new JsonFileStore<NetworkDocument>(rootDirectory)
        this.journals = new JsonFileStore<StoredJournal>(path.join(rootDirectory, 'journal'))
        this.historyDirectory = path.join(rootDirectory, 'history')
    }

    async init(): Promise<void> {
        await Promise.all([this.documents.init(), this.journals.init(), fs.mkdir(this.historyDirectory, {recursive: true})])
    }

    /* ---- current documents ---- */

    list(): Promise<NetworkDocument[]> {
        return this.documents.list()
    }

    get(id: string): Promise<NetworkDocument | undefined> {
        return this.documents.get(id)
    }

    exists(id: string): Promise<boolean> {
        return this.documents.exists(id)
    }

    /** Archives the current file (if any) to history, then writes `doc`. Returns the archive stamp. */
    async save(doc: NetworkDocument): Promise<string | undefined> {
        const stamp = await this.archiveCurrent(doc.id)
        await this.documents.put(doc)
        return stamp
    }

    /** Archives the current file and removes it together with its journal. */
    async delete(id: string): Promise<string | undefined> {
        const stamp = await this.archiveCurrent(id)
        await this.documents.delete(id)
        await this.journals.delete(id)
        return stamp
    }

    private async archiveCurrent(id: string): Promise<string | undefined> {
        if (!TEMPLATE_ID_PATTERN.test(id)) throw new Error(`Unsafe network id "${id}"`)
        const current = this.documents.filePath(id)
        try {
            await fs.access(current)
        } catch {
            return undefined
        }
        await fs.mkdir(this.historyDirectory, {recursive: true})
        let stamp = makeStamp()
        // Two saves within the same millisecond: bump until free.
        while (await this.historyExists(id, stamp)) stamp = makeStamp(new Date(Date.now() + 1))
        await fs.copyFile(current, this.historyPath(id, stamp))
        return stamp
    }

    /* ---- history ---- */

    historyPath(id: string, stamp: string): string {
        if (!TEMPLATE_ID_PATTERN.test(id) || !STAMP_PATTERN.test(stamp)) throw new Error(`Unsafe history reference "${id}" / "${stamp}"`)
        return path.join(this.historyDirectory, `${id}.${stamp}.json`)
    }

    private async historyExists(id: string, stamp: string): Promise<boolean> {
        try {
            await fs.access(this.historyPath(id, stamp))
            return true
        } catch {
            return false
        }
    }

    async listVersions(id: string): Promise<NetworkVersionInfo[]> {
        let entries: string[]
        try {
            entries = await fs.readdir(this.historyDirectory)
        } catch {
            return []
        }
        const prefix = `${id}.`
        const versions: NetworkVersionInfo[] = []
        for (const f of entries) {
            if (!f.startsWith(prefix) || !f.endsWith('.json')) continue
            const stamp = f.slice(prefix.length, -'.json'.length)
            if (!STAMP_PATTERN.test(stamp)) continue
            const file = this.historyPath(id, stamp)
            try {
                const [raw, stat] = await Promise.all([fs.readFile(file, 'utf8'), fs.stat(file)])
                const doc = JSON.parse(raw) as NetworkDocument
                versions.push({stamp, archivedAt: stampToIso(stamp), revision: doc.revision, updatedAt: doc.updatedAt, name: doc.name, bytes: stat.size})
            } catch {
                versions.push({stamp, archivedAt: stampToIso(stamp), revision: -1, updatedAt: '', name: '(unreadable)', bytes: 0})
            }
        }
        return versions.sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0))
    }

    async getVersion(id: string, stamp: string): Promise<NetworkDocument | undefined> {
        try {
            return JSON.parse(await fs.readFile(this.historyPath(id, stamp), 'utf8')) as NetworkDocument
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined
            throw e
        }
    }

    /** Deletes archived versions beyond the newest `keep` (0 = all of them). Returns the stamps removed, newest first. */
    async purgeVersions(id: string, keep: number): Promise<string[]> {
        const doomed = (await this.listVersions(id)).slice(Math.max(0, keep))
        await Promise.all(doomed.map(v => fs.rm(this.historyPath(id, v.stamp), {force: true})))
        return doomed.map(v => v.stamp)
    }

    /* ---- journal ---- */

    async getJournal(id: string): Promise<NetworkJournal | undefined> {
        const stored = await this.journals.get(id)
        if (!stored) return undefined
        const {id: _ignored, ...journal} = stored
        return journal
    }

    putJournal(journal: NetworkJournal): Promise<void> {
        return this.journals.put({id: journal.networkId, ...journal})
    }

    deleteJournal(id: string): Promise<boolean> {
        return this.journals.delete(id)
    }
}
