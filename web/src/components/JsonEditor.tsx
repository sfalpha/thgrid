import {useEffect, useState} from 'react'

interface JsonEditorProps<T> {
    value: T
    onChange: (value: T) => void
    /** Bumped by the parent when `value` was changed outside the editor, to resync the text. */
    revision?: number
}

/**
 * Raw JSON editing of the kind-specific payload. The text is only pushed to the
 * parent when it parses, so a half typed document never clobbers the form.
 */
export function JsonEditor<T>({value, onChange, revision}: JsonEditorProps<T>) {
    const [text, setText] = useState(() => JSON.stringify(value, null, 2))
    const [error, setError] = useState<string | undefined>()
    useEffect(() => {
        setText(JSON.stringify(value, null, 2))
        setError(undefined)
    }, [revision]) // eslint-disable-line react-hooks/exhaustive-deps

    return (
        <div className="field">
            <textarea
                className="json"
                spellCheck={false}
                value={text}
                onChange={e => {
                    setText(e.target.value)
                    try {
                        const parsed = JSON.parse(e.target.value) as T
                        setError(undefined)
                        onChange(parsed)
                    } catch (err) {
                        setError((err as Error).message)
                    }
                }}
            />
            {error ? <span className="error">{error}</span> : <span className="hint">Changes apply as soon as the JSON parses.</span>}
        </div>
    )
}
