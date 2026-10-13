/**
 * Typed fetch wrapper for the thgrid backend. All domain types come from the
 * shared source tree (`@shared/*`) so the UI and backend never drift.
 */
import type {
    TemplateInput,
    TemplateKind,
    TemplateRecord,
    TemplateRef,
    TemplateSummary,
} from '@shared/templates/template'
import type {
    TemplateBundle,
    TemplateCollection,
    TemplateCollectionInput,
    TemplateCollectionSummary,
} from '@shared/templates/collection'
import type {ValidationIssue} from '@shared/templates/validation'
import type {MetaResponse} from '@shared/server/routes/meta'
import type {TemplateUsage} from '@shared/server/services/template.service'
import type {ImportResult} from '@shared/server/services/collection.service'

export type {MetaResponse, TemplateUsage, ImportResult}

export class ApiError extends Error {
    constructor(
        public readonly status: number,
        public readonly code: string,
        message: string,
        public readonly issues: ValidationIssue[] = [],
        public readonly details?: unknown,
    ) {
        super(message)
        this.name = 'ApiError'
    }
}

export interface ValidateResponse {
    valid: boolean
    issues: ValidationIssue[]
}

export interface DeleteTemplateResponse {
    deleted: true
    prunedFrom: TemplateCollectionSummary[]
    dangling: TemplateSummary[]
}

import type {NetworkDocument, NetworkSummary} from '@shared/network/records'
import type {NetworkOp, NetworkJournal, JournalEntry} from '@shared/network/ops'
import type {WorkingState, AppendResult, SaveResult, JournalState, JournalSince, NetworkChangeEvent} from '@shared/server/services/network.service'
import type {NetworkVersionInfo} from '@shared/server/storage/network.store'

export type {NetworkDocument, NetworkSummary, NetworkOp, NetworkJournal, JournalEntry, WorkingState, AppendResult, SaveResult, JournalState, JournalSince, NetworkChangeEvent, NetworkVersionInfo}

/**
 * This browser tab, sent as `X-Thgrid-Client` with every request: the server puts it on the change events it streams, so
 * an editor can skip its own changes. (`crypto.randomUUID` needs a secure context, which a LAN `dev:host` URL is not.)
 */
export const CLIENT_ID: string = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
    const res = await fetch(url, {
        method,
        headers: body !== undefined ? {'Content-Type': 'application/json', 'X-Thgrid-Client': CLIENT_ID} : {'X-Thgrid-Client': CLIENT_ID},
        body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    let json: unknown = undefined
    if (text) {
        try {
            json = JSON.parse(text)
        } catch {
            if (!res.ok) throw new ApiError(res.status, 'BAD_RESPONSE', `${res.status} ${res.statusText}`)
            throw new ApiError(res.status, 'BAD_RESPONSE', 'Server returned a non-JSON response')
        }
    }
    if (!res.ok) {
        const err = (json as { error?: { code?: string; message?: string; issues?: ValidationIssue[]; details?: unknown } } | undefined)?.error
        throw new ApiError(res.status, err?.code ?? 'HTTP_ERROR', err?.message ?? `${res.status} ${res.statusText}`, err?.issues ?? [], err?.details)
    }
    return json as T
}

const q = (params: Record<string, string | boolean | undefined>) => {
    const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== false)
    return entries.length ? '?' + entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&') : ''
}

export const api = {
    meta: () => request<MetaResponse>('GET', '/api/meta'),

    templates: {
        list: (kind?: TemplateKind) => request<TemplateSummary[]>('GET', `/api/templates${q({kind})}`),
        get: <K extends TemplateKind>(kind: K, id: string) => request<TemplateRecord<K>>('GET', `/api/templates/${kind}/${id}`),
        create: <K extends TemplateKind>(kind: K, input: TemplateInput<K>) => request<TemplateRecord<K>>('POST', `/api/templates/${kind}`, input),
        update: <K extends TemplateKind>(kind: K, id: string, input: TemplateInput<K>) => request<TemplateRecord<K>>('PUT', `/api/templates/${kind}/${id}`, input),
        validate: (kind: TemplateKind, input: TemplateInput) => request<ValidateResponse>('POST', `/api/templates/${kind}/validate`, input),
        delete: (kind: TemplateKind, id: string, force = false) => request<DeleteTemplateResponse>('DELETE', `/api/templates/${kind}/${id}${q({force})}`),
        usage: (ref: TemplateRef) => request<TemplateUsage>('GET', `/api/templates/${ref.kind}/${ref.id}/usage`),
        resolved: (kind: TemplateKind, id: string) => request<unknown>('GET', `/api/templates/${kind}/${id}/resolved`),
    },

    collections: {
        list: () => request<TemplateCollectionSummary[]>('GET', '/api/collections'),
        get: (id: string) => request<TemplateCollection>('GET', `/api/collections/${id}`),
        create: (input: TemplateCollectionInput) => request<TemplateCollection>('POST', '/api/collections', input),
        update: (id: string, input: TemplateCollectionInput) => request<TemplateCollection>('PUT', `/api/collections/${id}`, input),
        validate: (input: TemplateCollectionInput) => request<ValidateResponse>('POST', '/api/collections/validate', input),
        delete: (id: string) => request<{ deleted: true }>('DELETE', `/api/collections/${id}`),
        export: (id: string) => request<TemplateBundle>('GET', `/api/collections/${id}/export`),
        import: (bundle: unknown, overwrite = false) => request<ImportResult>('POST', `/api/collections/import${q({overwrite})}`, bundle),
    },

    networks: {
        list: () => request<NetworkSummary[]>('GET', '/api/networks'),
        create: (input: { name: string; id?: string; description?: string }) => request<NetworkDocument>('POST', '/api/networks', input),
        get: (id: string) => request<NetworkDocument>('GET', `/api/networks/${id}`),
        delete: (id: string) => request<{ deleted: true; archivedVersion?: string }>('DELETE', `/api/networks/${id}`),
        working: (id: string) => request<WorkingState>('GET', `/api/networks/${id}/working`),
        journal: (id: string) => request<NetworkJournal>('GET', `/api/networks/${id}/journal`),
        journalSince: (id: string, after: number) => request<JournalSince>('GET', `/api/networks/${id}/journal?after=${after}`),
        /** Server-sent `NetworkChangeEvent`s of one network. */
        events: (id: string) => new EventSource(`/api/networks/${id}/events`),
        append: (id: string, ops: NetworkOp[], expectedLastSeq?: number) => request<AppendResult>('POST', `/api/networks/${id}/journal`, {ops, expectedLastSeq}),
        discard: (id: string) => request<{ discarded: number }>('DELETE', `/api/networks/${id}/journal`),
        save: (id: string, force = false) => request<SaveResult>('POST', `/api/networks/${id}/save${q({force})}`),
        export: (id: string, working = false) => request<NetworkDocument>('GET', `/api/networks/${id}/export${q({working})}`),
        import: (doc: unknown, opts: { overwrite?: boolean; id?: string } = {}) => request<{ document: NetworkDocument; replaced: boolean }>('POST', `/api/networks/import${q({overwrite: opts.overwrite, id: opts.id})}`, doc),
        versions: (id: string) => request<NetworkVersionInfo[]>('GET', `/api/networks/${id}/versions`),
        version: (id: string, stamp: string) => request<NetworkDocument>('GET', `/api/networks/${id}/versions/${stamp}`),
        rollback: (id: string, stamp: string) => request<SaveResult>('POST', `/api/networks/${id}/versions/${stamp}/rollback`),
        /** Deletes archived versions beyond the newest `keep` (0 = all). */
        purgeVersions: (id: string, keep = 0) => request<{ deleted: number; kept: number; stamps: string[] }>('DELETE', `/api/networks/${id}/versions?keep=${keep}`),
    },
}

/** Triggers a browser download of a JSON document. */
export function downloadJson(filename: string, value: unknown) {
    const blob = new Blob([JSON.stringify(value, null, 2) + '\n'], {type: 'application/json'})
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
}
