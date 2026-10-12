import {
    isTemplateKind,
    slugifyTemplateId,
    TemplateInput,
    TemplateKind,
    TemplateRecord,
    TemplateRef,
    TemplateSummary,
    toTemplateSummary,
} from "../../templates/template";
import {getTemplateKindDefinition} from "../../templates/registry";
import {validateTemplateEnvelope, validateTemplateId, ValidationIssue} from "../../templates/validation";
import {resolveTemplate, ResolvedTemplateByKind} from "../../templates/resolve";
import {toCollectionSummary, TemplateCollectionSummary} from "../../templates/collection";
import {TemplateStore} from "../storage/template.store";
import {CollectionStore} from "../storage/collection.store";
import {BadRequestError, ConflictError, NotFoundError, ValidationError} from "../errors";

export interface TemplateUsage {
    templates: TemplateSummary[]
    collections: TemplateCollectionSummary[]
}

export interface DeleteOptions {
    /** Delete even when referenced; the template is pruned from collections, dependent templates are left dangling. */
    force?: boolean
}

export class TemplateService {
    constructor(
        private readonly templates: TemplateStore,
        private readonly collections: CollectionStore,
    ) {
    }

    static parseKind(value: string): TemplateKind {
        if (!isTemplateKind(value)) throw new BadRequestError(`Unknown template kind "${value}"`)
        return value
    }

    async list(kind?: TemplateKind): Promise<TemplateSummary[]> {
        const records = kind ? await this.templates.list(kind) : await this.templates.listAll()
        return records.map(toTemplateSummary).sort((a, b) => a.name.localeCompare(b.name))
    }

    async get<K extends TemplateKind>(kind: K, id: string): Promise<TemplateRecord<K>> {
        const record = await this.templates.get(kind, id)
        if (!record) throw new NotFoundError(`Template ${kind}/${id}`)
        return record
    }

    /** Validates envelope + payload against the current data set. Returns issues instead of throwing. */
    async validate(kind: TemplateKind, input: unknown): Promise<ValidationIssue[]> {
        const envelopeIssues = validateTemplateEnvelope(input)
        if (envelopeIssues.some(i => i.path === '' || i.path === 'data')) return envelopeIssues
        const snapshot = await this.templates.snapshot()
        const data = (input as TemplateInput).data
        const dataIssues = getTemplateKindDefinition(kind).validate(data, snapshot).map(i => ({...i, path: i.path ? `data.${i.path}` : 'data'}))
        return [...envelopeIssues, ...dataIssues]
    }

    async create<K extends TemplateKind>(kind: K, input: unknown): Promise<TemplateRecord<K>> {
        const issues = await this.validate(kind, input)
        if (issues.length) throw new ValidationError(issues)
        const body = input as TemplateInput<K>
        const id = body.id ?? slugifyTemplateId(String((body.data as { name: string }).name))
        const idIssues = validateTemplateId(id)
        if (idIssues.length) throw new ValidationError(idIssues, `Could not derive a valid id from the name; supply "id" explicitly`)
        if (await this.templates.store(kind).exists(id)) throw new ConflictError(`Template ${kind}/${id} already exists`)
        const now = new Date().toISOString()
        const record: TemplateRecord<K> = {
            id,
            kind,
            description: body.description,
            tags: body.tags,
            createdAt: now,
            updatedAt: now,
            data: body.data,
        }
        await this.templates.put(record)
        return record
    }

    async update<K extends TemplateKind>(kind: K, id: string, input: unknown): Promise<TemplateRecord<K>> {
        const existing = await this.get(kind, id)
        const body = input as TemplateInput<K>
        if (body && typeof body === 'object' && body.id !== undefined && body.id !== id) {
            throw new BadRequestError(`Template ids are immutable (body.id "${body.id}" differs from "${id}")`)
        }
        const issues = await this.validate(kind, input)
        if (issues.length) throw new ValidationError(issues)
        const record: TemplateRecord<K> = {
            ...existing,
            description: body.description,
            tags: body.tags,
            updatedAt: new Date().toISOString(),
            data: body.data,
        }
        await this.templates.put(record)
        return record
    }

    async usage(ref: TemplateRef): Promise<TemplateUsage> {
        const snapshot = await this.templates.snapshot()
        const collections = await this.collections.referencing(ref)
        return {
            templates: snapshot.referencedBy(ref).map(toTemplateSummary),
            collections: collections.map(toCollectionSummary),
        }
    }

    async delete(kind: TemplateKind, id: string, opts: DeleteOptions = {}): Promise<TemplateUsage> {
        await this.get(kind, id)
        const ref: TemplateRef = {kind, id}
        const usage = await this.usage(ref)
        const referenced = usage.templates.length + usage.collections.length > 0
        if (referenced && !opts.force) {
            throw new ConflictError(`Template ${kind}/${id} is referenced by other templates or collections; pass ?force=true to delete anyway`, usage)
        }
        if (opts.force) {
            for (const summary of usage.collections) {
                const collection = await this.collections.get(summary.id)
                if (!collection) continue
                collection.items = collection.items.filter(i => !(i.kind === kind && i.id === id))
                collection.updatedAt = new Date().toISOString()
                await this.collections.put(collection)
            }
        }
        await this.templates.delete(kind, id)
        return usage
    }

    /** Factory-ready form with references embedded. */
    async resolve<K extends TemplateKind>(kind: K, id: string): Promise<ResolvedTemplateByKind[K]> {
        const record = await this.get(kind, id)
        const snapshot = await this.templates.snapshot()
        return resolveTemplate(record, snapshot)
    }
}
