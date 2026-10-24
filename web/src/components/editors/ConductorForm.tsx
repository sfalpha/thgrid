import {conductorMountTypes, type TransmissionConductorTemplate} from '@shared/templates/transmission.conductor'
import {ConductorMountType, defaultMountTypes} from '@shared/models/transmission.conductor'
import type {ValidationIssue} from '@shared/templates/validation'
import type {MetaResponse} from '../../api/client'
import {enumLabel, Field, issueFor, NumberField, SelectField, TextField} from '../fields'

export interface EditorProps<D> {
    data: D
    onChange: (data: D) => void
    /** Issues with paths relative to `data` (e.g. `windings.H.voltage`). */
    issues: ValidationIssue[]
    meta: MetaResponse
}

export function ConductorForm({data, onChange, issues, meta}: EditorProps<TransmissionConductorTemplate>) {
    const set = <K extends keyof TransmissionConductorTemplate>(key: K, value: TransmissionConductorTemplate[K]) => onChange({...data, [key]: value})
    /** The mounts that suit the conductor: its list, else its wire type's (until one is ticked or cleared). */
    const mounts = conductorMountTypes(data)
    const byType = defaultMountTypes(data.type)
    const toggleMount = (m: ConductorMountType, on: boolean) =>
        set('mountTypes', (meta.enums.conductorMountType as ConductorMountType[]).filter(x => x === m ? on : mounts.includes(x)))
    return (
        <div className="form-grid">
            <TextField label="Name" value={data.name} onChange={v => set('name', v)} error={issueFor(issues, 'name')}
                       placeholder="TC_1272MCM_ACSR_GA" className="span-2"/>
            <TextField label="Code" value={data.code} onChange={v => set('code', v || undefined)} error={issueFor(issues, 'code')}
                       hint="Optional manufacturer or utility code"/>
            <NumberField label="Size" value={data.size} onChange={v => set('size', v as number)} min={0} error={issueFor(issues, 'size')}/>
            <SelectField label="Unit" value={data.unit} options={meta.enums.transmissionWireUnit}
                         onChange={v => set('unit', v as TransmissionConductorTemplate['unit'])} error={issueFor(issues, 'unit')}/>
            <SelectField label="Wire type" value={data.type} options={meta.enums.transmissionWireType}
                         onChange={v => set('type', v as TransmissionConductorTemplate['type'])} error={issueFor(issues, 'type')}/>
            <Field label="Mount types (how a circuit can carry this conductor)" className="span-all" error={issueFor(issues, 'mountTypes')}
                   hint={data.mountTypes ? 'A circuit taking this conductor keeps its mount type when listed, else takes the first of suspension I-string, duct bank, the first listed'
                       : `Not set: by the wire type (${data.type === 'XLPE' ? 'an XLPE cable: cable ladder, U-trench, duct bank, submarine' : 'an aerial conductor: every mount but the cable ones'})`}>
                <div className="mount-checks">
                    {(meta.enums.conductorMountType as ConductorMountType[]).map(m => (
                        <label key={m} className="inline-check small">
                            <input type="checkbox" checked={mounts.includes(m)} onChange={e => toggleMount(m, e.target.checked)}/> {enumLabel(m)}
                        </label>
                    ))}
                    {data.mountTypes && JSON.stringify(data.mountTypes) !== JSON.stringify(byType) && (
                        <button type="button" className="small" onClick={() => set('mountTypes', undefined)} title="Clear the list: the wire type's mounts">by wire type</button>
                    )}
                </div>
            </Field>
        </div>
    )
}
