import {useMemo, useState} from 'react'
import {isTemplateKind, TemplateKind, TemplateSummary} from '@shared/templates/template'
import {api, MetaResponse} from '../api/client'
import {useAsync} from '../hooks/useAsync'
import {hrefTo} from '../hooks/useHashRoute'
import {TemplateEditor} from '../components/TemplateEditor'
import {Notice} from '../components/IssueList'

interface TemplatesPageProps {
    meta: MetaResponse
    segments: string[]
    navigate: (path: string) => void
}

/**
 * Routes:
 *   /templates                 -> first kind
 *   /templates/:kind           -> list, no editor
 *   /templates/:kind/new       -> create
 *   /templates/:kind/:id       -> edit
 */
export function TemplatesPage({meta, segments, navigate}: TemplatesPageProps) {
    const kindParam = segments[1]
    const kind: TemplateKind = isTemplateKind(kindParam) ? kindParam : meta.kinds[0].kind
    const selected = segments[2]
    const [search, setSearch] = useState('')

    const all = useAsync(() => api.templates.list(), [])
    const byKind = useMemo(() => {
        const map = new Map<TemplateKind, TemplateSummary[]>()
        for (const k of meta.kinds) map.set(k.kind, [])
        for (const t of all.data ?? []) map.get(t.kind)?.push(t)
        return map
    }, [all.data, meta.kinds])

    const items = (byKind.get(kind) ?? []).filter(t => {
        const q = search.trim().toLowerCase()
        return !q || t.name.toLowerCase().includes(q) || t.id.includes(q) || (t.tags ?? []).some(x => x.toLowerCase().includes(q))
    })
    const kindInfo = meta.kinds.find(k => k.kind === kind)!

    return (
        <div className="workspace">
            <aside className="sidebar">
                <div>
                    <h3>Template kinds</h3>
                    <ul className="kind-list">
                        {meta.kinds.map(k => (
                            <li key={k.kind}>
                                <a href={hrefTo(`/templates/${k.kind}`)} className={k.kind === kind ? 'active' : ''}>
                                    {k.pluralLabel}
                                    <span className="count">{byKind.get(k.kind)?.length ?? 0}</span>
                                </a>
                            </li>
                        ))}
                    </ul>
                </div>
                <div style={{display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0}}>
                    <div className="toolbar">
                        <h3 style={{margin: 0, flex: 1}}>{kindInfo.pluralLabel}</h3>
                        <button type="button" className="small primary" onClick={() => navigate(`/templates/${kind}/new`)}>+ New</button>
                    </div>
                    <input className="search" type="search" placeholder="Filter…" value={search} onChange={e => setSearch(e.target.value)}/>
                    {all.error && <Notice kind="error">{all.error.message}</Notice>}
                    <ul className="item-list">
                        {items.map(t => (
                            <li key={t.id}>
                                <a href={hrefTo(`/templates/${kind}/${t.id}`)} className={t.id === selected ? 'active' : ''} title={t.id}>
                                    <span className="mono" style={{overflow: 'hidden', textOverflow: 'ellipsis'}}>{t.name}</span>
                                </a>
                            </li>
                        ))}
                        {!all.loading && items.length === 0 && <li className="muted small" style={{padding: 8}}>No {kindInfo.pluralLabel.toLowerCase()}{search ? ' match the filter' : ' yet'}.</li>}
                    </ul>
                </div>
            </aside>
            <main className="main narrow">
                {selected === 'new' ? (
                    <TemplateEditor
                        key={`new-${kind}`}
                        kind={kind}
                        meta={meta}
                        onSaved={r => {
                            all.reload()
                            navigate(`/templates/${r.kind}/${r.id}`)
                        }}
                        onDeleted={() => undefined}
                    />
                ) : selected ? (
                    <TemplateEditor
                        key={`${kind}-${selected}`}
                        kind={kind}
                        id={selected}
                        meta={meta}
                        onSaved={() => all.reload()}
                        onDeleted={() => {
                            all.reload()
                            navigate(`/templates/${kind}`)
                        }}
                    />
                ) : (
                    <div className="panel">
                        <h2>{kindInfo.pluralLabel}</h2>
                        <p className="muted">{kindInfo.description}</p>
                        <p className="muted small">Stored as JSON under <code>data/templates/{kindInfo.directory}/</code>.</p>
                        <div className="toolbar" style={{marginTop: 12}}>
                            <button type="button" className="primary" onClick={() => navigate(`/templates/${kind}/new`)}>Create {kindInfo.label.toLowerCase()}</button>
                        </div>
                        {items.length > 0 && (
                            <table style={{marginTop: 16}}>
                                <thead>
                                <tr>
                                    <th>Name</th>
                                    <th>Id</th>
                                    <th>Tags</th>
                                    <th>Updated</th>
                                </tr>
                                </thead>
                                <tbody>
                                {items.map(t => (
                                    <tr key={t.id}>
                                        <td><a href={hrefTo(`/templates/${kind}/${t.id}`)}>{t.name}</a></td>
                                        <td className="mono muted">{t.id}</td>
                                        <td>{(t.tags ?? []).map(x => <span className="tag" key={x}>{x}</span>)}</td>
                                        <td className="muted small">{new Date(t.updatedAt).toLocaleString()}</td>
                                    </tr>
                                ))}
                                </tbody>
                            </table>
                        )}
                    </div>
                )}
            </main>
        </div>
    )
}
