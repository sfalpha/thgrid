import {useCallback, useEffect, useState} from 'react'

/**
 * Minimal hash router. Routes look like `#/templates/POWER_TRANSFORMER/tr_230kv`.
 * Returns the decoded path segments and a `navigate` helper.
 */
export interface HashRoute {
    segments: string[]
    path: string
}

function parse(): HashRoute {
    const raw = window.location.hash.replace(/^#\/?/, '')
    const segments = raw.split('/').filter(Boolean).map(decodeURIComponent)
    return {segments, path: '/' + segments.join('/')}
}

export function useHashRoute(): [HashRoute, (path: string) => void] {
    const [route, setRoute] = useState<HashRoute>(parse)
    useEffect(() => {
        const onChange = () => setRoute(parse())
        window.addEventListener('hashchange', onChange)
        return () => window.removeEventListener('hashchange', onChange)
    }, [])
    const navigate = useCallback((path: string) => {
        const next = '#' + (path.startsWith('/') ? path : '/' + path)
        if (window.location.hash === next) setRoute(parse())
        else window.location.hash = next
    }, [])
    return [route, navigate]
}

export function hrefTo(path: string): string {
    return '#' + (path.startsWith('/') ? path : '/' + path)
}
