import {useCallback, useEffect, useState} from 'react'

const KEY = 'thgrid.sidePanelWidth'
const MIN = 280
const MAX_FRACTION = 0.7

/**
 * Width of the resizable side panel of the editors, remembered per browser.
 * Returns the width and a mousedown handler for the drag handle.
 */
export function useSideWidth(defaultWidth = 360): [number, (e: React.MouseEvent) => void] {
    const [width, setWidth] = useState<number>(() => {
        try {
            const stored = Number(window.localStorage.getItem(KEY))
            return Number.isFinite(stored) && stored >= MIN ? stored : defaultWidth
        } catch {
            return defaultWidth
        }
    })

    useEffect(() => {
        try {
            window.localStorage.setItem(KEY, String(width))
        } catch {
            /* private mode etc. */
        }
    }, [width])

    const onMouseDown = useCallback((e: React.MouseEvent) => {
        e.preventDefault()
        const startX = e.clientX
        const startWidth = width
        const max = Math.max(MIN, Math.floor(window.innerWidth * MAX_FRACTION))
        const prevCursor = document.body.style.cursor
        const prevSelect = document.body.style.userSelect
        document.body.style.cursor = 'col-resize'
        document.body.style.userSelect = 'none'
        const onMove = (ev: MouseEvent) => setWidth(Math.min(max, Math.max(MIN, startWidth + (startX - ev.clientX))))
        const onUp = () => {
            document.body.style.cursor = prevCursor
            document.body.style.userSelect = prevSelect
            window.removeEventListener('mousemove', onMove)
            window.removeEventListener('mouseup', onUp)
            window.dispatchEvent(new Event('resize'))
        }
        window.addEventListener('mousemove', onMove)
        window.addEventListener('mouseup', onUp)
    }, [width])

    return [width, onMouseDown]
}
