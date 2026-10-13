import {useMemo, useState} from 'react'
import type {AnyNetworkRecord, NetworkCollectionName, NetworkDocument, NetworkRecordOf} from '@shared/network/records'
import {defaultNamingFor, NAME_REGENERABLE_COLLECTIONS, Naming, REGENERABLE_COLLECTIONS, regenerateNamingOps, RegenerateTarget} from '@shared/network/naming'
import {useNetworkEditor} from './NetworkContext'

export const targetKey = (t: RegenerateTarget) => `${t.collection}:${t.id}`

/**
 * The id / name the model rules give a record *as it is being edited*: the
 * draft is substituted for the stored record before the rules run, so an
 * edited code, number, name or voltage is reflected at once.
 */
export function draftNaming<C extends NetworkCollectionName>(doc: NetworkDocument, collection: C, draft: NetworkRecordOf<C>): Naming | undefined {
    const probe = {...doc, [collection]: (doc[collection] as AnyNetworkRecord[]).map(r => r.id === draft.id ? draft : r)} as NetworkDocument
    return defaultNamingFor(probe, collection, draft.id)
}

export function collectionLabel(c: NetworkCollectionName): string {
    switch (c) {
        case 'substationGroups':
            return 'site'
        case 'generationUnits':
            return 'generation unit'
        case 'substations':
            return 'yard'
        case 'buses':
            return 'bus'
        case 'takeOffs':
            return 'take-off'
        case 'equipments':
            return 'equipment'
        default:
            return c.replace(/s$/, '')
    }
}

/**
 * "Regenerate from model rules" for a set of checked records: id / name
 * toggles, a preview of every change (`old → new`) and a button that applies
 * the plan of `regenerateNamingOps` as one journaled, undoable step. Renders
 * nothing while no target is given.
 */
export function RegenerateBox({targets, onApplied}: { targets: RegenerateTarget[]; onApplied?: () => void }) {
    const ed = useNetworkEditor()
    const [regenId, setRegenId] = useState(true)
    const [regenName, setRegenName] = useState(true)
    const plan = useMemo(() => targets.length && (regenId || regenName) ? regenerateNamingOps(ed.doc, targets, {id: regenId, name: regenName}) : undefined, [ed.doc, targets, regenId, regenName])
    if (targets.length === 0) return null
    const nameable = targets.some(t => NAME_REGENERABLE_COLLECTIONS.includes(t.collection))
    const apply = () => {
        if (!plan || !plan.ops.length) return
        if (!window.confirm(`Regenerate ${[regenId ? 'id' : '', regenName && nameable ? 'name' : ''].filter(Boolean).join(' and ')} of ${plan.changes.length} record${plan.changes.length === 1 ? '' : 's'} from the model rules? Every reference follows the new ids.`)) return
        if (ed.apply(plan.ops)) onApplied?.()
    }
    return (
        <div className="regen-box">
            <div className="toolbar small">
                <strong>Regenerate from model rules</strong>
                <label style={{display: 'flex', gap: 4, alignItems: 'center'}}><input type="checkbox" checked={regenId} onChange={e => setRegenId(e.target.checked)}/> id</label>
                <label style={{display: 'flex', gap: 4, alignItems: 'center'}} title={nameable ? 'Name from the code / number / line name, or from the ends of a path, circuit or line' : 'Sites and junctions keep the name you gave them and yards their display name'}>
                    <input type="checkbox" checked={regenName} disabled={!nameable} onChange={e => setRegenName(e.target.checked)}/> name
                </label>
                <span className="spacer" style={{flex: 1}}/>
                <button type="button" className="small primary" disabled={!plan || plan.ops.length === 0} onClick={apply}>Regenerate {plan?.changes.length ?? 0}</button>
            </div>
            {plan && plan.changes.length === 0 && <p className="small muted" style={{margin: '4px 0 0'}}>Every checked record already follows the rules.</p>}
            {plan && plan.changes.length > 0 && (
                <ul className="small regen-list">
                    {plan.changes.slice(0, 30).map(c => (
                        <li key={targetKey(c)}>
                            <span className="badge">{collectionLabel(c.collection)}</span>{' '}
                            {c.newName !== undefined && <span>{c.oldName ?? <i className="muted">no name</i>} → <b>{c.newName}</b></span>}
                            {c.newName !== undefined && c.newId && ' · '}
                            {c.newId && <span className="mono">{c.id} → <b>{c.newId}</b></span>}
                        </li>
                    ))}
                    {plan.changes.length > 30 && <li className="muted">…and {plan.changes.length - 30} more</li>}
                </ul>
            )}
            <p className="small muted" style={{margin: '4px 0 0'}}>Sites regenerate their id only (<span className="mono">SSG_&lt;code&gt;</span>) and keep the name you gave them, junctions their id from their name (<span className="mono">TJT_&lt;name&gt;</span>; an unnamed site junction from the site code); a yard keeps its display name. Parallel paths, circuits and lines are numbered in the order of the numbers their names already carry, so a second run changes nothing. Rules exist for: {REGENERABLE_COLLECTIONS.map(collectionLabel).join(', ')}.</p>
        </div>
    )
}

/**
 * One-click "regenerate id and name from the model rules" for a single
 * record, e.g. after its code was changed. Disabled when the record already
 * follows the rules; the selection follows a renamed id.
 */
export function RegenerateButton({target, label}: { target: RegenerateTarget; label?: string }) {
    const ed = useNetworkEditor()
    const plan = useMemo(() => regenerateNamingOps(ed.doc, [target], {id: true, name: true}), [ed.doc, target])
    const change = plan.changes[0]
    const title = change
        ? [change.newName !== undefined ? `name → ${change.newName}` : '', change.newId ? `id → ${change.newId}` : ''].filter(Boolean).join(', ')
        : 'Already follows the model rules'
    return (
        <button type="button" className="small" disabled={!change} title={title} onClick={() => {
            if (!change) return
            if (ed.apply(plan.ops) && change.newId) ed.select({collection: target.collection, id: change.newId})
        }}>{label ?? 'Auto id / name'}</button>
    )
}
