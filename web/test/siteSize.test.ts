/**
 * Site size on the map (docs/testing.md section 4): points per circuit ending at the site by the voltage it runs at,
 * 4 at 500 kV or more, 2 at 230 kV or more, 1 below; small from 0, medium from 8, large from 16, x-large from 32 points.
 */
import {TransmissionVoltage as V} from '@shared/models/transmission.voltage'
import {circuitSizePoints, siteSize} from '../src/network/mapUtil'
import {test} from './harness'
import {lineFixture, siteId} from './fixture'

const circuit = (voltage: V, energizedVoltage?: V) => ({id: 'c', name: 'c', voltage, energizedVoltage})

test('SZ-1', 'points per circuit by the voltage it runs at', t => {
    t.eq(circuitSizePoints(circuit(V.AC500KV)), 4, '500 kV')
    t.eq(circuitSizePoints(circuit(V.AC230KV)), 2, '230 kV')
    t.eq(circuitSizePoints(circuit(V.AC115KV)), 1, '115 kV')
    t.eq(circuitSizePoints(circuit(V.AC230KV, V.AC115KV)), 1, '230 kV-rated at 115 kV: by the voltage it runs at')
    t.eq(circuitSizePoints(circuit(V.AC230KV, V.DE_ENERGIZED)), 2, 'de-energized: by its rating')
    t.eq(circuitSizePoints({id: 'c', name: 'c'}), 1, 'no voltage')
})
test('SZ-2', 'the sites of the busy area: circuits at their yards and open at their site junction, by voltage', t => {
    const doc = lineFixture()
    const size = (code: string) => { const s = siteSize(doc, siteId(code)); return `${s.size} ${s.circuits}/${s.points}` }
    // MA: 500 kV to MB (4); 230 kV to MC twice, a de-energized one to MC and one to ME (2 each); 115 kV and 230 kV-rated at 115 kV to MD (1 each)
    t.eq(size('MA'), 'medium 7/14', 'MA')
    // ME: 500 kV from MB (4); 230 kV from MS, to JX, from MA (2 each)
    t.eq(size('ME'), 'medium 4/10', 'ME')
    // MS: 230 kV to ME (2); its junction: the de-energized line from JX ends open there (2), MD's 115 kV one (1); MA-ME only spliced through it
    t.eq(size('MS'), 'small 3/5', 'MS')
    // MD: five lines at 115 kV (one 230 kV-rated)
    t.eq(size('MD'), 'small 5/5', 'MD')
    // QA: 500, 230, 115 kV, 230 kV-rated at 115 kV, and a de-energized 230 kV one: 4 + 2 + 1 + 1 + 2
    t.eq(size('QA'), 'medium 5/10', 'QA')
    t.eq(size('SA'), 'small 0/0', 'SA: no circuits yet')
})
/** The fixture with circuits at these voltages ending at SA's yard (SA has none of its own). */
function saWith(voltages: V[]) {
    const doc = lineFixture()
    const ids = voltages.map((_, i) => `c${i}`)
    return {...doc,
        circuits: [...doc.circuits, ...ids.map((id, i) => ({id, name: id, voltage: voltages[i], energizedVoltage: voltages[i]}))],
        connections: [...doc.connections, ...ids.map(id => ({id: `n_${id}`, scope: 'TRANSMISSION', junction: {kind: 'SUBSTATION', id: 'SSY_SA_230KV'}, nodes: [{kind: 'TRANSMISSION_CIRCUIT', id, terminal: 'FROM'}]}))],
    } as ReturnType<typeof lineFixture>
}
test('SZ-3', 'the tiers: medium from 8 points, large from 16, x-large from 32 (each side of each step)', t => {
    const k500 = (n: number) => Array<V>(n).fill(V.AC500KV)
    for (const [voltages, points, size] of [
        [[V.AC500KV, V.AC230KV, V.AC115KV], 7, 'small'],
        [k500(2), 8, 'medium'],
        [[...k500(3), V.AC230KV, V.AC115KV], 15, 'medium'],
        [k500(4), 16, 'large'],
        [[...k500(7), V.AC230KV, V.AC115KV], 31, 'large'],
        [k500(8), 32, 'xlarge'],
    ] as [V[], number, string][]) {
        const s = siteSize(saWith(voltages), siteId('SA'))
        t.check(s.points === points && s.size === size, `${points} points: ${size}`, s)
    }
})
