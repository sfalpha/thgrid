import {useEffect, useMemo, useRef, useState} from 'react'
import {slugifyTemplateId, TemplateKind, TemplateSummary, TEMPLATE_ID_PATTERN} from '@shared/templates/template'
import type {TemplateCollection, TemplateCollectionInput, TemplateCollectionItem} from '@shared/templates/collection'
import {validateCollectionInput, ValidationIssue} from '@shared/templates/validation'
import {api, ApiError, downloadJson, MetaResponse} from '../api/client'
import {useAsync} from '../hooks/useAsync'
import {hrefTo} from '../hooks/useHashRoute'
import {TagsField, TextAreaField, TextField} from '../components/fields'
import {IssueList, Notice} from '../components/IssueList'

interface CollectionsPageProps {
    meta: MetaResponse
    segments: string[]
    navigate: (path: string) => void
}

/**
 * Routes:
 *   /collections            -> overview
 *   /collections/new        -> create
 *   /collections/:id        -> edit
 */
export function CollectionsPage({meta, segments, navigate}: CollectionsPageProps) {
    const selected = segments[1]
    const list = useAsync(() => api.collections.list(), [])
    const templates = useAsync(() => api.templates.list(), [])
    const [importMessage, setImportMessage] = useState<{ kind: 'ok' | 'error'; text: string } | undefined>()
    const fileInput = useRef<HTMLInputElement>(null)

    const importBundle = async (file: File) => {
        setImportMessage(undefined)
        try {
            const bundle = JSON.parse(await file.text()) as unknown
            let result
            try {
                result = await api.collections.import(bundle, false)
            } catch (e) {
                if (e instanceof ApiError && e.status === 409 && window.confirm(`${e.message}\n\nOverwrite existing templates and collection?`)) {
                    result = await api.collections.import(bundle, true)
                } else throw e
            }
            setImportMessage({kind: 'ok', text: `Imported collection "${result.collection.name}": ${result.created.length} templates created, ${result.overwritten.length} overwritten.`})
            list.reload()
            templates.reload()
            navigate(`/collections/${result.collection.id}`)
        } catch (e) {
            const err = e as ApiError
            setImportMessage({kind: 'error', text: err.issues?.length ? `${err.message}: ${err.issues.map(i => `${i.path} ${i.message}`).join('; ')}` : err.message})
        }
    }

    return (
        <div className="workspace">
            <aside className="sidebar">
                <div className="toolbar">
                    <h3 style={{margin: 0, flex: 1}}>Collections</h3>
                    <button type="button" className="small primary" onClick={() => navigate('/collections/new')}>+ New</button>
                </div>
                <div className="toolbar">
                    <button type="button" className="small" onClick={() => fileInput.current?.click()}>Import bundle…</button>
                    <input ref={fileInput} type="file" accept="application/json,.json" style={{display: 'none'}}
                           onChange={e => {
                               const f = e.target.files?.[0]
                               if (f) importBundle(f)
                               e.target.value = ''
                           }}/>
                </div>
                {list.error && <Notice kind="error">{list.error.message}</Notice>}
                <ul className="item-list">
                    {(list.data ?? []).map(c => (
                        <li key={c.id}>
                            <a href={hrefTo(`/collections/${c.id}`)} className={c.id === selected ? 'active' : ''} title={c.id}>
                                <span>{c.name}</span>
                                <span className="count">{c.itemCount}</span>
                            </a>
                        </li>
                    ))}
                    {!list.loading && (list.data ?? []).length === 0 && <li className="muted small" style={{padding: 8}}>No collections yet.</li>}
                </ul>
            </aside>
            <main className="main narrow">
                {importMessage && <Notice kind={importMessage.kind}>{importMessage.text}</Notice>}
                {selected ? (
                    <CollectionEditor
                        key={selected}
                        id={selected === 'new' ? undefined : selected}
                        meta={meta}
                        templates={templates.data ?? []}
                        onSaved={c => {
                            list.reload()
                            if (selected === 'new') navigate(`/collections/${c.id}`)
                        }}
                        onDeleted={() => {
                            list.reload()
                            navigate('/collections')
                        }}
                    />
                ) : (
                    <div className="panel">
                        <h2>Collections</h2>
                        <p className="muted">A collection is a named set of templates of any kind, e.g. a utility's standard equipment or a project's design basis.
                            Collections reference templates by id, so editing a template updates every collection that includes it.</p>
                        <p className="muted small">Stored as JSON under <code>data/collections/</code>. Export a collection to get a self-contained bundle that can be imported elsewhere.</p>
                        <div className="cards" style={{marginTop: 16}}>
                            {(list.data ?? []).map(c => (
                                <a key={c.id} className="card" href={hrefTo(`/collections/${c.id}`)}>
                                    <h4>{c.name}</h4>
                                    <div className="muted small">{c.itemCount} template{c.itemCount === 1 ? '' : 's'} · {c.id}</div>
                                    {c.description && <p className="small" style={{marginTop: 6}}>{c.description}</p>}
                                </a>
                            ))}
                        </div>
                    </div>
                )}
            </main>
        </div>
    )
}

interface CollectionEditorProps {
    id?: string
    meta: MetaResponse
    templates: TemplateSummary[]
    onSaved: (c: TemplateCollection) => void
    onDeleted: () => void
}

function CollectionEditor({id, meta, templates, onSaved, onDeleted}: CollectionEditorProps) {
    const isNew = id === undefined
    const record = useAsync(async () => isNew ? undefined : api.collections.get(id), [id])

    const [name, setName] = useState('')
    const [customId, setCustomId] = useState('')
    const [description, setDescription] = useState<string | undefined>()
    const [tags, setTags] = useState<string[] | undefined>()
    const [items, setItems] = useState<TemplateCollectionItem[]>([])
    const [dirty, setDirty] = useState(false)
    const [serverIssues, setServerIssues] = useState<ValidationIssue[]>([])
    const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | undefined>()
    const [saving, setSaving] = useState(false)
    const [pickKind, setPickKind] = useState<TemplateKind>(meta.kinds[0].kind)
    const [pickId, setPickId] = useState('')

    useEffect(() => {
        if (record.loading) return
        const c = record.data
        setName(c?.name ?? '')
        setDescription(c?.description)
        setTags(c?.tags)
        setItems(c?.items ?? [])
        setCustomId('')
        setDirty(false)
        setServerIssues([])
        setMessage(undefined)
    }, [record.data, record.loading])

    const byRef = useMemo(() => new Map(templates.map(t => [`${t.kind}:${t.id}`, t])), [templates])
    const input: TemplateCollectionInput = {name, description, tags, items}
    const clientIssues = useMemo(() => validateCollectionInput(input, {exists: ref => templates.length === 0 || byRef.has(`${ref.kind}:${ref.id}`)}),
        [name, description, tags, items, byRef, templates.length]) // eslint-disable-line react-hooks/exhaustive-deps
    const issues = serverIssues.length ? serverIssues : clientIssues
    const derivedId = customId || slugifyTemplateId(name)
    const idValid = !isNew || TEMPLATE_ID_PATTERN.test(derivedId)

    const candidates = templates.filter(t => t.kind === pickKind && !items.some(i => i.kind === t.kind && i.id === t.id))
    const touch = () => {
        setDirty(true)
        setServerIssues([])
    }
    const addItem = () => {
        if (!pickId) return
        setItems([...items, {kind: pickKind, id: pickId}])
        setPickId('')
        touch()
    }
    const addAllOfKind = () => {
        if (!candidates.length) return
        setItems([...items, ...candidates.map(t => ({kind: t.kind, id: t.id}))])
        setPickId('')
        touch()
    }

    const save = async () => {
        setSaving(true)
        setMessage(undefined)
        try {
            const body: TemplateCollectionInput = {...input}
            let saved: TemplateCollection
            if (isNew) {
                if (customId) body.id = customId
                saved = await api.collections.create(body)
            } else {
                saved = await api.collections.update(id, body)
            }
            setDirty(false)
            setMessage({kind: 'ok', text: `Saved collection ${saved.id}.`})
            onSaved(saved)
        } catch (e) {
            if (e instanceof ApiError && e.issues.length) setServerIssues(e.issues)
            setMessage({kind: 'error', text: (e as Error).message})
        } finally {
            setSaving(false)
        }
    }

    const remove = async () => {
        if (isNew || !window.confirm(`Delete collection "${name || id}"? Templates are not deleted.`)) return
        try {
            await api.collections.delete(id)
            onDeleted()
        } catch (e) {
            setMessage({kind: 'error', text: (e as Error).message})
        }
    }

    const exportBundle = async () => {
        if (isNew) return
        try {
            const bundle = await api.collections.export(id)
            downloadJson(`${id}.thgrid-bundle.json`, bundle)
        } catch (e) {
            setMessage({kind: 'error', text: (e as Error).message})
        }
    }

    if (record.error) return <Notice kind="error">Could not load collection: {record.error.message}</Notice>
    if (record.loading && !isNew) return <div className="empty">Loading…</div>

    return (
        <div className="panel">
            <div className="panel-header">
                <h2>{isNew ? 'New collection' : name || id}</h2>
                {!isNew && <span className="badge">{id}</span>}
                {dirty && <span className="muted small">unsaved changes</span>}
                <span className="spacer"/>
                <div className="toolbar">
                    {!isNew && <button type="button" onClick={exportBundle} title="Download the collection with all referenced templates embedded">Export bundle</button>}
                    {!isNew && <button type="button" className="danger" onClick={remove}>Delete</button>}
                    <button type="button" className="primary" onClick={save} disabled={saving || !idValid || (!dirty && !isNew) || (serverIssues.length === 0 && clientIssues.length > 0)}>
                        {saving ? 'Saving…' : isNew ? 'Create' : 'Save'}
                    </button>
                </div>
            </div>
            {message && <Notice kind={message.kind}>{message.text}</Notice>}
            <IssueList issues={issues}/>

            <div className="form-grid" style={{marginBottom: 16}}>
                <TextField label="Name" value={name} onChange={v => {
                    setName(v)
                    touch()
                }} className="span-2"/>
                {isNew ? (
                    <TextField label="Id" value={customId || derivedId} mono onChange={setCustomId}
                               hint="File name under data/collections. Derived from the name unless you type one."
                               error={idValid ? undefined : `Must match ${TEMPLATE_ID_PATTERN.source}`}/>
                ) : (
                    <TextField label="Id" value={id} readOnly mono onChange={() => undefined}/>
                )}
                <TextAreaField label="Description" value={description} rows={1} className="span-2" onChange={v => {
                    setDescription(v)
                    touch()
                }}/>
                <TagsField value={tags} onChange={v => {
                    setTags(v)
                    touch()
                }}/>
            </div>

            <h3>Templates in this collection</h3>
            {items.length === 0 ? <p className="muted">No templates yet. Add some below.</p> : (
                <table>
                    <thead>
                    <tr>
                        <th>Kind</th>
                        <th>Template</th>
                        <th>Note</th>
                        <th style={{width: 1}}/>
                    </tr>
                    </thead>
                    <tbody>
                    {items.map((item, i) => {
                        const t = byRef.get(`${item.kind}:${item.id}`)
                        const kindInfo = meta.kinds.find(k => k.kind === item.kind)
                        return (
                            <tr key={`${item.kind}:${item.id}`}>
                                <td><span className="badge">{kindInfo?.label ?? item.kind}</span></td>
                                <td>
                                    {t ? <a href={hrefTo(`/templates/${item.kind}/${item.id}`)}>{t.name}</a> : <span style={{color: 'var(--danger)'}}>{item.id} (missing)</span>}
                                    <div className="muted small mono">{item.id}</div>
                                </td>
                                <td>
                                    <input type="text" value={item.note ?? ''} placeholder="Optional note"
                                           onChange={e => {
                                               setItems(items.map((x, n) => n === i ? {...x, note: e.target.value || undefined} : x))
                                               touch()
                                           }}/>
                                </td>
                                <td>
                                    <button type="button" className="small danger" onClick={() => {
                                        setItems(items.filter((_, n) => n !== i))
                                        touch()
                                    }}>×
                                    </button>
                                </td>
                            </tr>
                        )
                    })}
                    </tbody>
                </table>
            )}

            <div className="toolbar" style={{marginTop: 12}}>
                <select value={pickKind} onChange={e => {
                    setPickKind(e.target.value as TemplateKind)
                    setPickId('')
                }}>
                    {meta.kinds.map(k => <option key={k.kind} value={k.kind}>{k.label}</option>)}
                </select>
                <select value={pickId} onChange={e => setPickId(e.target.value)} style={{minWidth: 280}}>
                    <option value="">{candidates.length ? 'Select template…' : 'No more templates of this kind'}</option>
                    {candidates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
                <button type="button" onClick={addItem} disabled={!pickId}>Add</button>
                <button type="button" onClick={addAllOfKind} disabled={!candidates.length}>Add all {candidates.length ? `(${candidates.length})` : ''}</button>
            </div>
        </div>
    )
}
