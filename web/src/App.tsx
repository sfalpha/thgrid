import {api} from './api/client'
import {useAsync} from './hooks/useAsync'
import {hrefTo, useHashRoute} from './hooks/useHashRoute'
import {TemplatesPage} from './pages/TemplatesPage'
import {CollectionsPage} from './pages/CollectionsPage'
import {NetworksPage} from './network/NetworksPage'
import {NetworkShell} from './network/NetworkShell'
import {Notice} from './components/IssueList'

const NAV = [
    {path: '/templates', label: 'Templates'},
    {path: '/collections', label: 'Collections'},
    {path: '/network', label: 'Networks'},
]

export function App() {
    const [route, navigate] = useHashRoute()
    const meta = useAsync(() => api.meta(), [])
    const section = route.segments[0] ?? 'templates'

    return (
        <div className="app">
            <header className="topbar">
                <span className="brand">thgrid</span>
                <nav>
                    {NAV.map(n => (
                        <a key={n.path} href={hrefTo(n.path)} className={section === n.path.slice(1) ? 'active' : ''}>{n.label}</a>
                    ))}
                </nav>
                <span className="spacer"/>
                {meta.data && <span className="muted small">backend v{meta.data.version}</span>}
            </header>
            {meta.error ? (
                <main className="main">
                    <Notice kind="error">
                        Cannot reach the backend ({meta.error.message}). Start it with <code>npm run dev:server</code> (or <code>npm run dev</code> for both) and reload.
                    </Notice>
                </main>
            ) : !meta.data ? (
                <div className="empty">Loading…</div>
            ) : section === 'collections' ? (
                <CollectionsPage meta={meta.data} segments={route.segments} navigate={navigate}/>
            ) : section === 'network' ? (
                route.segments[1] ? <NetworkShell meta={meta.data} segments={route.segments} navigate={navigate}/> : <NetworksPage navigate={navigate}/>
            ) : (
                <TemplatesPage meta={meta.data} segments={route.segments} navigate={navigate}/>
            )}
        </div>
    )
}
