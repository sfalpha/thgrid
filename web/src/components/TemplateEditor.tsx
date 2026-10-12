import {useEffect, useMemo, useState} from 'react'
import {slugifyTemplateId, TemplateKind, TemplateRecord, TemplateSummary, TEMPLATE_ID_PATTERN} from '@shared/templates/template'
import type {TemplateInput} from '@shared/templates/template'
import {validateTemplateData, ValidationIssue} from '@shared/templates/validation'
import {TransmissionWireType, TransmissionWireUnit} from '@shared/models/transmission.conductor'
import {TransformerWindingSide} from '@shared/models/transformer'
import {TransmissionVoltage} from '@shared/models/transmission.voltage'
import type {PowerTransformerTemplate} from '@shared/templates/power.transformer'
import type {TransmissionCircuitTemplateData} from '@shared/templates/transmission.circuit'
import {api, ApiError, downloadJson, MetaResponse, TemplateUsage} from '../api/client'
import {useAsync} from '../hooks/useAsync'
import {hrefTo} from '../hooks/useHashRoute'
import {TagsField, TextAreaField, TextField} from './fields'
import {IssueList, Notice} from './IssueList'
import {JsonEditor} from './JsonEditor'
import {ConductorForm} from './editors/ConductorForm'
import {CircuitForm} from './editors/CircuitForm'
import {defaultWinding, PowerTransformerForm} from './editors/PowerTransformerForm'
import {YardTemplateForm} from './editors/YardTemplateForm'
import {BayTemplateForm} from './editors/BayTemplateForm'
import {SubstationArrangement} from '@shared/models/substation'
import {SubstationBusType} from '@shared/models/substation.bus'
import {BayTemplateType} from '@shared/models/substation.bay'
import {SubstationEquipmentType} from '@shared/models/substation.equipment'
import type {SubstationYardTemplate} from '@shared/templates/substation.yard'
import type {SubstationBayTemplate} from '@shared/templates/substation.bay'

interface TemplateEditorProps {
    kind: TemplateKind
    /** Undefined when creating a new template. */
    id?: string
    meta: MetaResponse
    onSaved: (record: TemplateRecord) => void
    onDeleted: () => void
}

type AnyData = Record<string, unknown>

function defaultData(kind: TemplateKind): AnyData {
    switch (kind) {
        case TemplateKind.TRANSMISSION_CONDUCTOR:
            return {name: '', size: 0, unit: TransmissionWireUnit.MCM, type: TransmissionWireType.ACSR_GA}
        case TemplateKind.TRANSMISSION_CIRCUIT:
            return {name: '', voltage: TransmissionVoltage.AC230KV, bundle: 1, conductorId: ''} satisfies TransmissionCircuitTemplateData
        case TemplateKind.POWER_TRANSFORMER:
            return {
                name: '',
                modules: 1,
                windings: {
                    H: {...defaultWinding(TransformerWindingSide.PRIMARY), voltage: TransmissionVoltage.AC230KV},
                    X: {...defaultWinding(TransformerWindingSide.SECONDARY), voltage: TransmissionVoltage.AC115KV},
                },
            } satisfies PowerTransformerTemplate
        case TemplateKind.SUBSTATION_YARD:
            return {name: '', arrangement: SubstationArrangement.SINGLE_BUS, buses: [{name: 'MAIN_BUS_1', busType: SubstationBusType.MAIN, busNumber: '1', row: 0}]} satisfies SubstationYardTemplate
        case TemplateKind.SUBSTATION_BAY:
            return {
                name: '', bayTemplateType: BayTemplateType.TAKEOFF, arrangements: [SubstationArrangement.SINGLE_BUS],
                equipments: [{equipmentType: SubstationEquipmentType.DISCONNECTING_SWITCH, sequence: 1}, {equipmentType: SubstationEquipmentType.CIRCUIT_BREAKER, sequence: 2}, {equipmentType: SubstationEquipmentType.DISCONNECTING_SWITCH, sequence: 3}, {equipmentType: SubstationEquipmentType.GROUND_SWITCH, sequence: 4, lineSide: true}],
            } satisfies SubstationBayTemplate
    }
}

/** Server issues are prefixed with `data.`; the forms work with payload-relative paths. */
function stripDataPrefix(issues: ValidationIssue[]): ValidationIssue[] {
    return issues.map(i => i.path.startsWith('data.') ? {...i, path: i.path.slice(5)} : i.path === 'data' ? {...i, path: ''} : i)
}

export function TemplateEditor({kind, id, meta, onSaved, onDeleted}: TemplateEditorProps) {
    const isNew = id === undefined
    const kindInfo = meta.kinds.find(k => k.kind === kind)!

    const record = useAsync(async () => isNew ? undefined : api.templates.get(kind, id), [kind, id])
    const usage = useAsync<TemplateUsage | undefined>(async () => isNew ? undefined : api.templates.usage({kind, id}), [kind, id])
    const conductors = useAsync(async () => kind === TemplateKind.TRANSMISSION_CIRCUIT ? api.templates.list(TemplateKind.TRANSMISSION_CONDUCTOR) : [], [kind])

    const [data, setData] = useState<AnyData>(() => defaultData(kind))
    const [customId, setCustomId] = useState('')
    const [description, setDescription] = useState<string | undefined>()
    const [tags, setTags] = useState<string[] | undefined>()
    const [dirty, setDirty] = useState(false)
    const [revision, setRevision] = useState(0)
    const [showJson, setShowJson] = useState(false)
    const [serverIssues, setServerIssues] = useState<ValidationIssue[]>([])
    const [message, setMessage] = useState<{ kind: 'ok' | 'error' | 'warn'; text: string } | undefined>()
    const [saving, setSaving] = useState(false)
    const [deleteBlocked, setDeleteBlocked] = useState<TemplateUsage | undefined>()

    // (Re)initialise the form whenever the loaded record changes.
    useEffect(() => {
        if (record.loading) return
        const r = record.data
        setData(r ? (r.data as unknown as AnyData) : defaultData(kind))
        setDescription(r?.description)
        setTags(r?.tags)
        setCustomId('')
        setDirty(false)
        setServerIssues([])
        setMessage(undefined)
        setDeleteBlocked(undefined)
        setRevision(x => x + 1)
    }, [record.data, record.loading, kind])

    const conductorList: TemplateSummary[] = conductors.data ?? []
    const clientIssues = useMemo(() => validateTemplateData(kind, data, {
        exists: ref => ref.kind !== TemplateKind.TRANSMISSION_CONDUCTOR || conductors.loading || conductorList.some(c => c.id === ref.id),
    }), [kind, data, conductorList, conductors.loading])
    const issues = serverIssues.length ? serverIssues : clientIssues

    const name = typeof data.name === 'string' ? data.name : ''
    const derivedId = customId || slugifyTemplateId(name)
    const idValid = !isNew || TEMPLATE_ID_PATTERN.test(derivedId)

    const update = (next: AnyData) => {
        setData(next)
        setDirty(true)
        setServerIssues([])
    }
    const updateFromJson = (next: AnyData) => {
        update(next)
    }

    const save = async () => {
        setSaving(true)
        setMessage(undefined)
        try {
            const input: TemplateInput = {description, tags, data: data as unknown as TemplateInput["data"]}
            let saved: TemplateRecord
            if (isNew) {
                if (customId) input.id = customId
                saved = await api.templates.create(kind, input)
            } else {
                saved = await api.templates.update(kind, id, input)
            }
            setServerIssues([])
            setDirty(false)
            setMessage({kind: 'ok', text: `Saved ${kindInfo.label.toLowerCase()} ${saved.id}.`})
            onSaved(saved)
        } catch (e) {
            if (e instanceof ApiError && e.issues.length) {
                setServerIssues(stripDataPrefix(e.issues))
                setMessage({kind: 'error', text: e.message})
            } else {
                setMessage({kind: 'error', text: (e as Error).message})
            }
        } finally {
            setSaving(false)
        }
    }

    const remove = async (force = false) => {
        if (isNew) return
        if (!force && !window.confirm(`Delete ${kindInfo.label.toLowerCase()} "${name || id}"? This removes the JSON file.`)) return
        try {
            await api.templates.delete(kind, id, force)
            onDeleted()
        } catch (e) {
            if (e instanceof ApiError && e.status === 409) {
                setDeleteBlocked(e.details as TemplateUsage)
            } else {
                setMessage({kind: 'error', text: (e as Error).message})
            }
        }
    }

    if (record.error) return <Notice kind="error">Could not load template: {record.error.message}</Notice>
    if (record.loading && !isNew) return <div className="empty">Loading…</div>

    const formProps = {issues, meta}

    return (
        <>
            <div className="panel">
                <div className="panel-header">
                    <h2>{isNew ? `New ${kindInfo.label.toLowerCase()}` : name || id}</h2>
                    <span className="badge">{kind}</span>
                    {!isNew && <span className="badge">{id}</span>}
                    {dirty && <span className="muted small">unsaved changes</span>}
                    <span className="spacer"/>
                    <div className="toolbar">
                        <button type="button" onClick={() => setShowJson(s => !s)}>{showJson ? 'Form view' : 'JSON view'}</button>
                        {!isNew && <button type="button" onClick={() => downloadJson(`${id}.json`, record.data)}>Download</button>}
                        {!isNew && <button type="button" className="danger" onClick={() => remove(false)}>Delete</button>}
                        <button type="button" className="primary" onClick={save} disabled={saving || !idValid || (!dirty && !isNew) || (serverIssues.length === 0 && clientIssues.length > 0)}>
                            {saving ? 'Saving…' : isNew ? 'Create' : 'Save'}
                        </button>
                    </div>
                </div>

                {message && <Notice kind={message.kind}>{message.text}</Notice>}
                {deleteBlocked && (
                    <Notice kind="warn">
                        <strong>Cannot delete: this template is still referenced.</strong>
                        <UsageList usage={deleteBlocked}/>
                        <div className="toolbar" style={{marginTop: 8}}>
                            <button type="button" className="danger" onClick={() => remove(true)}>Delete anyway (prunes collections, leaves dependants dangling)</button>
                            <button type="button" onClick={() => setDeleteBlocked(undefined)}>Cancel</button>
                        </div>
                    </Notice>
                )}
                <IssueList issues={issues}/>

                <div className="form-grid" style={{marginBottom: 16}}>
                    {isNew ? (
                        <TextField label="Id" value={customId || derivedId} mono
                                   onChange={v => setCustomId(v)}
                                   hint="File name under data/templates. Derived from the name unless you type one."
                                   error={idValid ? undefined : `Must match ${TEMPLATE_ID_PATTERN.source}`}/>
                    ) : (
                        <TextField label="Id" value={id} readOnly mono onChange={() => undefined} hint="Immutable; this is the JSON file name."/>
                    )}
                    <TextAreaField label="Description" value={description} rows={1} className="span-2"
                                   onChange={v => {
                                       setDescription(v)
                                       setDirty(true)
                                   }}/>
                    <TagsField value={tags} onChange={v => {
                        setTags(v)
                        setDirty(true)
                    }}/>
                </div>

                {showJson ? (
                    <JsonEditor value={data} onChange={updateFromJson} revision={revision}/>
                ) : kind === TemplateKind.TRANSMISSION_CONDUCTOR ? (
                    <ConductorForm data={data as never} onChange={update as never} {...formProps}/>
                ) : kind === TemplateKind.TRANSMISSION_CIRCUIT ? (
                    <CircuitForm data={data as never} onChange={update as never} conductors={conductorList} {...formProps}/>
                ) : kind === TemplateKind.SUBSTATION_YARD ? (
                    <YardTemplateForm data={data as never} onChange={update as never} {...formProps}/>
                ) : kind === TemplateKind.SUBSTATION_BAY ? (
                    <BayTemplateForm data={data as never} onChange={update as never} {...formProps}/>
                ) : (
                    <PowerTransformerForm data={data as never} onChange={update as never} {...formProps}/>
                )}
            </div>

            {!isNew && usage.data && (
                <div className="panel">
                    <h3>Used by</h3>
                    {usage.data.templates.length + usage.data.collections.length === 0
                        ? <p className="muted">Not referenced by any template or collection.</p>
                        : <UsageList usage={usage.data}/>}
                </div>
            )}
        </>
    )
}

export function UsageList({usage}: { usage: TemplateUsage }) {
    return (
        <dl className="kv" style={{marginTop: 8}}>
            {usage.templates.length > 0 && (
                <>
                    <dt>Templates</dt>
                    <dd>{usage.templates.map(t => <div key={`${t.kind}:${t.id}`}><a href={hrefTo(`/templates/${t.kind}/${t.id}`)}>{t.name}</a> <span className="badge">{t.kind}</span></div>)}</dd>
                </>
            )}
            {usage.collections.length > 0 && (
                <>
                    <dt>Collections</dt>
                    <dd>{usage.collections.map(c => <div key={c.id}><a href={hrefTo(`/collections/${c.id}`)}>{c.name}</a></div>)}</dd>
                </>
            )}
        </dl>
    )
}
