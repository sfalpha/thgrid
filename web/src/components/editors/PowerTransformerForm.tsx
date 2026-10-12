import {useState} from 'react'
import type {PowerTransformerTemplate, TransformerWindingTemplate} from '@shared/templates/power.transformer'
import type {TransformerWindingRating} from '@shared/models/transformer'
import {TransformerCooling, TransformerWindingSide, TransformerWindingTapChanger, TransformerWindingWiring} from '@shared/models/transformer'
import {TransmissionVoltage} from '@shared/models/transmission.voltage'
import {WINDING_KEY_PATTERN} from '@shared/templates/validation'
import {issueFor, NumberField, SelectField, TextField} from '../fields'
import {EditorProps} from './ConductorForm'

export function defaultWinding(side: TransformerWindingSide = TransformerWindingSide.SECONDARY): TransformerWindingTemplate {
    return {
        windingSide: side,
        wiring: TransformerWindingWiring.STAR,
        voltage: TransmissionVoltage.AC115KV,
        tapChanger: TransformerWindingTapChanger.NONE,
        ratings: [],
    }
}

function defaultRating(): TransformerWindingRating {
    return {cooling: TransformerCooling.ONAN, power: 0, perModule: false}
}

/** Rebuilds the windings map with one key renamed, preserving order. */
function renameKey(windings: PowerTransformerTemplate['windings'], from: string, to: string) {
    const next: PowerTransformerTemplate['windings'] = {}
    for (const [k, v] of Object.entries(windings)) next[k === from ? to : k] = v
    return next
}

export function PowerTransformerForm({data, onChange, issues, meta}: EditorProps<PowerTransformerTemplate>) {
    return (
        <>
            <div className="form-grid">
                <TextField label="Name" value={data.name} onChange={v => onChange({...data, name: v})} error={issueFor(issues, 'name')}
                           placeholder="TR_230KV_115KV_A22KV_200MVA_ONAF" className="span-2"/>
                <NumberField label="Modules" value={data.modules} min={1} step={1} onChange={v => onChange({...data, modules: v as number})}
                             hint="1 for a three-phase unit, 3 for a bank of single-phase units" error={issueFor(issues, 'modules')}/>
            </div>
            <h3 style={{marginTop: 20}}>Windings</h3>
            <WindingsEditor windings={data.windings ?? {}} onChange={windings => onChange({...data, windings})} issues={issues} meta={meta}/>
        </>
    )
}

interface WindingsEditorProps {
    windings: PowerTransformerTemplate['windings']
    onChange: (windings: PowerTransformerTemplate['windings']) => void
    /** Issues with paths `windings.<key>…` (and `windings` for the map itself). */
    issues: EditorProps<unknown>['issues']
    meta: EditorProps<unknown>['meta']
}

/** The windings of a transformer (template or equipment record): one block per winding plus an add row; keys renameable. */
export function WindingsEditor({windings, onChange, issues, meta}: WindingsEditorProps) {
    const [newKey, setNewKey] = useState('')
    const keys = Object.keys(windings)
    const setWinding = (key: string, winding: TransformerWindingTemplate) => onChange({...windings, [key]: winding})
    const removeWinding = (key: string) => {
        const next = {...windings}
        delete next[key]
        onChange(next)
    }
    const addWinding = () => {
        const key = newKey.trim()
        if (!key || windings[key]) return
        const side = keys.length === 0 ? TransformerWindingSide.PRIMARY : keys.length === 1 ? TransformerWindingSide.SECONDARY : TransformerWindingSide.AUXILIARY
        onChange({...windings, [key]: defaultWinding(side)})
        setNewKey('')
    }
    const newKeyValid = newKey === '' || (WINDING_KEY_PATTERN.test(newKey) && !windings[newKey])
    return (
        <>
            {issueFor(issues, 'windings') && <div className="issues">{issueFor(issues, 'windings')}</div>}
            {keys.map(key => (
                <WindingEditor
                    key={key}
                    windingKey={key}
                    winding={windings[key]}
                    issues={issues}
                    meta={meta}
                    onChange={w => setWinding(key, w)}
                    onRename={to => onChange(renameKey(windings, key, to))}
                    onRemove={() => removeWinding(key)}
                    canRename={to => to === key || (WINDING_KEY_PATTERN.test(to) && !windings[to])}
                />
            ))}
            <div className="toolbar">
                <input
                    type="text"
                    className="mono"
                    style={{width: 120}}
                    placeholder="Key (H, X, Y…)"
                    value={newKey}
                    onChange={e => setNewKey(e.target.value.toUpperCase())}
                    onKeyDown={e => e.key === 'Enter' && addWinding()}
                />
                <button type="button" onClick={addWinding} disabled={!newKey || !newKeyValid}>Add winding</button>
                {!newKeyValid && <span className="small" style={{color: 'var(--danger)'}}>Key must be unique and match {WINDING_KEY_PATTERN.source}</span>}
            </div>
        </>
    )
}

interface WindingEditorProps {
    windingKey: string
    winding: TransformerWindingTemplate
    issues: EditorProps<unknown>['issues']
    meta: EditorProps<unknown>['meta']
    onChange: (w: TransformerWindingTemplate) => void
    onRename: (to: string) => void
    onRemove: () => void
    canRename: (to: string) => boolean
}

function WindingEditor({windingKey, winding, issues, meta, onChange, onRename, onRemove, canRename}: WindingEditorProps) {
    const [keyDraft, setKeyDraft] = useState(windingKey)
    const base = `windings.${windingKey}`
    const set = <K extends keyof TransformerWindingTemplate>(k: K, v: TransformerWindingTemplate[K]) => onChange({...winding, [k]: v})
    const ratings = winding.ratings ?? []
    const setRating = (i: number, r: TransformerWindingRating) => set('ratings', ratings.map((x, n) => n === i ? r : x))
    const commitRename = () => {
        const to = keyDraft.trim().toUpperCase()
        if (to && to !== windingKey && canRename(to)) onRename(to)
        else setKeyDraft(windingKey)
    }

    return (
        <div className="winding">
            <div className="winding-header">
                <input
                    type="text"
                    className="mono"
                    style={{width: 80, fontWeight: 700}}
                    value={keyDraft}
                    onChange={e => setKeyDraft(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={e => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                    title="Winding key"
                />
                <span className="muted small">{winding.windingSide} · {winding.wiring} · {winding.voltage}</span>
                <span className="spacer" style={{flex: 1}}/>
                <button type="button" className="small danger" onClick={onRemove}>Remove winding</button>
            </div>
            {issueFor(issues, base) && <div className="issues">{issueFor(issues, base)}</div>}
            <div className="form-grid">
                <SelectField label="Side" value={winding.windingSide} options={meta.enums.transformerWindingSide}
                             onChange={v => set('windingSide', v as TransformerWindingSide)} error={issueFor(issues, `${base}.windingSide`)}/>
                <SelectField label="Wiring" value={winding.wiring} options={meta.enums.transformerWindingWiring}
                             onChange={v => set('wiring', v as TransformerWindingWiring)} error={issueFor(issues, `${base}.wiring`)}/>
                <SelectField label="Voltage" value={winding.voltage} options={meta.enums.transmissionVoltage}
                             onChange={v => set('voltage', v as TransmissionVoltage)} error={issueFor(issues, `${base}.voltage`)}/>
                <SelectField label="Tap changer" value={winding.tapChanger} options={meta.enums.transformerWindingTapChanger}
                             onChange={v => set('tapChanger', v as TransformerWindingTapChanger)} error={issueFor(issues, `${base}.tapChanger`)}/>
            </div>

            <h4 style={{marginTop: 12}} className="muted">Ratings</h4>
            {ratings.length > 0 && (
                <table>
                    <thead>
                    <tr>
                        <th style={{width: '30%'}}>Cooling</th>
                        <th style={{width: '30%'}}>Power (kVA)</th>
                        <th>Per module</th>
                        <th style={{width: 1}}/>
                    </tr>
                    </thead>
                    <tbody>
                    {ratings.map((r, i) => {
                        const rp = `${base}.ratings.${i}`
                        return (
                            <tr key={i}>
                                <td>
                                    <select value={r.cooling} style={{minWidth: 84}} onChange={e => setRating(i, {...r, cooling: e.target.value as TransformerCooling})}>
                                        {meta.enums.transformerCooling.map(c => <option key={c} value={c}>{c}</option>)}
                                    </select>
                                    {issueFor(issues, `${rp}.cooling`) && <div className="error small">{issueFor(issues, `${rp}.cooling`)}</div>}
                                </td>
                                <td>
                                    <input type="number" min={0} step="any" value={Number.isFinite(r.power) ? r.power : ''}
                                           onChange={e => setRating(i, {...r, power: e.target.value === '' ? NaN : Number(e.target.value)})}/>
                                    {issueFor(issues, `${rp}.power`) && <div className="error small">{issueFor(issues, `${rp}.power`)}</div>}
                                </td>
                                <td>
                                    <input type="checkbox" checked={r.perModule} onChange={e => setRating(i, {...r, perModule: e.target.checked})}/>
                                </td>
                                <td>
                                    <button type="button" className="small danger" onClick={() => set('ratings', ratings.filter((_, n) => n !== i))}>×</button>
                                </td>
                            </tr>
                        )
                    })}
                    </tbody>
                </table>
            )}
            <div className="toolbar" style={{marginTop: 8}}>
                <button type="button" className="small" onClick={() => set('ratings', [...ratings, defaultRating()])}>Add rating</button>
                {ratings.length === 0 && <span className="muted small">No ratings (optional).</span>}
            </div>
        </div>
    )
}
