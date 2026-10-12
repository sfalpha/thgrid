import {useEffect, useState} from 'react'
import type {NetworkCollectionName} from '@shared/network/records'
import {checkCreateId, checkNewId, renameRecordOps} from '@shared/network/ops'
import {useNetworkEditor} from './NetworkContext'

interface NewIdFieldProps {
    value: string
    onChange: (v: string) => void
    /** Shown as placeholder: the id that will be generated when the field is left empty. */
    auto?: string
    label?: string
    className?: string
    compact?: boolean
}

/**
 * Optional id for a record about to be created. Empty = generated id; a typed
 * id must match the pattern and be unique in the network (error shown inline).
 */
export function NewIdField({value, onChange, auto, label, className, compact}: NewIdFieldProps) {
    const ed = useNetworkEditor()
    const reason = value.trim() ? checkCreateId(ed.doc, value.trim()) : undefined
    if (compact) {
        return (
            <span className="id-editor" title={reason ?? 'Optional id for the new record (generated when empty)'}>
                <input type="text" className="mono" value={value} placeholder={auto ? `id: ${auto}` : 'id (auto)'} style={{width: 150, borderColor: reason ? 'var(--danger)' : undefined}}
                       onChange={e => onChange(e.target.value)}/>
            </span>
        )
    }
    return (
        <div className={`field ${reason ? 'invalid' : ''} ${className ?? ''}`}>
            <label>{label ?? 'Id'}</label>
            <input type="text" className="mono" value={value} placeholder={auto ?? '(generated)'} onChange={e => onChange(e.target.value)}/>
            {reason ? <span className="error">{reason}</span> : <span className="hint">Optional; unique in the network. Left empty: {auto ?? 'generated'}</span>}
        </div>
    )
}

/** True when the typed id is empty (use the generated one) or valid. */
export function newIdOk(doc: Parameters<typeof checkCreateId>[0], value: string): boolean {
    return !value.trim() || !checkCreateId(doc, value.trim())
}

interface IdEditorProps {
    collection: NetworkCollectionName
    id: string
    /** Called after a successful rename; defaults to selecting the renamed record. */
    onRenamed?: (newId: string) => void
    /** Id the model rules give the record (from its current fields); offers an "auto" button while it differs from the id. */
    auto?: string
}

/**
 * Shows a record id as a badge with a "rename" affordance. A new id must be
 * unique in the network; every reference to the old id is rewritten through
 * `renameRecordOps`, as one journaled (undoable) step. With `auto`, an
 * "auto" button proposes the rule id (confirmed with *Rename*).
 */
export function IdEditor({collection, id, onRenamed, auto}: IdEditorProps) {
    const ed = useNetworkEditor()
    const [editing, setEditing] = useState(false)
    const [value, setValue] = useState(id)
    useEffect(() => {
        setValue(id)
        setEditing(false)
    }, [id])
    const reason = editing ? checkNewId(ed.doc, id, value.trim()) : undefined
    const commit = () => {
        const next = value.trim()
        if (!editing || reason) return
        if (ed.apply(renameRecordOps(ed.doc, collection, id, next))) {
            setEditing(false)
            if (onRenamed) onRenamed(next)
            else ed.select({collection, id: next})
        }
    }
    if (!editing) {
        return (
            <span className="id-editor">
                <span className="badge" title="Record id (file-unique)">{id}</span>
                <button type="button" className="small" title="Change the id; every reference is updated" onClick={() => setEditing(true)}>id…</button>
                {auto && auto !== id && <button type="button" className="small" title={`Rename to the id the model rules give: ${auto}`} onClick={() => {
                    setValue(auto)
                    setEditing(true)
                }}>auto</button>}
            </span>
        )
    }
    return (
        <span className="id-editor editing">
            <input type="text" className="mono" value={value} autoFocus style={{width: 200}}
                   onChange={e => setValue(e.target.value)}
                   onKeyDown={e => {
                       if (e.key === 'Enter') commit()
                       if (e.key === 'Escape') {
                           setValue(id)
                           setEditing(false)
                       }
                   }}/>
            {auto && <button type="button" className="small" title={`Use the id the model rules give: ${auto}`} disabled={value === auto} onClick={() => setValue(auto)}>auto</button>}
            <button type="button" className="small primary" disabled={!!reason} onClick={commit}>Rename</button>
            <button type="button" className="small" onClick={() => {
                setValue(id)
                setEditing(false)
            }}>Cancel</button>
            {reason && reason !== 'unchanged' && <span className="error small">{reason}</span>}
        </span>
    )
}
