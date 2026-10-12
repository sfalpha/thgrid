import {
    TemplateBundle,
    TemplateCollection,
    TemplateCollectionInput,
    TemplateCollectionSummary,
    toCollectionSummary,
} from "../../templates/collection";
import {slugifyTemplateId, TemplateRecord, TemplateRef} from "../../templates/template";
import {validateCollectionInput, validateTemplateId, ValidationIssue} from "../../templates/validation";
import {getTemplateKindDefinition} from "../../templates/registry";
import {lookupFromRecords} from "../../templates/resolve";
import {TemplateStore} from "../storage/template.store";
import {CollectionStore} from "../storage/collection.store";
import {BadRequestError, ConflictError, NotFoundError, ValidationError} from "../errors";

export interface ImportOptions {
    /** Overwrite templates/collection that already exist. Default: fail with 409 on the first clash. */
    overwrite?: boolean
}

export interface ImportResult {
    collection: TemplateCollectionSummary
    created: TemplateRef[]
    overwritten: TemplateRef[]
    skipped: TemplateRef[]
}

export class CollectionService {
    constructor(
        private readonly templates: TemplateStore,
        private readonly collections: CollectionStore,
    ) {
    }

    async list(): Promise<TemplateCollectionSummary[]> {
        const all = await this.collections.list()
        return all.map(toCollectionSummary).sort((a, b) => a.name.localeCompare(b.name))
    }

    async get(id: string): Promise<TemplateCollection> {
        const c = await this.collections.get(id)
        if (!c) throw new NotFoundError(`Collection ${id}`)
        return c
    }

    async validate(input: unknown): Promise<ValidationIssue[]> {
        const snapshot = await this.templates.snapshot()
        return validateCollectionInput(input, snapshot)
    }

    async create(input: unknown): Promise<TemplateCollection> {
        const issues = await this.validate(input)
        if (issues.length) throw new ValidationError(issues)
        const body = input as TemplateCollectionInput
        const id = body.id ?? slugifyTemplateId(body.name)
        const idIssues = validateTemplateId(id)
        if (idIssues.length) throw new ValidationError(idIssues, 'Could not derive a valid id from the name; supply "id" explicitly')
        if (await this.collections.exists(id)) throw new ConflictError(`Collection ${id} already exists`)
        const now = new Date().toISOString()
        const collection: TemplateCollection = {
            id,
            name: body.name,
            description: body.description,
            tags: body.tags,
            items: body.items ?? [],
            createdAt: now,
            updatedAt: now,
        }
        await this.collections.put(collection)
        return collection
    }

    async update(id: string, input: unknown): Promise<TemplateCollection> {
        const existing = await this.get(id)
        const body = input as TemplateCollectionInput
        if (body && typeof body === 'object' && body.id !== undefined && body.id !== id) {
            throw new BadRequestError(`Collection ids are immutable (body.id "${body.id}" differs from "${id}")`)
        }
        const issues = await this.validate(input)
        if (issues.length) throw new ValidationError(issues)
        const collection: TemplateCollection = {
            ...existing,
            name: body.name,
            description: body.description,
            tags: body.tags,
            items: body.items ?? [],
            updatedAt: new Date().toISOString(),
        }
        await this.collections.put(collection)
        return collection
    }

    async delete(id: string): Promise<void> {
        await this.get(id)
        await this.collections.delete(id)
    }

    /**
     * Self-contained bundle: the collection plus every referenced template and,
     * transitively, the templates those reference (e.g. a circuit's conductor).
     */
    async exportBundle(id: string): Promise<TemplateBundle> {
        const collection = await this.get(id)
        const snapshot = await this.templates.snapshot()
        const included = new Map<string, TemplateRecord>()
        const visit = (ref: TemplateRef) => {
            const key = `${ref.kind}:${ref.id}`
            if (included.has(key)) return
            const record = snapshot.get(ref)
            if (!record) throw new ConflictError(`Collection ${id} references missing template ${ref.kind}/${ref.id}`)
            included.set(key, record)
            for (const dep of getTemplateKindDefinition(record.kind).references(record.data)) visit(dep)
        }
        for (const item of collection.items) visit(item)
        return {
            format: 'thgrid.template-bundle',
            version: 1,
            exportedAt: new Date().toISOString(),
            collection,
            templates: [...included.values()],
        }
    }

    async importBundle(input: unknown, opts: ImportOptions = {}): Promise<ImportResult> {
        const bundle = input as Partial<TemplateBundle>
        if (!bundle || bundle.format !== 'thgrid.template-bundle' || bundle.version !== 1) {
            throw new BadRequestError('Body must be a thgrid.template-bundle version 1')
        }
        if (!Array.isArray(bundle.templates) || !bundle.collection || typeof bundle.collection !== 'object') {
            throw new BadRequestError('Bundle must contain "collection" and "templates"')
        }
        // Validate every template against the bundle itself plus what is already stored.
        const snapshot = await this.templates.snapshot()
        const bundleLookup = lookupFromRecords(bundle.templates)
        const ctx = {exists: (ref: TemplateRef) => bundleLookup.get(ref) !== undefined || snapshot.exists(ref)}
        const issues: ValidationIssue[] = []
        bundle.templates.forEach((t, i) => {
            const idIssues = validateTemplateId(t?.id)
            issues.push(...idIssues.map(x => ({...x, path: `templates.${i}.id`})))
            if (!t || typeof t.kind !== 'string') {
                issues.push({path: `templates.${i}.kind`, message: 'kind is required'})
                return
            }
            let def
            try {
                def = getTemplateKindDefinition(t.kind)
            } catch {
                issues.push({path: `templates.${i}.kind`, message: `unknown kind "${t.kind}"`})
                return
            }
            issues.push(...def.validate(t.data, ctx).map(x => ({...x, path: `templates.${i}.data.${x.path}`})))
        })
        issues.push(...validateCollectionInput(bundle.collection, ctx).map(x => ({...x, path: `collection.${x.path}`})))
        if (issues.length) throw new ValidationError(issues)

        const collectionInput = bundle.collection as TemplateCollection
        const collectionId = collectionInput.id ?? slugifyTemplateId(collectionInput.name)
        const collectionExists = await this.collections.exists(collectionId)
        if (collectionExists && !opts.overwrite) throw new ConflictError(`Collection ${collectionId} already exists; pass ?overwrite=true`)
        const clashes = bundle.templates.filter(t => snapshot.exists(t))
        if (clashes.length && !opts.overwrite) {
            throw new ConflictError('Some templates already exist; pass ?overwrite=true', {
                templates: clashes.map(t => ({kind: t.kind, id: t.id})),
            })
        }

        const now = new Date().toISOString()
        const result: ImportResult = {collection: toCollectionSummary(collectionInput), created: [], overwritten: [], skipped: []}
        for (const t of bundle.templates) {
            const ref: TemplateRef = {kind: t.kind, id: t.id}
            const existing = snapshot.get(ref)
            const record: TemplateRecord = {
                ...t,
                createdAt: existing?.createdAt ?? t.createdAt ?? now,
                updatedAt: now,
            }
            await this.templates.put(record)
            ;(existing ? result.overwritten : result.created).push(ref)
        }
        const existingCollection = collectionExists ? await this.collections.get(collectionId) : undefined
        const collection: TemplateCollection = {
            id: collectionId,
            name: collectionInput.name,
            description: collectionInput.description,
            tags: collectionInput.tags,
            items: collectionInput.items ?? [],
            createdAt: existingCollection?.createdAt ?? now,
            updatedAt: now,
        }
        await this.collections.put(collection)
        result.collection = toCollectionSummary(collection)
        return result
    }
}
