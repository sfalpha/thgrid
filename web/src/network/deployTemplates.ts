/**
 * Deploys yard and bay templates onto a yard of a network document as journal ops.
 *
 *  - `deployYardTemplateOps`: sets the yard's arrangement, adds the template's
 *    buses (buses of the same type and number are kept) and a number of empty
 *    bays in new columns.
 *  - `deployBayTemplateOps`: adds the template's equipment to one bay, each at
 *    row `start ± sequence` (up or down from the start row), without any
 *    connection (the bay panel's Connect bay wires the stack afterwards).
 *    Equipment flagged `lineSide` goes into the bay's take-off column: the
 *    bay's first flagged take-off is used, else a take-off is created one row
 *    beyond that equipment in the deploy direction.
 */
import {SubstationBusType} from '@shared/models/substation.bus'
import {BayTemplateType} from '@shared/models/substation.bay'
import type {SubstationBayTemplate} from '@shared/templates/substation.bay'
import type {SubstationYardTemplate} from '@shared/templates/substation.yard'
import {defaultTerminals, NetworkDocument, SubstationBayRecord, SubstationBusRecord, SubstationEquipmentRecord, SubstationTakeOffRecord} from '@shared/network/records'
import {applyOps, NetworkOp, uniqueId} from '@shared/network/ops'
import {bayNaming, busNaming, equipmentNaming, takeOffNaming} from '@shared/network/naming'

export interface YardDeployPlan {
    ops: NetworkOp[]
    buses: SubstationBusRecord[]
    bays: SubstationBayRecord[]
    /** Template buses skipped because the yard already has a bus of that type and number. */
    keptBuses: string[]
    error?: string
}

export function deployYardTemplateOps(doc: NetworkDocument, yardId: string, template: SubstationYardTemplate, bayCount: number): YardDeployPlan {
    const plan: YardDeployPlan = {ops: [], buses: [], bays: [], keptBuses: []}
    const yard = doc.substations.find(s => s.id === yardId)
    if (!yard) return {...plan, error: 'yard not found'}
    if (!Number.isInteger(bayCount) || bayCount < 0) return {...plan, error: 'number of bays must be a whole number'}
    let probe = doc
    const push = (op: NetworkOp) => {
        plan.ops.push(op)
        probe = applyOps(probe, [op])
    }
    if (yard.arrangement !== template.arrangement) push({type: 'upsert', collection: 'substations', record: {...yard, arrangement: template.arrangement}})
    const existing = doc.buses.filter(b => b.substationId === yardId)
    for (const t of template.buses) {
        const number = t.busType === SubstationBusType.TRANSFER ? undefined : (t.busNumber || '1')
        if (existing.some(b => b.busType === t.busType && (b.busType === SubstationBusType.TRANSFER || (b.busNumber || '1') === number))) {
            plan.keptBuses.push(t.name)
            continue
        }
        const naming = busNaming(probe, yardId, t.busType, number)
        const record: SubstationBusRecord = {
            id: uniqueId(probe, naming.id),
            name: t.name || naming.name,
            substationId: yardId,
            busType: t.busType,
            busNumber: number,
            row: t.row,
            voltage: yard.voltage,
        }
        plan.buses.push(record)
        push({type: 'upsert', collection: 'buses', record})
    }
    const bays = doc.bays.filter(b => b.substationId === yardId)
    let column = bays.length ? Math.max(...bays.map(b => b.column)) + 1 : 0
    for (let i = 0; i < bayCount; i++) {
        let n = bays.length + plan.bays.length + 1
        let bayNumber = String(n).padStart(2, '0')
        while (bays.some(b => b.bayNumber === bayNumber) || plan.bays.some(b => b.bayNumber === bayNumber)) bayNumber = String(++n).padStart(2, '0')
        const naming = bayNaming(probe, yardId, bayNumber)
        const record: SubstationBayRecord = {id: uniqueId(probe, naming.id), name: naming.name, substationId: yardId, bayNumber, column: column++, voltage: yard.voltage}
        plan.bays.push(record)
        push({type: 'upsert', collection: 'bays', record})
    }
    return plan
}

export type DeployDirection = 'up' | 'down'

export interface BayDeployPlan {
    ops: NetworkOp[]
    equipments: SubstationEquipmentRecord[]
    /** Row the sequence counts from. */
    start: number
    /** Rows already holding equipment (or the take-off) in the same column: nothing is deployed while there are any (`error` says so). */
    overlaps: number[]
    /** Take-off created for the take-off column (none when the bay's own take-off is used or the template has no take-off side). */
    takeOff?: SubstationTakeOffRecord
    /** Take-off of the bay the take-off column equipment joins (created or existing). */
    takeOffId?: string
    error?: string
}

/** Default start row: the lowest bus (or row 0) going up, the highest bus (or the highest row in use) going down. */
export function defaultStartRow(doc: NetworkDocument, yardId: string, direction: DeployDirection): number {
    const rows = doc.buses.filter(b => b.substationId === yardId).map(b => b.row)
    if (direction === 'up') return rows.length ? Math.min(...rows) : 0
    if (rows.length) return Math.max(...rows)
    return Math.max(0, ...doc.equipments.filter(e => e.substationId === yardId).map(e => e.row), ...doc.takeOffs.filter(t => t.substationId === yardId && t.row !== undefined).map(t => t.row!))
}

export function deployBayTemplateOps(doc: NetworkDocument, bayId: string, template: SubstationBayTemplate, direction: DeployDirection, startRow?: number): BayDeployPlan {
    const plan: BayDeployPlan = {ops: [], equipments: [], start: 0, overlaps: []}
    const bay = doc.bays.find(b => b.id === bayId)
    if (!bay) return {...plan, error: 'bay not found'}
    const yard = doc.substations.find(s => s.id === bay.substationId)
    if (!yard) return {...plan, error: 'yard not found'}
    if (!yard.arrangement) return {...plan, error: 'set the arrangement of the yard first: bay templates are restricted to the arrangements they suit'}
    if (!template.arrangements.includes(yard.arrangement)) return {...plan, error: `template ${template.name} does not suit the ${yard.arrangement} arrangement (it suits ${template.arrangements.join(', ')})`}
    if (startRow !== undefined && (!Number.isInteger(startRow) || startRow < 0)) return {...plan, error: 'start row must be a whole number ≥ 0'}
    const start = startRow ?? defaultStartRow(doc, yard.id, direction)
    plan.start = start
    const items = [...template.equipments].sort((a, b) => a.sequence - b.sequence)
    const rows = items.map(t => direction === 'up' ? start + t.sequence : start - t.sequence)
    if (rows.some(s => s < 0)) return {...plan, error: `going down from row ${start} the template needs ${Math.max(...items.map(t => t.sequence))} rows below it: start higher`}
    let probe = doc
    // rows in use per column: nothing is deployed when any new item (or the take-off to create) would share a row with them
    const inColumn = (e: SubstationEquipmentRecord) => (!!e.takeOffId && doc.takeOffs.some(t => t.id === e.takeOffId && t.bayId === bayId)) || (!!e.lineSide && e.bayId === bayId && !e.takeOffId)
    const takenBay = new Set(doc.equipments.filter(e => e.bayId === bayId && !e.takeOffId && !e.lineSide).map(e => e.row))
    const takenColumn = new Set([...doc.equipments.filter(inColumn).map(e => e.row), ...doc.takeOffs.filter(t => t.bayId === bayId && t.takeOffColumn && t.row !== undefined).map(t => t.row!)])
    const overlaps = new Set(rows.filter((s, i) => (items[i].lineSide ? takenColumn : takenBay).has(s)))
    const refuse = () => {
        plan.overlaps = [...overlaps].sort((a, b) => a - b)
        return {...plan, ops: [], equipments: [], error: `nothing added: row${plan.overlaps.length === 1 ? '' : 's'} ${plan.overlaps.join(', ')} of bay ${bay.bayNumber} already hold${plan.overlaps.length === 1 ? 's' : ''} equipment in that column; move it, pick another start row or direction`}
    }
    // a take-off (line) bay: its line-side equipment hangs on the bay's first flagged take-off, else on a new one one row beyond it in the
    // deploy direction; other bay types (transformer, bus tie, …) place line-side equipment in the line column by the flag alone
    const columnRows = rows.filter((_, i) => items[i].lineSide)
    if (columnRows.length && template.bayTemplateType === BayTemplateType.TAKEOFF) {
        const own = doc.takeOffs.find(t => t.bayId === bayId && t.takeOffColumn)
        if (own) plan.takeOffId = own.id
        else {
            const row = direction === 'up' ? Math.max(...columnRows) + 1 : Math.min(...columnRows) - 1
            if (row < 0) return {...plan, error: `going down from row ${start} there is no row left below the take-off column equipment for the take-off: start higher`}
            if (takenColumn.has(row)) overlaps.add(row)
            if (overlaps.size) return refuse()
            const lineName = `LINE_${doc.takeOffs.filter(t => t.substationId === yard.id).length + 1}`
            const naming = takeOffNaming(doc, yard.id, lineName)
            const record: SubstationTakeOffRecord = {id: uniqueId(doc, naming.id), name: naming.name, substationId: yard.id, bayId, lineName, row, takeOffColumn: true}
            plan.takeOff = record
            plan.takeOffId = record.id
            const op: NetworkOp = {type: 'upsert', collection: 'takeOffs', record}
            plan.ops.push(op)
            probe = applyOps(probe, [op])
        }
    }
    if (overlaps.size) return refuse()
    let n = doc.equipments.filter(e => e.bayId === bayId).length
    items.forEach((t, i) => {
        n++
        const code = `${bay.bayNumber}-${n}`
        const naming = equipmentNaming(probe, yard.id, code, t.equipmentType)
        const record: SubstationEquipmentRecord = {
            id: uniqueId(probe, naming.id),
            name: naming.name,
            substationId: yard.id,
            bayId,
            code,
            equipmentType: t.equipmentType,
            terminals: defaultTerminals(t.equipmentType),
            row: rows[i],
            takeOffId: t.lineSide ? plan.takeOffId : undefined,
            lineSide: t.lineSide || undefined,
            busTie: t.busTie || undefined,
        }
        plan.equipments.push(record)
        const op: NetworkOp = {type: 'upsert', collection: 'equipments', record}
        plan.ops.push(op)
        probe = applyOps(probe, [op])
    })
    return plan
}
