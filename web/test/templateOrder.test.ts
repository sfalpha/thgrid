/**
 * Circuit template pickers (docs/testing.md section 10, `circuitTemplateGroups`): grouped by voltage, the connected
 * yards' voltages first (highest first), then those rated above them (closest first), the unsuitable ones last.
 */
import {TransmissionVoltage as V} from '@shared/models/transmission.voltage'
import {circuitTemplateGroups} from '../src/network/templateOrder'
import {test} from './harness'

const tpl = (name: string, voltage?: V) => ({id: name.toLowerCase(), data: {name, voltage}})
const SET = [
    tpl('TCT_22KV_1x95SQMM_AAC', V.AC22KV), tpl('TCT_115KV_1x477MCM_ACSR_GA', V.AC115KV), tpl('TCT_115KV_2x1272MCM_ACSR_GA', V.AC115KV),
    tpl('TCT_230KV_1x1272MCM_ACSR_GA', V.AC230KV), tpl('TCT_230KV_2x1272MCM_ACSR_GA', V.AC230KV), tpl('TCT_500KV_4x1272MCM_ACSR_GA', V.AC500KV),
    tpl('TCT_33KV_1x50SQMM_XLPE', V.AC33KV), tpl('TCT_300KVDC_2x1272MCM', V.DC300KV), tpl('TCT_NOVOLTAGE'),
]
const order = (yards: (V | undefined)[]) => circuitTemplateGroups(SET, yards).map(g => `${g.label}${g.suitable ? '' : ' ✗'}: ${g.items.map(t => t.data.name.replace(/^TCT_/, '')).join(', ')}`)

test('TO-1', 'a line between two 230 kV yards: 230 kV first, then 500 kV (rated above), the others last, highest first', t => {
    const groups = order([V.AC230KV, V.AC230KV])
    t.eq(groups[0], '230 kV: 230KV_1x1272MCM_ACSR_GA, 230KV_2x1272MCM_ACSR_GA', 'first: at the yards, in the order given')
    t.eq(groups[1], '500 kV · rated above the yards (runs below its rating): 500KV_4x1272MCM_ACSR_GA', 'then rated above the yards')
    t.eq(groups.slice(2).map(g => g.split(':')[0]).join(' | '),
        "300 kV DC · not for these yards (below their voltage, or another type) ✗ | 115 kV · not for these yards (below their voltage, or another type) ✗ | 33 kV · not for these yards (below their voltage, or another type) ✗ | 22 kV · not for these yards (below their voltage, or another type) ✗ | No voltage ✗",
        'last: another type, below the yards, no voltage')
})

test('TO-2', 'no yard to go by (junction ends): every voltage, highest first, no voltage last', t => {
    t.eq(order([undefined, undefined]).map(g => g.split(':')[0]).join(' | '), '500 kV | 300 kV DC | 230 kV | 115 kV | 33 kV | 22 kV | No voltage', 'by voltage')
    t.eq(order([]).length, 7, 'no yards at all: the same')
})

test('TO-3', 'ends at 230 and 115 kV yards: 230 kV first (rated for both), 115 kV unsuitable (below the 230 kV yard)', t => {
    const groups = order([V.AC230KV, V.AC115KV])
    t.check(groups[0].startsWith('230 kV:') && groups[1].startsWith('500 kV · rated above'), 'the 230 kV ones, then 500 kV', groups.slice(0, 2))
    t.check(groups.some(g => g.startsWith('115 kV · not for these yards')), '115 kV unsuitable', groups)
})

test('TO-4', 'a 115 kV yard and a de-energized end: the 0 V end tells nothing; 115 kV first, 230 and 500 kV above it, closest first', t => {
    const groups = order([V.AC115KV, V.DE_ENERGIZED])
    t.eq(groups.slice(0, 3).map(g => g.split(' ')[0] + ' ' + g.split(' ')[1].replace(/[:·]/g, '')).join(' | '), '115 kV | 230 kV | 500 kV', 'at the yard, then the closest rating above it')
    t.check(groups[1].includes('rated above the yards') && !groups[0].includes('✗'), 'suitable groups first', groups)
})
