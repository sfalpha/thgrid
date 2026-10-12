import type {BayEquipmentTemplate, SubstationBayTemplate} from '@shared/templates/substation.bay'
import type {BayTemplateType} from '@shared/models/substation.bay'
import type {SubstationArrangement} from '@shared/models/substation'
import {SubstationEquipmentType} from '@shared/models/substation.equipment'
import {issueFor, SelectField, TextField} from '../fields'
import {equipmentTypeLabels} from '../../network/symbols'
import {EditorProps} from './ConductorForm'

export const BAY_TEMPLATE_TYPE_LABELS: Record<string, string> = {
    TAKEOFF: 'Take-off (line)',
    BUS_TIE: 'Bus tie',
    HIGH_SIDE_TRANSFORMER: 'Transformer, high side',
    LOW_SIDE_TRANSFORMER: 'Transformer, low side',
    CAPACITOR_BANK: 'Capacitor bank',
    SHUNT_REACTOR: 'Shunt reactor',
    STATIC_VAR_COMPENSATOR: 'Static VAR compensator',
}

export function BayTemplateForm({data, onChange, issues, meta}: EditorProps<SubstationBayTemplate>) {
    const set = <K extends keyof SubstationBayTemplate>(key: K, value: SubstationBayTemplate[K]) => onChange({...data, [key]: value})
    const equipments = data.equipments ?? []
    const arrangements = data.arrangements ?? []
    const setEq = (i: number, patch: Partial<BayEquipmentTemplate>) => set('equipments', equipments.map((e, n) => n === i ? {...e, ...patch} : e))
    const addEq = () => set('equipments', [...equipments, {equipmentType: SubstationEquipmentType.DISCONNECTING_SWITCH, sequence: Math.max(0, ...equipments.map(e => e.sequence)) + 1}])
    const toggleArrangement = (a: string) => set('arrangements', arrangements.includes(a as SubstationArrangement) ? arrangements.filter(x => x !== a) : [...arrangements, a as SubstationArrangement])
    return (
        <>
            <div className="form-grid">
                <TextField label="Name" value={data.name} onChange={v => set('name', v)} error={issueFor(issues, 'name')} placeholder="BAY_115KV_LINE_MAIN_TRANSFER" className="span-2"/>
                <SelectField label="Bay type" value={data.bayTemplateType} options={meta.enums.bayTemplateType.map(t => ({value: t, label: BAY_TEMPLATE_TYPE_LABELS[t] ?? t}))}
                             onChange={v => set('bayTemplateType', v as BayTemplateType)} error={issueFor(issues, 'bayTemplateType')}/>
            </div>
            <h4 className="muted" style={{margin: '12px 0 4px'}}>Suits arrangements</h4>
            {issueFor(issues, 'arrangements') && <p className="error small">{issueFor(issues, 'arrangements')}</p>}
            <div style={{display: 'flex', flexWrap: 'wrap', gap: '4px 14px'}}>
                {meta.enums.substationArrangement.map(a => (
                    <label key={a} style={{display: 'flex', alignItems: 'center', gap: 6}} className="small">
                        <input type="checkbox" checked={arrangements.includes(a as SubstationArrangement)} onChange={() => toggleArrangement(a)}/>
                        {a}
                    </label>
                ))}
            </div>
            <div className="toolbar" style={{marginTop: 12}}>
                <h4 className="muted" style={{margin: 0, flex: 1}}>Equipment</h4>
                <button type="button" className="small" onClick={() => set('equipments', [...equipments].sort((a, b) => a.sequence - b.sequence))} disabled={equipments.length < 2}>Sort</button>
                <button type="button" className="small" onClick={addEq}>+ Equipment</button>
            </div>
            {issueFor(issues, 'equipments') && <p className="error small">{issueFor(issues, 'equipments')}</p>}
            <table>
                <thead>
                <tr>
                    <th style={{width: 70}}>Seq.</th>
                    <th>Type</th>
                    <th>Line side</th>
                    <th>Bus tie</th>
                    <th style={{width: 1}}/>
                </tr>
                </thead>
                <tbody>
                {equipments.map((e, i) => {
                    const err = ['equipmentType', 'sequence', 'lineSide', 'busTie'].map(k => issueFor(issues, `equipments.${i}.${k}`)).find(Boolean) ?? issueFor(issues, `equipments.${i}`)
                    return (
                        <tr key={i} title={err}>
                            <td><input type="number" value={e.sequence} min={0} step={1} style={{width: 60, borderColor: err ? 'var(--danger)' : undefined}} onChange={ev => setEq(i, {sequence: Number(ev.target.value)})}/></td>
                            <td>
                                <select value={e.equipmentType} onChange={ev => setEq(i, {equipmentType: ev.target.value as SubstationEquipmentType})}>
                                    {(Object.keys(equipmentTypeLabels) as SubstationEquipmentType[]).map(t => <option key={t} value={t}>{equipmentTypeLabels[t]}</option>)}
                                </select>
                            </td>
                            <td><input type="checkbox" checked={!!e.lineSide} onChange={ev => setEq(i, {lineSide: ev.target.checked || undefined})}/></td>
                            <td><input type="checkbox" checked={!!e.busTie} onChange={ev => setEq(i, {busTie: ev.target.checked || undefined})}/></td>
                            <td><button type="button" className="small danger" onClick={() => set('equipments', equipments.filter((_, n) => n !== i))}>×</button></td>
                        </tr>
                    )
                })}
                {equipments.length === 0 && <tr><td colSpan={5} className="muted small">No equipment yet.</td></tr>}
                </tbody>
            </table>
            <p className="hint">
                Sequence = rows from the start row when deployed (row = start ± sequence, up or down). 0 is the start row itself, usually a bus, so start at 1;
                skipped numbers leave blank rows. Line side flags the equipment of the take-off column: it is deployed there (the bay's take-off is created above it when missing), ground switch first, then CT, PT; a power transformer should be wired to line-side equipment. Bus tie tags the transfer / bus-tie switch. Deployed equipment has no connections (use Connect bay).
            </p>
        </>
    )
}
