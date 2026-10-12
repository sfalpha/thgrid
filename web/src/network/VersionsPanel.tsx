import {useState} from 'react'
import {api} from '../api/client'
import {useAsync} from '../hooks/useAsync'
import {Notice} from '../components/IssueList'

/** Archived versions of a network with download and rollback. */
export function VersionsPanel({networkId, dirty, onRolledBack}: { networkId: string; dirty: boolean; onRolledBack: () => void }) {
    const versions = useAsync(() => api.networks.versions(networkId), [networkId])
    const [error, setError] = useState<string | undefined>()

    const rollback = async (stamp: string, revision: number) => {
        const warn = dirty ? '\n\nUnsaved changes (the journal) will be discarded.' : ''
        if (!window.confirm(`Roll back to revision ${revision} (archived ${new Date(stampIso(stamp)).toLocaleString()})?\nThe current version is archived first.${warn}`)) return
        setError(undefined)
        try {
            await api.networks.rollback(networkId, stamp)
            versions.reload()
            onRolledBack()
        } catch (e) {
            setError((e as Error).message)
        }
    }

    /** Deletes archived versions: all of them, or all but the newest N the user types in. */
    const purge = async () => {
        const total = versions.data?.length ?? 0
        if (!total) return
        const answer = window.prompt(`Purge the archived history of this network (${total} version${total === 1 ? '' : 's'}).\nHow many of the newest versions should be kept? 0 deletes them all.`, '0')
        if (answer === null) return
        const keep = Number(answer.trim() || '0')
        if (!Number.isInteger(keep) || keep < 0) {
            setError('Enter a whole number of versions to keep (0 = purge all).')
            return
        }
        const doomed = Math.max(0, total - keep)
        if (!doomed) {
            setError(`Nothing to purge: only ${total} version${total === 1 ? ' is' : 's are'} archived.`)
            return
        }
        if (!window.confirm(`Delete ${doomed} archived version${doomed === 1 ? '' : 's'}${keep ? `, keeping the newest ${keep}` : ''}?\nThis cannot be undone. The current saved document and unsaved changes are not affected.`)) return
        setError(undefined)
        try {
            await api.networks.purgeVersions(networkId, keep)
            versions.reload()
        } catch (e) {
            setError((e as Error).message)
        }
    }

    return (
        <div className="panel">
            <div className="panel-header">
                <h3 style={{margin: 0}}>Versions</h3>
                <span className="spacer"/>
                <button type="button" className="small" onClick={versions.reload}>Refresh</button>
                <button type="button" className="small danger" onClick={() => void purge()} disabled={!versions.data?.length} title="Delete archived versions: all, or all but the newest N">Purge…</button>
            </div>
            {error && <Notice kind="error">{error}</Notice>}
            {versions.error && <Notice kind="error">{versions.error.message}</Notice>}
            {versions.data && versions.data.length === 0 && <p className="muted small">No archived versions yet. A version is archived every time the network is saved.</p>}
            {versions.data && versions.data.length > 0 && (
                <table>
                    <thead>
                    <tr>
                        <th>Rev</th>
                        <th>Archived</th>
                        <th>Name</th>
                        <th>Size</th>
                        <th style={{width: 1}}/>
                    </tr>
                    </thead>
                    <tbody>
                    {versions.data.map(v => (
                        <tr key={v.stamp}>
                            <td>{v.revision}</td>
                            <td className="small">{new Date(v.archivedAt).toLocaleString()}</td>
                            <td className="small">{v.name}</td>
                            <td className="small muted">{(v.bytes / 1024).toFixed(1)} kB</td>
                            <td className="toolbar" style={{flexWrap: 'nowrap'}}>
                                <a href={`/api/networks/${networkId}/versions/${v.stamp}?download=true`} target="_blank" rel="noreferrer"><button type="button" className="small">Download</button></a>
                                <button type="button" className="small" onClick={() => void rollback(v.stamp, v.revision)}>Roll back</button>
                            </td>
                        </tr>
                    ))}
                    </tbody>
                </table>
            )}
        </div>
    )
}

function stampIso(stamp: string): string {
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z$/.exec(stamp)
    return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z` : stamp
}
