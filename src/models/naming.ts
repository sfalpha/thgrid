/**
 * Helpers behind the static `idPrefix` / `defaultId()` / `defaultName()` of
 * every `SubstationUnit` and `TransmissionUnit` subclass.
 *
 * A generated id is `<PREFIX>_<token>_<token>…`: a three-letter class prefix
 * (`SSY` for a yard, `TCC` for a transmission circuit, …) followed by tokens
 * taken from the names of the related items (site code, yard name, bay
 * number, the endpoints of a route, …). Tokens are sanitised so the result
 * matches `NETWORK_ID_PATTERN` (`[A-Za-z0-9_.-]`); uniqueness within a
 * network is the caller's job (`uniqueId()` / `pickId()` in `src/network/ops`).
 *
 * The functions take plain strings, so the frontend can feed them from the
 * flat network records as well as the runtime classes can from their props.
 */

export type NameToken = string | number | undefined | null

/** One id token: trimmed, every run of characters outside `[A-Za-z0-9.-]` replaced by `_`, no leading / trailing `_`. */
export function idToken(value: NameToken): string {
    if (value === undefined || value === null) return ''
    return String(value).trim().replace(/[^A-Za-z0-9.-]+/g, '_').replace(/^_+|_+$/g, '')
}

/** Joins the non-empty tokens with `_`: `joinId('SSY', 'CNO', '230KV')` → `SSY_CNO_230KV`. */
export function joinId(...parts: NameToken[]): string {
    return parts.map(idToken).filter(Boolean).join('_')
}

/** Joins the non-empty parts of a human readable name with `sep` (default `_`). */
export function joinName(parts: NameToken[], sep = '_'): string {
    return parts.map(p => (p === undefined || p === null ? '' : String(p).trim())).filter(Boolean).join(sep)
}

/** Short label of a `TransmissionVoltage` for names: `AC230KV` → `230KV`, `DC300KV` → `DC300KV`, `0V` → `0V`. */
export function voltageLabel(voltage?: string): string | undefined {
    if (!voltage) return undefined
    return voltage.startsWith('AC') ? voltage.slice(2).replace(/^_/, '') : voltage
}

/**
 * Default name of a voltage yard: the voltage without its AC prefix, and
 * with a `DC` suffix for direct current: `AC230KV` → `230KV`, `AC400V` →
 * `400V`, `DC300KV` → `300KVDC`, `0V` (de-energized) → `0V`.
 */
export function yardNameForVoltage(voltage?: string): string | undefined {
    if (!voltage) return undefined
    const m = /^(AC|DC)_?(.+)$/.exec(voltage)
    if (!m) return voltage
    const value = m[2].replace(/_/g, '')
    return m[1] === 'DC' ? `${value}DC` : value
}

/** `<prefix><n>` for a 1-based sequence number, or undefined when there is none: `seqToken('S', 2)` → `S2`. */
export function seqToken(prefix: string, sequence?: number): string | undefined {
    return sequence === undefined || sequence === null ? undefined : `${prefix}${sequence}`
}

/** Hints common to every unit: an explicit name wins over anything derived. */
export interface UnitNamingHints {
    name?: string
}
