import {TemplateKind} from '@shared/templates/template'
import {api} from '../api/client'
import {useAsync} from './useAsync'

/**
 * Summaries of all templates of a kind (for pickers), in the order of the
 * collections: templates are listed as they appear in the collections (first
 * collection first), e.g. the EGAT standard set runs from the smaller
 * conductors to the larger ones; templates that belong to no collection
 * follow, alphabetically.
 */
export function useTemplates(kind: TemplateKind) {
    const state = useAsync(async () => {
        const [templates, collections] = await Promise.all([api.templates.list(kind), api.collections.list().catch(() => [])])
        const full = await Promise.all(collections.map(c => api.collections.get(c.id).catch(() => undefined)))
        const order = new Map<string, number>()
        for (const c of full) for (const it of c?.items ?? []) if (it.kind === kind && !order.has(it.id)) order.set(it.id, order.size)
        return [...templates].sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity) || a.name.localeCompare(b.name))
    }, [kind])
    return {templates: state.data ?? [], loading: state.loading, error: state.error, reload: state.reload}
}
