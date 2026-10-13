/**
 * A minimal test harness for the editor's pure plan builders (no browser): `test()` registers a case, `runTests()` runs
 * them in order and prints one line per check. Run with `npm test` (see docs/testing.md).
 */

export interface Checker {
    /** Records a check: `ok` passes; otherwise `label` is reported, with `extra` as detail. */
    check(ok: boolean, label: string, extra?: unknown): void
    /** Records `actual === expected`. */
    eq<T>(actual: T, expected: T, label: string): void
}

interface Case {
    id: string
    title: string
    fn: (t: Checker) => void
}

const cases: Case[] = []

/** Registers a test case; `id` ties it to its row in docs/testing.md. */
export function test(id: string, title: string, fn: (t: Checker) => void): void {
    cases.push({id, title, fn})
}

/** Runs the registered cases (those whose id starts with `filter`, when given); returns the number of failed cases. */
export function runTests(filter?: string): number {
    let failedCases = 0, checks = 0, ran = 0
    for (const c of cases) {
        if (filter && !c.id.startsWith(filter)) continue
        ran++
        const failures: string[] = []
        const t: Checker = {
            check(ok, label, extra) {
                checks++
                if (!ok) failures.push(`${label}${extra === undefined ? '' : ` -> ${JSON.stringify(extra)?.slice(0, 600)}`}`)
            },
            eq(actual, expected, label) {
                this.check(actual === expected, label, {actual, expected})
            },
        }
        try {
            c.fn(t)
        } catch (e) {
            failures.push(`threw: ${(e as Error).stack ?? e}`)
        }
        if (failures.length) failedCases++
        console.log(`${failures.length ? 'FAIL' : 'ok  '} ${c.id} ${c.title}`)
        for (const f of failures) console.log(`       ✗ ${f}`)
    }
    console.log(`\n${ran - failedCases} of ${ran} cases passed (${checks} checks)${failedCases ? `, ${failedCases} failed` : ''}`)
    return failedCases
}
