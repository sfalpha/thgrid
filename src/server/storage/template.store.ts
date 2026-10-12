import path from "node:path";
import {JsonFileStore} from "./json.file.store";
import {TemplateKind, TemplateRecord, TemplateRef, templateKinds} from "../../templates/template";
import {getTemplateKindDefinition} from "../../templates/registry";
import {TemplateLookup} from "../../templates/resolve";
import {ValidationContext} from "../../templates/validation";

/** Renames of stored enum values: files written by older versions are read as the current names. */
const WINDING_SIDE_RENAME: Record<string, string> = {HIGH_SIDE: 'PRIMARY', LOW_SIDE: 'SECONDARY'}

/** Normalizes a template file on read (power transformer winding sides HIGH_SIDE / LOW_SIDE → PRIMARY / SECONDARY; bay equipment flag takeOff → lineSide). */
export function normalizeTemplateRecord<K extends TemplateKind>(record: TemplateRecord<K>): TemplateRecord<K> {
    if (record.kind === TemplateKind.SUBSTATION_BAY) {
        const data = record.data as unknown as { equipments?: Record<string, unknown>[] }
        if (!data || !Array.isArray(data.equipments) || !data.equipments.some(e => e && typeof e === 'object' && 'takeOff' in e)) return record
        const equipments = data.equipments.map(e => {
            if (!e || typeof e !== 'object' || !('takeOff' in e)) return e
            const {takeOff, ...rest} = e
            return takeOff ? {...rest, lineSide: true} : rest
        })
        return {...record, data: {...(record.data as object), equipments}} as unknown as TemplateRecord<K>
    }
    if (record.kind !== TemplateKind.POWER_TRANSFORMER) return record
    const data = record.data as unknown as { windings?: Record<string, { windingSide?: string }> }
    if (!data || typeof data !== 'object' || !data.windings || typeof data.windings !== 'object') return record
    let touched = false
    const windings: Record<string, unknown> = {}
    for (const [key, w] of Object.entries(data.windings)) {
        const side = w && typeof w === 'object' ? w.windingSide : undefined
        if (side && WINDING_SIDE_RENAME[side]) {
            touched = true
            windings[key] = {...w, windingSide: WINDING_SIDE_RENAME[side]}
        } else windings[key] = w
    }
    return touched ? {...record, data: {...(record.data as object), windings}} as TemplateRecord<K> : record
}

/** One `JsonFileStore` per template kind, under `<dataDir>/templates/<kind directory>/`. */
export class TemplateStore {
    private readonly stores = new Map<TemplateKind, JsonFileStore<TemplateRecord>>()

    constructor(public readonly rootDirectory: string) {
        for (const kind of templateKinds) {
            const def = getTemplateKindDefinition(kind)
            this.stores.set(kind, new JsonFileStore<TemplateRecord>(path.join(rootDirectory, def.directory)))
        }
    }

    async init(): Promise<void> {
        await Promise.all([...this.stores.values()].map(s => s.init()))
    }

    store<K extends TemplateKind>(kind: K): JsonFileStore<TemplateRecord<K>> {
        const s = this.stores.get(kind)
        if (!s) throw new Error(`No store for template kind ${String(kind)}`)
        return s as unknown as JsonFileStore<TemplateRecord<K>>
    }

    async list<K extends TemplateKind>(kind: K): Promise<TemplateRecord<K>[]> {
        return (await this.store(kind).list()).map(normalizeTemplateRecord)
    }

    async listAll(): Promise<TemplateRecord[]> {
        const lists = await Promise.all(templateKinds.map(k => this.list(k)))
        return lists.flat()
    }

    async get<K extends TemplateKind>(kind: K, id: string): Promise<TemplateRecord<K> | undefined> {
        const record = await this.store(kind).get(id)
        return record ? normalizeTemplateRecord(record) : undefined
    }

    async exists(ref: TemplateRef): Promise<boolean> {
        return this.store(ref.kind).exists(ref.id)
    }

    async put(record: TemplateRecord): Promise<void> {
        await this.store(record.kind).put(record)
    }

    async delete(kind: TemplateKind, id: string): Promise<boolean> {
        return this.store(kind).delete(id)
    }

    /**
     * Snapshot of every template, as a synchronous lookup for validators and
     * resolvers. Taken once per request so a request sees a consistent view.
     */
    async snapshot(): Promise<TemplateSnapshot> {
        return new TemplateSnapshot(await this.listAll())
    }
}

export class TemplateSnapshot implements TemplateLookup, ValidationContext {
    private readonly index = new Map<string, TemplateRecord>()

    constructor(public readonly records: TemplateRecord[]) {
        for (const r of records) this.index.set(TemplateSnapshot.key(r), r)
    }

    static key(ref: TemplateRef): string {
        return `${ref.kind}:${ref.id}`
    }

    get<K extends TemplateKind>(ref: TemplateRef<K>): TemplateRecord<K> | undefined {
        return this.index.get(TemplateSnapshot.key(ref)) as TemplateRecord<K> | undefined
    }

    exists(ref: TemplateRef): boolean {
        return this.index.has(TemplateSnapshot.key(ref))
    }

    /** Templates whose payload references `ref`. */
    referencedBy(ref: TemplateRef): TemplateRecord[] {
        return this.records.filter(r =>
            getTemplateKindDefinition(r.kind).references(r.data).some(x => x.kind === ref.kind && x.id === ref.id))
    }
}
