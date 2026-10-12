import {useState} from 'react'
import {hrefTo} from '../hooks/useHashRoute'
import {IssueList, Notice} from '../components/IssueList'
import {NetworkProvider, useNetworkEditor} from './NetworkContext'
import {VersionsPanel} from './VersionsPanel'
import {MapEditor} from './MapEditor'
import {SubstationsPage} from './SubstationsPage'
import {SubstationEditor} from './SubstationEditor'
import type {MetaResponse} from '../api/client'

interface NetworkShellProps {
    meta: MetaResponse
    segments: string[]
    navigate: (path: string) => void
}

/**
 * Routes:
 *   /network/:id                      -> map
 *   /network/:id/map                  -> map editor
 *   /network/:id/substations          -> list of yards
 *   /network/:id/substation/:yardId   -> substation editor
 */
export function NetworkShell({meta, segments, navigate}: NetworkShellProps) {
    const networkId = segments[1]
    return (
        <NetworkProvider key={networkId} networkId={networkId}>
            <Shell meta={meta} segments={segments} navigate={navigate}/>
        </NetworkProvider>
    )
}

function Shell({meta, segments, navigate}: NetworkShellProps) {
    const ed = useNetworkEditor()
    const view = segments[2] ?? 'map'
    const yardId = segments[3]
    const [showVersions, setShowVersions] = useState(false)
    const [showIssues, setShowIssues] = useState(false)
    const base = `/network/${ed.networkId}`

    /** Errors block a save (unless forced); warnings, e.g. a planned record used by a built one, never do. */
    const errors = ed.issues.filter(i => i.severity !== 'warning')
    const warnings = ed.issues.length - errors.length
    const save = async () => {
        if (errors.length && !window.confirm(`The network has ${errors.length} validation issue(s). Save anyway?`)) {
            setShowIssues(true)
            return
        }
        await ed.save(errors.length > 0)
    }
    const discard = async () => {
        if (!ed.dirty || !window.confirm(`Discard ${ed.journal.entries} unsaved change(s) and reload the last saved version?`)) return
        await ed.discard()
    }

    return (
        <div className="net-shell">
            <div className="net-toolbar">
                <a href={hrefTo('/network')} title="All networks">‹ Networks</a>
                <span className="title">{ed.doc.name}</span>
                <button type="button" className="small" title="Rename network" onClick={() => {
                    const name = window.prompt('Network name', ed.doc.name)
                    if (name && name.trim() && name.trim() !== ed.doc.name) ed.apply([{type: 'meta', name: name.trim()}])
                }}>Rename</button>
                <span className="badge" title="Saved revision">rev {ed.savedRevision}</span>
                {ed.dirty ? <span className="tag" title="Journaled, unsaved edits">{ed.journal.entries} unsaved</span> : <span className="muted small">saved</span>}
                {ed.issues.length > 0 && <button type="button" className={`small ${errors.length ? 'danger' : ''}`} onClick={() => setShowIssues(s => !s)} title={warnings ? `${warnings} warning(s) do not block saving` : undefined}>
                    {errors.length ? `${errors.length} issue${errors.length === 1 ? '' : 's'}` : ''}{errors.length && warnings ? ' · ' : ''}{warnings ? `⚠ ${warnings}` : ''}
                </button>}
                <span className="tabs" style={{marginLeft: 12}}>
                    <a href={hrefTo(`${base}/map`)} className={view === 'map' ? 'active' : ''}>Map</a>
                    <a href={hrefTo(`${base}/substations`)} className={view !== 'map' ? 'active' : ''}>Substations</a>
                </span>
                <span className="spacer" style={{flex: 1}}/>
                <button type="button" className="small" onClick={ed.undo} disabled={!ed.canUndo} title="Undo (journaled)">Undo</button>
                <button type="button" className="small" onClick={ed.redo} disabled={!ed.canRedo}>Redo</button>
                <button type="button" className="small" onClick={() => ed.exportJson(true)} title="Download the working document as JSON">Export JSON</button>
                <button type="button" className="small" onClick={() => setShowVersions(s => !s)}>Versions</button>
                <button type="button" className="small" onClick={() => void discard()} disabled={!ed.dirty || ed.busy}>Discard</button>
                <button type="button" className="small primary" onClick={() => void save()} disabled={!ed.dirty || ed.busy}>{ed.busy ? 'Saving…' : 'Save version'}</button>
            </div>
            {(ed.syncError || ed.journal.stale || ed.journal.error) && (
                <div style={{padding: '8px 16px 0'}}>
                    <Notice kind="error">
                        {ed.syncError ?? (ed.journal.error ? `The journal could not be replayed: ${ed.journal.error}` : `The journal belongs to revision ${ed.journal.baseRevision}, but the saved document is revision ${ed.savedRevision}.`)}
                        {' '}
                        <button type="button" className="small" onClick={() => void ed.reload()}>Reload</button>
                        {' '}
                        <button type="button" className="small danger" onClick={() => void ed.discard()}>Discard journal</button>
                    </Notice>
                </div>
            )}
            {(showVersions || showIssues) && (
                <div style={{padding: '12px 16px 0', maxHeight: '40vh', overflow: 'auto'}}>
                    {showIssues && (
                        <div className="panel">
                            <div className="panel-header">
                                <h3 style={{margin: 0}}>Validation issues</h3>
                                <span className="spacer"/>
                                <button type="button" className="small" onClick={() => setShowIssues(false)}>Close</button>
                            </div>
                            {ed.issues.length ? <IssueList issues={ed.issues}/> : <p className="muted">No issues.</p>}
                        </div>
                    )}
                    {showVersions && <VersionsPanel networkId={ed.networkId} dirty={ed.dirty} onRolledBack={() => void ed.reload()}/>}
                </div>
            )}
            {view === 'map' ? (
                <MapEditor meta={meta} navigate={navigate}/>
            ) : view === 'substation' && yardId ? (
                <SubstationEditor meta={meta} substationId={yardId} navigate={navigate}/>
            ) : (
                <SubstationsPage meta={meta} navigate={navigate}/>
            )}
        </div>
    )
}
