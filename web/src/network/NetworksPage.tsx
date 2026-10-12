import {useRef, useState} from 'react'
import {slugifyTemplateId, TEMPLATE_ID_PATTERN} from '@shared/templates/template'
import {api, ApiError} from '../api/client'
import {useAsync} from '../hooks/useAsync'
import {hrefTo} from '../hooks/useHashRoute'
import {TextAreaField, TextField} from '../components/fields'
import {Notice} from '../components/IssueList'

/** `#/network` – list, create, import and delete networks. */
export function NetworksPage({navigate}: { navigate: (path: string) => void }) {
    const list = useAsync(() => api.networks.list(), [])
    const [name, setName] = useState('')
    const [customId, setCustomId] = useState('')
    const [description, setDescription] = useState<string | undefined>()
    const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | undefined>()
    const fileInput = useRef<HTMLInputElement>(null)
    const derivedId = customId || slugifyTemplateId(name)
    const idValid = TEMPLATE_ID_PATTERN.test(derivedId)

    const create = async () => {
        setMessage(undefined)
        try {
            const doc = await api.networks.create({name: name.trim(), id: customId || undefined, description})
            navigate(`/network/${doc.id}/map`)
        } catch (e) {
            setMessage({kind: 'error', text: (e as Error).message})
        }
    }

    const importFile = async (file: File) => {
        setMessage(undefined)
        try {
            const doc = JSON.parse(await file.text()) as unknown
            let result
            try {
                result = await api.networks.import(doc)
            } catch (e) {
                if (e instanceof ApiError && e.status === 409 && window.confirm(`${e.message}\n\nReplace the existing network? The current version is archived first.`)) {
                    result = await api.networks.import(doc, {overwrite: true})
                } else throw e
            }
            list.reload()
            setMessage({kind: 'ok', text: `Imported "${result.document.name}" as ${result.document.id}${result.replaced ? ' (replaced, previous version archived)' : ''}.`})
        } catch (e) {
            const err = e as ApiError
            setMessage({kind: 'error', text: err.issues?.length ? `${err.message}: ${err.issues.slice(0, 5).map(i => `${i.path} ${i.message}`).join('; ')}` : err.message})
        }
    }

    const remove = async (id: string, label: string) => {
        if (!window.confirm(`Delete network "${label}"? The current version is archived under data/networks/history.`)) return
        try {
            await api.networks.delete(id)
            list.reload()
        } catch (e) {
            setMessage({kind: 'error', text: (e as Error).message})
        }
    }

    return (
        <div className="workspace" style={{gridTemplateColumns: '1fr'}}>
            <main className="main narrow">
                {message && <Notice kind={message.kind}>{message.text}</Notice>}
                {list.error && <Notice kind="error">{list.error.message}</Notice>}
                <div className="panel">
                    <div className="panel-header">
                        <h2>Networks</h2>
                        <span className="spacer"/>
                        <button type="button" onClick={() => fileInput.current?.click()}>Import JSON…</button>
                        <input ref={fileInput} type="file" accept="application/json,.json" style={{display: 'none'}}
                               onChange={e => {
                                   const f = e.target.files?.[0]
                                   if (f) void importFile(f)
                                   e.target.value = ''
                               }}/>
                    </div>
                    <p className="muted">A network (grid) is one JSON file under <code>data/networks/</code>. Every save archives the previous version under
                        <code> data/networks/history/</code>; unsaved edits are journaled under <code>data/networks/journal/</code>.</p>
                    {(list.data ?? []).length === 0 && !list.loading && <p className="muted">No networks yet. Create one below or import a JSON file.</p>}
                    {(list.data ?? []).length > 0 && (
                        <table>
                            <thead>
                            <tr>
                                <th>Name</th>
                                <th>Id</th>
                                <th>Rev</th>
                                <th>Substations</th>
                                <th>Circuits</th>
                                <th>Unsaved</th>
                                <th>Updated</th>
                                <th style={{width: 1}}/>
                            </tr>
                            </thead>
                            <tbody>
                            {(list.data ?? []).map(n => (
                                <tr key={n.id}>
                                    <td><a href={hrefTo(`/network/${n.id}/map`)}><strong>{n.name}</strong></a>{n.description && <div className="muted small">{n.description}</div>}</td>
                                    <td className="mono muted">{n.id}</td>
                                    <td>{n.revision}</td>
                                    <td>{n.counts.substationGroups} sites / {n.counts.substations} yards</td>
                                    <td>{n.counts.circuits}</td>
                                    <td>{n.journalEntries > 0 ? <span className="tag" title="Unsaved journal entries">{n.journalEntries} edits</span> : <span className="muted">–</span>}</td>
                                    <td className="muted small">{new Date(n.updatedAt).toLocaleString()}</td>
                                    <td className="toolbar">
                                        <a href={hrefTo(`/network/${n.id}/map`)}><button type="button" className="small">Map</button></a>
                                        <a href={hrefTo(`/network/${n.id}/substations`)}><button type="button" className="small">Substations</button></a>
                                        <button type="button" className="small danger" onClick={() => void remove(n.id, n.name)}>Delete</button>
                                    </td>
                                </tr>
                            ))}
                            </tbody>
                        </table>
                    )}
                </div>
                <div className="panel">
                    <h3>New network</h3>
                    <div className="form-grid">
                        <TextField label="Name" value={name} onChange={setName} placeholder="e.g. EGAT East" className="span-2"/>
                        <TextField label="Id" value={customId || derivedId} mono onChange={setCustomId} hint="File name under data/networks"
                                   error={name && !idValid ? `Must match ${TEMPLATE_ID_PATTERN.source}` : undefined}/>
                        <TextAreaField label="Description" value={description} onChange={setDescription} rows={1} className="span-all"/>
                    </div>
                    <div className="toolbar" style={{marginTop: 12}}>
                        <button type="button" className="primary" disabled={!name.trim() || !idValid} onClick={() => void create()}>Create and open</button>
                    </div>
                </div>
            </main>
        </div>
    )
}
