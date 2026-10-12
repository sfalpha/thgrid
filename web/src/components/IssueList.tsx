import type {ValidationIssue} from '@shared/templates/validation'

/** Errors first (they block a save), then warnings (⚠, never block). */
export function IssueList({issues, title}: { issues: ValidationIssue[]; title?: string }) {
    if (!issues.length) return null
    const errors = issues.filter(i => i.severity !== 'warning')
    const warnings = issues.filter(i => i.severity === 'warning')
    const parts = [errors.length ? `${errors.length} validation issue${errors.length === 1 ? '' : 's'}` : '', warnings.length ? `${warnings.length} warning${warnings.length === 1 ? '' : 's'}` : ''].filter(Boolean)
    return (
        <div className={`issues ${errors.length ? '' : 'warnings-only'}`}>
            <strong>{title ?? parts.join(' · ')}</strong>
            <ul>
                {[...errors, ...warnings].map((i, n) => (
                    <li key={n} className={i.severity === 'warning' ? 'warning' : undefined}>{i.severity === 'warning' ? '⚠ ' : ''}<code>{i.path || '(document)'}</code>: {i.message}</li>
                ))}
            </ul>
        </div>
    )
}
export function Notice({kind, children}: { kind: 'ok' | 'warn' | 'error'; children: React.ReactNode }) {
    return <div className={`notice ${kind}`}>{children}</div>
}
