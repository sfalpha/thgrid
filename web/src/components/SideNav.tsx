import {useEffect, useRef, useState} from 'react'
import type {ReactNode} from 'react'
import {hrefTo} from '../hooks/useHashRoute'

const OPEN_KEY = 'thgrid.navOpen'

/** Icons of the menu: 24×24, drawn with the current text colour. */
const icon = (children: ReactNode) => (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
)

const ICONS = {
    // a page laid out in sections: the templates
    templates: icon(<>
        <rect x="3.5" y="3.5" width="17" height="17" rx="2"/>
        <path d="M3.5 9h17M9 9v11.5"/>
    </>),
    // stacked layers: collections of templates
    collections: icon(<>
        <path d="M12 3 3 7.5 12 12l9-4.5L12 3Z"/>
        <path d="m3 12 9 4.5 9-4.5M3 16.5l9 4.5 9-4.5"/>
    </>),
    // a transmission tower: the networks
    networks: icon(<>
        <path d="M8.5 21.5 12 3l3.5 18.5"/>
        <path d="M5 7.5h14M6.5 12h11M5 7.5v2M19 7.5v2M6.5 12v2M17.5 12v2"/>
        <path d="m9.9 14 4.9 4M14.1 14l-4.9 4"/>
    </>),
    collapse: icon(<path d="m11 17-5-5 5-5M18 17l-5-5 5-5"/>),
    expand: icon(<path d="m6 17 5-5-5-5M13 17l5-5-5-5"/>),
}

export const NAV = [
    {path: '/network', label: 'Networks', icon: ICONS.networks},
    {path: '/templates', label: 'Templates', icon: ICONS.templates},
    {path: '/collections', label: 'Collections', icon: ICONS.collections},
]

/** Whether the menu is expanded, remembered per browser (collapsed by default, and when storage is unavailable). */
export function useNavOpen(): [boolean, (open: boolean) => void] {
    const [open, setOpen] = useState(() => {
        try {
            return window.localStorage.getItem(OPEN_KEY) === '1'
        } catch {
            return false
        }
    })
    const set = (next: boolean) => {
        setOpen(next)
        try {
            window.localStorage.setItem(OPEN_KEY, next ? '1' : '0')
        } catch {
            /* private mode etc. */
        }
    }
    return [open, set]
}

/**
 * The main navigation: a menu on the left, icons only while collapsed (hovering an icon names the page), icons and page
 * names while expanded; the button at the top switches. The page beside it changes width with it, so a resize is
 * announced (the map re-measures itself on window resizes).
 */
export function SideNav({section, open, setOpen, version}: { section: string; open: boolean; setOpen: (open: boolean) => void; version?: string }) {
    const mounted = useRef(false)
    useEffect(() => {
        if (mounted.current) window.dispatchEvent(new Event('resize'))
        mounted.current = true
    }, [open])
    const toggleLabel = open ? 'Collapse menu' : 'Expand menu'
    return (
        <nav className="sidenav" aria-label="Main" onTransitionEnd={e => {
            if (e.target === e.currentTarget && e.propertyName === 'width') window.dispatchEvent(new Event('resize'))
        }}>
            <div className="sidenav-head">
                {open && <span className="brand">thgrid</span>}
                <button type="button" className="sidenav-item sidenav-toggle" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={toggleLabel} data-label={toggleLabel}>
                    {open ? ICONS.collapse : ICONS.expand}
                </button>
            </div>
            {NAV.map(n => {
                const active = section === n.path.slice(1)
                return (
                    <a key={n.path} href={hrefTo(n.path)} className={`sidenav-item ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined} aria-label={n.label} data-label={n.label}>
                        <span className="sidenav-icon">{n.icon}</span>
                        <span className="sidenav-label">{n.label}</span>
                    </a>
                )
            })}
            {version && <span className="sidenav-foot" title={`backend v${version}`}>{open ? `backend v${version}` : `v${version}`}</span>}
        </nav>
    )
}
