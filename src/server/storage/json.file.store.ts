/**
 * Generic "one JSON file per document" store.
 *
 * - Documents live as `<dir>/<id>.json`, pretty printed so they diff well in git.
 * - Writes are atomic (temp file + rename) so a crash never leaves a half file.
 * - Reads always go to disk, so files edited by hand are picked up immediately.
 *   The data set is small (hundreds of files at most) so no index is kept.
 *
 * The same class will back the future network records (`data/network/*`).
 */
import fs from "node:fs/promises";
import path from "node:path";
import {TEMPLATE_ID_PATTERN} from "../../templates/template";

export interface StoredDocument {
    id: string
}

export class JsonFileStore<T extends StoredDocument> {
    constructor(public readonly directory: string) {
    }

    async init(): Promise<void> {
        await fs.mkdir(this.directory, {recursive: true})
    }

    filePath(id: string): string {
        if (!TEMPLATE_ID_PATTERN.test(id)) throw new Error(`Refusing to build a path from unsafe id "${id}"`)
        return path.join(this.directory, `${id}.json`)
    }

    async ids(): Promise<string[]> {
        let entries: string[]
        try {
            entries = await fs.readdir(this.directory)
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
            throw e
        }
        return entries
            .filter(f => f.endsWith('.json'))
            .map(f => f.slice(0, -'.json'.length))
            .filter(id => TEMPLATE_ID_PATTERN.test(id))
            .sort()
    }

    async exists(id: string): Promise<boolean> {
        try {
            await fs.access(this.filePath(id))
            return true
        } catch {
            return false
        }
    }

    async get(id: string): Promise<T | undefined> {
        let raw: string
        try {
            raw = await fs.readFile(this.filePath(id), 'utf8')
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined
            throw e
        }
        try {
            return JSON.parse(raw) as T
        } catch (e) {
            throw new Error(`Corrupt JSON in ${this.filePath(id)}: ${(e as Error).message}`)
        }
    }

    async list(): Promise<T[]> {
        const ids = await this.ids()
        const docs: (T | undefined)[] = await Promise.all(ids.map(id => this.get(id)))
        const result: T[] = []
        for (const d of docs) if (d !== undefined) result.push(d)
        return result
    }

    async put(doc: T): Promise<void> {
        await fs.mkdir(this.directory, {recursive: true})
        const target = this.filePath(doc.id)
        const tmp = `${target}.${process.pid}.${Date.now()}.tmp`
        await fs.writeFile(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8')
        await fs.rename(tmp, target)
    }

    async delete(id: string): Promise<boolean> {
        try {
            await fs.unlink(this.filePath(id))
            return true
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false
            throw e
        }
    }
}
