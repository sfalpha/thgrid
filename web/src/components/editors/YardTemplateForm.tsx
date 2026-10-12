import type {SubstationBusTemplate, SubstationYardTemplate} from '@shared/templates/substation.yard'
import {SubstationBusType} from '@shared/models/substation.bus'
import type {SubstationArrangement} from '@shared/models/substation'
import type {TransmissionVoltage} from '@shared/models/transmission.voltage'
import {issueFor, SelectField, TextField} from '../fields'
import {EditorProps} from './ConductorForm'

/** Name a bus template gets from its type and number (`MAIN_BUS_1`, `TRANSFER_BUS`). */
export function busTemplateName(busType: SubstationBusType, busNumber?: string): string {
    return busType === SubstationBusType.TRANSFER ? 'TRANSFER_BUS' : `MAIN_BUS_${busNumber || '1'}`
}

export function YardTemplateForm({data, onChange, issues, meta}: EditorProps<SubstationYardTemplate>) {
    const set = <K extends keyof SubstationYardTemplate>(key: K, value: SubstationYardTemplate[K]) => onChange({...data, [key]: value})
    const buses = data.buses ?? []
    const setBus = (i: number, patch: Partial<SubstationBusTemplate>) => set('buses', buses.map((b, n) => n === i ? {...b, ...patch} : b))
    const addBus = () => {
        const mains = buses.filter(b => b.busType === SubstationBusType.MAIN).length
        const number = String(mains + 1)
        set('buses', [...buses, {name: busTemplateName(SubstationBusType.MAIN, number), busType: SubstationBusType.MAIN, busNumber: number, row: Math.max(-1, ...buses.map(b => b.row)) + 1}])
    }
    return (
        <>
            <div className="form-grid">
                <TextField label="Name" value={data.name} onChange={v => set('name', v)} error={issueFor(issues, 'name')} placeholder="YARD_115KV_MAIN_TRANSFER" className="span-2"/>
                <SelectField label="Arrangement" value={data.arrangement} options={meta.enums.substationArrangement}
                             onChange={v => set('arrangement', v as SubstationArrangement)} error={issueFor(issues, 'arrangement')}/>
                <SelectField label="Voltage" value={data.voltage} options={meta.enums.transmissionVoltage} allowEmpty emptyLabel="(any)"
                             onChange={v => set('voltage', v as TransmissionVoltage | undefined)} error={issueFor(issues, 'voltage')}
                             hint="Informational: a deployed yard keeps its own voltage"/>
            </div>
            <div className="toolbar" style={{marginTop: 12}}>
                <h4 className="muted" style={{margin: 0, flex: 1}}>Buses</h4>
                <button type="button" className="small" onClick={addBus}>+ Bus</button>
            </div>
            {issueFor(issues, 'buses') && <p className="error small">{issueFor(issues, 'buses')}</p>}
            <table>
                <thead>
                <tr>
                    <th>Name</th>
                    <th>Type</th>
                    <th>Number</th>
                    <th>Row</th>
                    <th style={{width: 1}}/>
                </tr>
                </thead>
                <tbody>
                {buses.map((b, i) => {
                    const err = ['name', 'busType', 'busNumber', 'row'].map(k => issueFor(issues, `buses.${i}.${k}`)).find(Boolean) ?? issueFor(issues, `buses.${i}`)
                    return (
                        <tr key={i} title={err}>
                            <td><input type="text" className="mono" value={b.name} onChange={e => setBus(i, {name: e.target.value})} style={err ? {borderColor: 'var(--danger)'} : undefined}/></td>
                            <td>
                                <select value={b.busType} onChange={e => {
                                    const busType = e.target.value as SubstationBusType
                                    const auto = b.name === busTemplateName(b.busType, b.busNumber)
                                    setBus(i, {busType, busNumber: busType === SubstationBusType.TRANSFER ? undefined : b.busNumber || '1', name: auto ? busTemplateName(busType, b.busNumber || '1') : b.name})
                                }}>
                                    {meta.enums.substationBusType.map(t => <option key={t} value={t}>{t}</option>)}
                                </select>
                            </td>
                            <td>
                                <input type="text" value={b.busNumber ?? ''} disabled={b.busType === SubstationBusType.TRANSFER} style={{width: 60}} onChange={e => {
                                    const auto = b.name === busTemplateName(b.busType, b.busNumber)
                                    setBus(i, {busNumber: e.target.value || undefined, name: auto ? busTemplateName(b.busType, e.target.value) : b.name})
                                }}/>
                            </td>
                            <td><input type="number" value={b.row} min={0} step={1} style={{width: 70}} onChange={e => setBus(i, {row: Number(e.target.value)})}/></td>
                            <td><button type="button" className="small danger" onClick={() => set('buses', buses.filter((_, n) => n !== i))}>×</button></td>
                        </tr>
                    )
                })}
                {buses.length === 0 && <tr><td colSpan={5} className="muted small">No buses: the yard template only sets the arrangement.</td></tr>}
                </tbody>
            </table>
            <p className="hint">Row 0 is the bottom of the diagram. Bay templates count their rows from a bus row (up from the lowest, down from the highest).</p>
        </>
    )
}
