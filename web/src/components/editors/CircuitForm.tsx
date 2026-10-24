import type {TransmissionCircuitTemplateData} from '@shared/templates/transmission.circuit'
import type {TransmissionVoltage} from '@shared/models/transmission.voltage'
import type {ConductorMountType} from '@shared/models/transmission.conductor'
import type {TemplateSummary} from '@shared/templates/template'
import {issueFor, NumberField, SelectField, TextField} from '../fields'
import {EditorProps} from './ConductorForm'
import {hrefTo} from '../../hooks/useHashRoute'

interface CircuitFormProps extends EditorProps<TransmissionCircuitTemplateData> {
    conductors: TemplateSummary[]
}

export function CircuitForm({data, onChange, issues, meta, conductors}: CircuitFormProps) {
    const set = <K extends keyof TransmissionCircuitTemplateData>(key: K, value: TransmissionCircuitTemplateData[K]) => onChange({...data, [key]: value})
    const conductorOptions = conductors.map(c => ({value: c.id, label: c.name}))
    const selected = conductors.find(c => c.id === data.conductorId)
    return (
        <div className="form-grid">
            <TextField label="Name" value={data.name} onChange={v => set('name', v)} error={issueFor(issues, 'name')}
                       placeholder="TCT_230KV_4x1272MCM_ACSR_GA" className="span-2"/>
            <SelectField label="Voltage" value={data.voltage} options={meta.enums.transmissionVoltage} allowEmpty
                         onChange={v => set('voltage', v as TransmissionVoltage | undefined)} error={issueFor(issues, 'voltage')}/>
            <NumberField label="Bundle" value={data.bundle} min={1} step={1} onChange={v => set('bundle', v as number)}
                         hint="Sub-conductors per phase" error={issueFor(issues, 'bundle')}/>
            <SelectField label="Conductor" value={data.conductorId} options={conductorOptions}
                         onChange={v => set('conductorId', v ?? '')} error={issueFor(issues, 'conductorId')}
                         hint={conductors.length ? undefined : 'No conductor templates yet. Create one first.'} className="span-2"/>
            <SelectField label="Mount type" value={data.mountType} options={meta.enums.conductorMountType} allowEmpty emptyLabel="from the conductor"
                         onChange={v => set('mountType', v as ConductorMountType | undefined)} error={issueFor(issues, 'mountType')}
                         hint="How the conductors are carried (e.g. Duct Bank for a buried cable); empty: the conductor's (suspension I-string, else duct bank)"/>
            {selected && (
                <div className="field">
                    <label>&nbsp;</label>
                    <span className="small">
                        <a href={hrefTo(`/templates/${selected.kind}/${selected.id}`)}>Open conductor {selected.name}</a>
                    </span>
                </div>
            )}
        </div>
    )
}
