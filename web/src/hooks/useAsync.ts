import {DependencyList, useCallback, useEffect, useState} from 'react'

export interface AsyncState<T> {
    data?: T
    error?: Error
    loading: boolean
    reload: () => void
}

/** Runs `fn` whenever `deps` change; exposes data/error/loading and a manual reload. */
export function useAsync<T>(fn: () => Promise<T>, deps: DependencyList): AsyncState<T> {
    const [state, setState] = useState<{ data?: T; error?: Error; loading: boolean }>({loading: true})
    const [tick, setTick] = useState(0)
    useEffect(() => {
        let cancelled = false
        setState(s => ({...s, loading: true, error: undefined}))
        fn().then(
            data => !cancelled && setState({data, loading: false}),
            error => !cancelled && setState(s => ({...s, error: error as Error, loading: false})),
        )
        return () => {
            cancelled = true
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [...deps, tick])
    const reload = useCallback(() => setTick(t => t + 1), [])
    return {...state, reload}
}
