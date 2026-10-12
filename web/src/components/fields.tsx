import {ReactNode} from 'react'
import type {ValidationIssue} from '@shared/templates/validation'

/** Finds the first issue whose path equals (or starts with) `path`. */
export function issueFor(issues: ValidationIssue[] | undefined, path: string): string | undefined {
    if (!issues) return undefined
    return issues.find(i => i.path === path)?.message
}

interface FieldProps {
    label: string
    hint?: string
    error?: string
    className?: string
    children: ReactNode
}

export function Field({label, hint, error, className, children}: FieldProps) {
    return (
        <div className={`field ${error ? 'invalid' : ''} ${className ?? ''}`}>
            <label>{label}</label>
            {children}
            {error ? <span className="error">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
        </div>
    )
}

/** A small button next to a text input, e.g. "auto" to fill the generated value. */
export interface FieldAction {
    label: string
    title?: string
    onClick: () => void
    disabled?: boolean
}

interface TextFieldProps {
    label: string
    value: string | undefined
    onChange: (value: string) => void
    placeholder?: string
    hint?: string
    error?: string
    readOnly?: boolean
    mono?: boolean
    className?: string
    action?: FieldAction
}

export function TextField({label, value, onChange, placeholder, hint, error, readOnly, mono, className, action}: TextFieldProps) {
    const input = (
        <input
            type="text"
            className={mono ? 'mono' : undefined}
            value={value ?? ''}
            placeholder={placeholder}
            readOnly={readOnly}
            onChange={e => onChange(e.target.value)}
        />
    )
    return (
        <Field label={label} hint={hint} error={error} className={className}>
            {action ? (
                <div className="with-action">
                    {input}
                    <button type="button" className="small" title={action.title} disabled={action.disabled} onClick={action.onClick}>{action.label}</button>
                </div>
            ) : input}
        </Field>
    )
}

interface NumberFieldProps {
    label: string
    value: number | undefined
    onChange: (value: number | undefined) => void
    hint?: string
    error?: string
    min?: number
    step?: number
    className?: string
}

export function NumberField({label, value, onChange, hint, error, min, step, className}: NumberFieldProps) {
    return (
        <Field label={label} hint={hint} error={error} className={className}>
            <input
                type="number"
                value={value ?? ''}
                min={min}
                step={step ?? 'any'}
                onChange={e => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
            />
        </Field>
    )
}

interface SelectFieldProps {
    label: string
    value: string | undefined
    options: { value: string; label?: string }[] | string[]
    onChange: (value: string | undefined) => void
    allowEmpty?: boolean
    emptyLabel?: string
    hint?: string
    error?: string
    className?: string
}

/** Display labels of enum values whose code alone does not say enough; others show as they are. */
const ENUM_LABELS: Record<string, string> = {
    '0V': '0V (De-Energized)',
}

/** How an enum value is shown in selects and lists. */
export const enumLabel = (value: string): string => ENUM_LABELS[value] ?? value

export function SelectField({label, value, options, onChange, allowEmpty, emptyLabel, hint, error, className}: SelectFieldProps) {
    const opts = options.map(o => typeof o === 'string' ? {value: o, label: enumLabel(o)} : {value: o.value, label: o.label ?? enumLabel(o.value)})
    return (
        <Field label={label} hint={hint} error={error} className={className}>
            <select value={value ?? ''} onChange={e => onChange(e.target.value === '' ? undefined : e.target.value)}>
                {(allowEmpty || value === undefined || value === '') && <option value="">{emptyLabel ?? (allowEmpty ? '(none)' : 'Select…')}</option>}
                {opts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
        </Field>
    )
}

interface CheckboxFieldProps {
    label: string
    checked: boolean
    onChange: (checked: boolean) => void
    className?: string
}

export function CheckboxField({label, checked, onChange, className}: CheckboxFieldProps) {
    return (
        <div className={`field ${className ?? ''}`}>
            <label>&nbsp;</label>
            <label style={{display: 'flex', alignItems: 'center', gap: 6, color: 'inherit', fontSize: 'inherit'}}>
                <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)}/>
                {label}
            </label>
        </div>
    )
}

interface TagsFieldProps {
    label?: string
    value: string[] | undefined
    onChange: (value: string[] | undefined) => void
    error?: string
    className?: string
}

/** Comma separated tags. */
export function TagsField({label, value, onChange, error, className}: TagsFieldProps) {
    return (
        <Field label={label ?? 'Tags'} hint="Comma separated" error={error} className={className}>
            <input
                type="text"
                value={(value ?? []).join(', ')}
                onChange={e => {
                    const tags = e.target.value.split(',').map(t => t.trim()).filter(Boolean)
                    onChange(tags.length ? tags : undefined)
                }}
            />
        </Field>
    )
}

interface TextAreaFieldProps {
    label: string
    value: string | undefined
    onChange: (value: string | undefined) => void
    rows?: number
    error?: string
    className?: string
}

export function TextAreaField({label, value, onChange, rows, error, className}: TextAreaFieldProps) {
    return (
        <Field label={label} error={error} className={className}>
            <textarea rows={rows ?? 2} value={value ?? ''} onChange={e => onChange(e.target.value || undefined)}/>
        </Field>
    )
}
