import {api} from './api/client'
import {useAsync} from './hooks/useAsync'
import {useHashRoute} from './hooks/useHashRoute'
import {TemplatesPage} from './pages/TemplatesPage'
import {CollectionsPage} from './pages/CollectionsPage'
import {NetworksPage} from './network/NetworksPage'
import {NetworkShell} from './network/NetworkShell'
import {Notice} from './components/IssueList'
import {SideNav, useNavOpen} from './components/SideNav'

export function App() {
    const [route, navigate] = useHashRoute()
    const meta = useAsync(() => api.meta(), [])
    // the networks are the first page (`#/`)
    const section = route.segments[0] ?? 'network'
    const [navOpen, setNavOpen] = useNavOpen()

    return (
        <div className={`app ${navOpen ? 'nav-open' : ''}`}>
            <SideNav section={section} open={navOpen} setOpen={setNavOpen} version={meta.data?.version}/>
            <div className="app-page">
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
        </div>
    )
}
