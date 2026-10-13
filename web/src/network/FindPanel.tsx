import {useEffect, useMemo, useRef, useState} from 'react'
import {Selection, useNetworkEditor} from './NetworkContext'
import {circuitWarnings, pathStatus, refLabel} from './linkOps'
import {duplicatePathGroups} from './mergePaths'
import {buildCircuitGraph, lineWarnings} from '@shared/network/lines'
import type {RegenerateTarget} from '@shared/network/naming'
import {RegenerateBox, targetKey} from './RegenerateBox'
import {capacityText, generationUnitsOf, voltageColor, voltageKv} from './mapUtil'
import {VoltageSymbol} from './symbols'
import {cascadeDeleteOps, NetworkOp} from '@shared/network/ops'
import type {NetworkCollectionName} from '@shared/network/records'
import {GENERATION_BADGES, GENERATION_LABELS, GENERATION_SITE_COLOR, GenerationType} from '@shared/models/generation'
import {confirmDeleteLines, linesRemovedBy, linesRemovedNote} from './deleteLines'

type Kind = 'all' | 'sites' | 'yards' | 'junctions' | 'paths' | 'circuits' | 'lines'

interface Row {
    sel: Selection
    kind: Exclude<Kind, 'all'>
    label: string
    detail?: string
    /** One voltage square (circuits, lines). */
    color?: string
    /** A site's yards, highest voltage first, each shown with its voltage symbol in front of its name. */
    yards?: { name: string; voltage: string; planned?: boolean }[]
    /** A yard row: its voltage symbol (dulled when planned). */
    symbol?: { voltage: string; planned?: boolean }
    /** Generation site: a G badge plus one lettered badge per generation type. */
    generation?: GenerationType[]
    /** Attention indicator text (loose end, no path end, unused, ...). */
    warn?: string
    /** Not built yet (grey on the map). */
    planned?: boolean
    /** The record whose id / name the model rules can regenerate (a site or junction: its id only). */
    target?: RegenerateTarget
    /** What the row's × deletes, with the confirmation text; lines use the delete-line dialog instead. */
    del?: { collection: NetworkCollectionName; id: string; confirm: string }
}


/** Rows per page of the result list. */
const PAGE_SIZE = 100

/**
 * Search box over sites, yards, junctions, paths, circuits and lines with an
 * attention indicator for detached paths / circuits. Selecting a row selects
 * the record and pans the map to it. Rows of regenerable records carry a
 * checkbox: the checked ones can get their id and / or name re-derived from
 * the model rules in one journaled step. Results are paged, `PAGE_SIZE` rows
 * at a time.
 */
export type FindKind = Exclude<Kind, 'all'>
export const FIND_KINDS: { kind: FindKind; label: string }[] = [
    {kind: 'sites', label: 'Sites'}, {kind: 'yards', label: 'Yards'}, {kind: 'junctions', label: 'Junctions'},
    {kind: 'paths', label: 'Paths'}, {kind: 'circuits', label: 'Circuits'}, {kind: 'lines', label: 'Lines'},
]

/**
 * `fixedKind` turns the panel into the list of one record type (a tab of the
 * overview); without it the result types can be limited with the chips. Rows
 * are sorted by name. `embedded`: no panel frame of its own.
 */
export function FindPanel({locate, autoFocus, fixedKind, embedded}: { locate?: (sel: Selection) => void; autoFocus?: boolean; fixedKind?: FindKind; embedded?: boolean }) {
    const ed = useNetworkEditor()
    const [query, setQuery] = useState('')
    /** Result types to show; empty = every type. Ignored when `fixedKind` is set. */
    const [kinds, setKinds] = useState<Set<FindKind>>(new Set())
    const [onlyWarn, setOnlyWarn] = useState(false)
    const [checked, setChecked] = useState<Set<string>>(new Set())
    /** Zero-based page of the results; back to the first page whenever the search or the filters change. */
    const [page, setPage] = useState(0)
    const listRef = useRef<HTMLDivElement>(null)
    const doc = ed.doc

    const rows = useMemo<Row[]>(() => {
        const out: Row[] = []
        for (const g of doc.substationGroups) {
            const yards = doc.substations.filter(s => s.groupId === g.id)
            const units = generationUnitsOf(doc, g.id)
            const byVoltage = [...yards].sort((a, b) => voltageKv(b.voltage) - voltageKv(a.voltage) || a.yardName.localeCompare(b.yardName))
            out.push({
                sel: {collection: 'substationGroups', id: g.id}, kind: 'sites', label: g.groupName, planned: g.planned,
                detail: [g.name !== g.groupName ? g.name : '', g.generation && units.length ? `${units.length} unit${units.length === 1 ? '' : 's'}, ${capacityText(units)}` : ''].filter(Boolean).join(' · ') || undefined,
                yards: byVoltage.map(y => ({name: y.yardName, voltage: y.voltage, planned: y.planned || g.planned})), generation: g.generation ? (g.generationTypes ?? []) : undefined,
                warn: yards.length ? undefined : 'no yards', target: {collection: 'substationGroups', id: g.id},
                del: {collection: 'substationGroups', id: g.id, confirm: `Delete site ${g.groupName} with its ${yards.length} yard(s), everything in them and its site junction? Paths ending there lose that end.`},
            })
            for (const y of yards) out.push({
                sel: {collection: 'substationGroups', id: g.id}, kind: 'yards', label: `${g.groupName} ${y.yardName}`, planned: y.planned || g.planned, detail: y.voltage, symbol: {voltage: y.voltage, planned: y.planned || g.planned}, target: {collection: 'substations', id: y.id},
                del: {collection: 'substations', id: y.id, confirm: `Delete yard ${g.groupName} ${y.yardName} with all its buses, bays, equipment and take-offs? Circuits attached at its take-offs lose that end.`},
            })
        }
        for (const j of doc.junctions) {
            const n = doc.connections.filter(c => c.junction.id === j.id).length
            const site = j.groupId ? doc.substationGroups.find(g => g.id === j.groupId) : undefined
            out.push({
                sel: {collection: 'junctions', id: j.id}, kind: 'junctions', label: j.name ?? j.id, detail: `${n} node${n === 1 ? '' : 's'}${site ? ` · site junction of ${site.groupName}` : ''}`, warn: n ? undefined : 'no circuits', target: {collection: 'junctions', id: j.id},
                del: {collection: 'junctions', id: j.id, confirm: `Delete junction ${j.name ?? j.id} and its ${n} node(s)? Circuit ends there come loose and paths ending there lose that end.`},
            })
        }
        // paths between the same two places (either direction): merge them from the path panel or the Paths tab
        const sameEnds = new Map<string, string[]>()
        for (const g of duplicatePathGroups(doc)) for (const p of g) sameEnds.set(p.id, g.filter(x => x !== p).map(x => x.name))
        for (const p of doc.paths) {
            const s = pathStatus(doc, p.id)
            const warn = [sameEnds.has(p.id) ? `same ends as ${sameEnds.get(p.id)!.join(', ')}` : '', s.noFrom && s.noTo ? 'no ends' : s.noFrom ? 'no FROM end' : s.noTo ? 'no TO end' : '', s.unused ? 'no circuits' : '', s.looseCircuits ? `${s.looseCircuits} loose circuit${s.looseCircuits === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ')
            const onPath = doc.circuits.filter(c => c.pathId === p.id).length
            out.push({
                sel: {collection: 'paths', id: p.id}, kind: 'paths', label: p.name, detail: `${p.waypoints.length} pts · ${onPath} circuits`, warn: warn || undefined, target: {collection: 'paths', id: p.id},
                del: {collection: 'paths', id: p.id, confirm: onPath ? `Delete path ${p.name}? Its ${onPath} circuit(s) stay, without a path (drawn as dashed lines between their ends).` : `Delete the unused path ${p.name}?`},
            })
        }
        for (const c of doc.circuits) {
            const warn = circuitWarnings(doc, c.id).join(', ')
            const path = doc.paths.find(p => p.id === c.pathId)
            const reVolted = !!c.energizedVoltage && c.energizedVoltage !== c.voltage
            // lines that keep other sections (a line with this as its only section is named by the delete's confirmation)
            const inLines = doc.lines.filter(l => l.circuitIds.includes(c.id) && l.circuitIds.length > 1)
            out.push({
                sel: {collection: 'circuits', id: c.id}, kind: 'circuits', label: c.name, planned: c.planned, detail: [c.voltage, reVolted ? `energized ${c.energizedVoltage}` : '', c.bundle ? `${c.bundle}x` : '', path?.name ?? 'no path'].filter(Boolean).join(' · '), color: voltageColor(c.energizedVoltage ?? c.voltage), warn: warn || undefined, target: {collection: 'circuits', id: c.id},
                del: {collection: 'circuits', id: c.id, confirm: `Delete circuit ${c.name}?${inLines.length ? ` It is a section of line ${inLines.map(l => l.name).join(', ')}, which keeps its other sections.` : ''} Its path and take-offs are kept.`},
            })
        }
        const graph = buildCircuitGraph(doc)
        for (const l of doc.lines) {
            const warn = lineWarnings(doc, l, graph).join(', ')
            out.push({
                sel: {collection: 'lines', id: l.id}, kind: 'lines', label: l.name, planned: l.planned, detail: `${refLabel(doc, l.from)} → ${refLabel(doc, l.to)} · ${l.circuitIds.length} section${l.circuitIds.length === 1 ? '' : 's'}`, color: voltageColor(l.voltage), warn: warn || undefined, target: {collection: 'lines', id: l.id},
                del: {collection: 'lines', id: l.id, confirm: ''},
            })
        }
        return out
    }, [doc])

    // Drop checks of records that disappeared (deleted, or renamed by a regeneration).
    useEffect(() => {
        const alive = new Set(rows.filter(r => r.target).map(r => targetKey(r.target!)))
        setChecked(prev => {
            const next = new Set([...prev].filter(k => alive.has(k)))
            return next.size === prev.size ? prev : next
        })
    }, [rows])

    const q = query.trim().toLowerCase()
    const kindOk = (r: Row) => fixedKind ? r.kind === fixedKind : kinds.size === 0 || kinds.has(r.kind)
    const matches = rows
        .filter(r => kindOk(r) && (!onlyWarn || r.warn) && (!q || r.label.toLowerCase().includes(q) || (r.detail ?? '').toLowerCase().includes(q) || r.sel.id.toLowerCase().includes(q)))
        .sort((a, b) => a.label.localeCompare(b.label, undefined, {numeric: true, sensitivity: 'base'}) || a.kind.localeCompare(b.kind))
    const warnCount = rows.filter(r => kindOk(r) && r.warn).length
    const toggleKind = (k: FindKind) => {
        setPage(0)
        setKinds(prev => {
            const next = new Set(prev)
            if (next.has(k)) next.delete(k)
            else next.add(k)
            return next
        })
    }
    // Clamped, so deleting rows on the last page falls back to the page before.
    const pageCount = Math.max(1, Math.ceil(matches.length / PAGE_SIZE))
    const current = Math.min(page, pageCount - 1)
    const shown = matches.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE)
    const goTo = (p: number) => {
        setPage(p)
        listRef.current?.scrollTo({top: 0})
    }
    const shownTargets = shown.filter(r => r.target).map(r => r.target!)
    const allShownChecked = shownTargets.length > 0 && shownTargets.every(t => checked.has(targetKey(t)))

    const toggle = (t: RegenerateTarget) => setChecked(prev => {
        const next = new Set(prev)
        const k = targetKey(t)
        if (next.has(k)) next.delete(k)
        else next.add(k)
        return next
    })
    const toggleAllShown = () => setChecked(prev => {
        const next = new Set(prev)
        for (const t of shownTargets) {
            if (allShownChecked) next.delete(targetKey(t))
            else next.add(targetKey(t))
        }
        return next
    })

    /** Targets in document order (the order of the preview). */
    const targets = useMemo(() => rows.filter(r => r.target && checked.has(targetKey(r.target))).map(r => r.target!), [rows, checked])

    const pick = (r: Row) => {
        ed.select(r.sel)
        locate?.(r.sel)
    }
    /** The row's ×: lines go through the delete-line dialog (circuits / take-offs / connections only it uses), the rest confirm and cascade. */
    const remove = (r: Row) => {
        if (!r.del) return
        let ops: NetworkOp[] | undefined
        let confirmedLineIds: string[] = []
        if (r.del.collection === 'lines') {
            ops = confirmDeleteLines(doc, [r.del.id])
            confirmedLineIds = [r.del.id]
        } else {
            // the confirmation names the lines the delete leaves without circuits (removed with it)
            const cascade = cascadeDeleteOps(doc, r.del.collection, r.del.id)
            const lost = linesRemovedBy(doc, cascade)
            if (window.confirm(r.del.confirm + linesRemovedNote(lost))) {
                ops = cascade
                confirmedLineIds = lost.map(l => l.id)
            }
        }
        if (!ops) return
        const selected = ed.selection
        if (ed.apply(ops, {confirmedLineIds}) && selected && (selected.collection === r.del.collection && selected.id === r.del.id || selected.collection === r.sel.collection && selected.id === r.sel.id && r.kind !== 'yards')) ed.select(null)
    }

    const kindLabel = fixedKind ? FIND_KINDS.find(k => k.kind === fixedKind)!.label.toLowerCase() : undefined
    const body = (
        <>
            <div className="toolbar">
                <input type="search" autoFocus={autoFocus} placeholder={kindLabel ? `Search ${kindLabel} by name or id…` : 'Search by name or id…'} value={query} onChange={e => {
                    setQuery(e.target.value)
                    setPage(0)
                }} style={{flex: 1, minWidth: 120}}/>
                {warnCount > 0 && <label className="small" style={{display: 'flex', gap: 4, alignItems: 'center', whiteSpace: 'nowrap'}} title="Only rows that need attention">
                    <input type="checkbox" checked={onlyWarn} onChange={e => {
                        setOnlyWarn(e.target.checked)
                        setPage(0)
                    }}/> <span className="warn-dot">⚠</span> {warnCount}
                </label>}
            </div>
            {!fixedKind && (
                <div className="find-kinds small" title="Limit the result types (none checked = every type)">
                    {FIND_KINDS.map(k => (
                        <button key={k.kind} type="button" className={`chip ${kinds.has(k.kind) ? 'active' : ''}`} onClick={() => toggleKind(k.kind)}>{k.label}</button>
                    ))}
                    {kinds.size > 0 && <button type="button" className="chip clear" onClick={() => {
                        setKinds(new Set())
                        setPage(0)
                    }} title="Show every type">all</button>}
                </div>
            )}
            <div className="toolbar small" style={{marginTop: 6}}>
                <label title="Check every regenerable record on this page" style={{display: 'flex', gap: 4, alignItems: 'center'}}>
                    <input type="checkbox" checked={allShownChecked} disabled={shownTargets.length === 0} onChange={toggleAllShown}/> {pageCount > 1 ? 'all on page' : 'all shown'}
                </label>
                <span className="muted">{checked.size} checked</span>
                {checked.size > 0 && <button type="button" className="small" onClick={() => setChecked(new Set())}>clear</button>}
            </div>
            <div className="find-results" ref={listRef}>
                {matches.length === 0 && <p className="small muted" style={{margin: '8px 0 0'}}>Nothing matches.</p>}
                {shown.map(r => (
                    <div key={`${r.kind}:${r.sel.collection}:${r.sel.id}:${r.label}`} className="find-item">
                        {r.target
                            ? <input type="checkbox" checked={checked.has(targetKey(r.target))} onChange={() => toggle(r.target!)} title={r.kind === 'sites' || r.kind === 'junctions' ? 'Check to regenerate its id (the name stays)' : 'Check to regenerate its id / name'}/>
                            : <span className="find-nocheck" title="Named by you; not regenerated"/>}
                        <a href="#" className="find-row" onClick={e => {
                            e.preventDefault()
                            pick(r)
                        }}>
                            <span className="badge">{r.kind.replace(/s$/, '')}</span>
                            {r.symbol && <VoltageSymbol voltage={r.symbol.voltage} planned={r.symbol.planned}/>}
                            {r.color && <span style={{color: r.color}}>■</span>}
                            <span className="find-label">{r.label}</span>
                            {r.generation && (
                                <span className="map-gen-row find-gen" title={`Generation site${r.generation.length ? `: ${r.generation.map(t => GENERATION_LABELS[t] ?? t).join(', ')}` : ''}`}>
                                    <span className="map-gen-badge" style={{background: GENERATION_SITE_COLOR}}>G</span>
                                    {r.generation.map(t => GENERATION_BADGES[t] ? <span key={t} className="map-gen-badge" style={{background: GENERATION_BADGES[t].color}}>{GENERATION_BADGES[t].letter}</span> : null)}
                                </span>
                            )}
                            {r.detail && <span className="muted small find-detail">{r.detail}</span>}
                            {r.yards && r.yards.length > 0 && <span className="muted small find-detail find-yards">{r.yards.map((y, i) => <span key={i} title={y.planned ? 'planned' : undefined}><VoltageSymbol voltage={y.voltage} planned={y.planned}/> {y.name}</span>)}</span>}
                            {r.planned && <span className="tag planned" title="Not built yet">planned</span>}
                            {r.warn && <span className="warn-dot small" title={r.warn}>⚠ {r.warn}</span>}
                        </a>
                        {r.del && <button type="button" className="small danger find-delete" title={`Delete this ${r.kind.replace(/s$/, '')}`} onClick={() => remove(r)}>×</button>}
                    </div>
                ))}
            </div>
            {pageCount > 1 && (
                <div className="toolbar small find-pager">
                    <button type="button" className="small" disabled={current === 0} onClick={() => goTo(current - 1)}>‹ Previous</button>
                    <span className="muted">{current * PAGE_SIZE + 1}–{current * PAGE_SIZE + shown.length} of {matches.length}</span>
                    <button type="button" className="small" disabled={current >= pageCount - 1} onClick={() => goTo(current + 1)}>Next ›</button>
                </div>
            )}
            <RegenerateBox targets={targets} onApplied={() => setChecked(new Set())}/>
        </>
    )
    if (embedded) return body
    return (
        <div className="panel">
            <div className="panel-header">
                <h3 style={{margin: 0}}>{kindLabel ? FIND_KINDS.find(k => k.kind === fixedKind)!.label : 'Find'}</h3>
            </div>
            {body}
        </div>
    )
}
