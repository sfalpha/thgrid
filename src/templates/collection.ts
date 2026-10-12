/**
 * Named collections of templates.
 *
 * A collection groups templates of any kind under one name, e.g. "EGAT standard
 * equipment" or "Project X design basis". Collections reference templates by
 * `{kind, id}`; they never copy payloads, so editing a template is reflected in
 * every collection that includes it. A collection can be exported as a
 * self-contained `TemplateBundle` (payloads embedded) for sharing or backup.
 *
 * Persisted as `data/collections/<id>.json`.
 */
import {TemplateKind, TemplateRecord, TemplateRef, TEMPLATE_ID_PATTERN} from "./template";

export interface TemplateCollectionItem extends TemplateRef {
    /** Optional free text, e.g. the role this template plays in the collection ("default 230kV line"). */
    note?: string
}

export interface TemplateCollection {
    id: string
    name: string
    description?: string
    tags?: string[]
    items: TemplateCollectionItem[]
    createdAt: string
    updatedAt: string
}

/** Client payload for create/update. `id` is only honoured on create. */
export interface TemplateCollectionInput {
    id?: string
    name: string
    description?: string
    tags?: string[]
    items?: TemplateCollectionItem[]
}

export interface TemplateCollectionSummary {
    id: string
    name: string
    description?: string
    tags?: string[]
    itemCount: number
    updatedAt: string
}

/** Self-contained export of a collection: the collection plus every referenced template. */
export interface TemplateBundle {
    format: 'thgrid.template-bundle'
    version: 1
    exportedAt: string
    collection: TemplateCollection
    templates: TemplateRecord[]
}

export const COLLECTION_ID_PATTERN = TEMPLATE_ID_PATTERN

export function toCollectionSummary(c: TemplateCollection): TemplateCollectionSummary {
    return {
        id: c.id,
        name: c.name,
        description: c.description,
        tags: c.tags,
        itemCount: c.items.length,
        updatedAt: c.updatedAt,
    }
}

export function collectionItemsOfKind(c: TemplateCollection, kind: TemplateKind): TemplateCollectionItem[] {
    return c.items.filter(i => i.kind === kind)
}
