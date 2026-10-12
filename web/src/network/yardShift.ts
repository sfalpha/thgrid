/** Moves a whole yard on its diagram: every row (buses, equipment, take-offs) up or down, or every bay column left or right. */
import type {NetworkDocument} from '@shared/network/records'
import type {NetworkOp} from '@shared/network/ops'

export interface ShiftPlan {
    ops: NetworkOp[]
    /** Records moved. */
    count: number
    error?: string
}

/** Shifts all rows of the yard by `delta` (+1 up, -1 down); refused when a row would go below 0. */
export function shiftYardRowsOps(doc: NetworkDocument, yardId: string, delta: number): ShiftPlan {
    const buses = doc.buses.filter(b => b.substationId === yardId)
    const equipments = doc.equipments.filter(e => e.substationId === yardId)
    const takeOffs = doc.takeOffs.filter(t => t.substationId === yardId && t.row !== undefined)
    const rows = [...buses.map(b => b.row), ...equipments.map(e => e.row), ...takeOffs.map(t => t.row!)]
    if (!rows.length) return {ops: [], count: 0, error: 'nothing to move: the yard has no buses, equipment or placed take-offs'}
    if (Math.min(...rows) + delta < 0) return {ops: [], count: 0, error: `cannot move down: row ${Math.min(...rows)} is already the bottom`}
    const ops: NetworkOp[] = [
        ...buses.map(b => ({type: 'upsert', collection: 'buses', record: {...b, row: b.row + delta}}) as NetworkOp),
        ...equipments.map(e => ({type: 'upsert', collection: 'equipments', record: {...e, row: e.row + delta}}) as NetworkOp),
        ...takeOffs.map(t => ({type: 'upsert', collection: 'takeOffs', record: {...t, row: t.row! + delta}}) as NetworkOp),
    ]
    return {ops, count: ops.length}
}

/** Shifts all bay columns of the yard by `delta` (+1 right, -1 left); refused when a column would go below 0. */
export function shiftYardColumnsOps(doc: NetworkDocument, yardId: string, delta: number): ShiftPlan {
    const bays = doc.bays.filter(b => b.substationId === yardId)
    if (!bays.length) return {ops: [], count: 0, error: 'nothing to move: the yard has no bays'}
    const min = Math.min(...bays.map(b => b.column))
    if (min + delta < 0) return {ops: [], count: 0, error: `cannot move left: column ${min} is already the leftmost`}
    const ops: NetworkOp[] = bays.map(b => ({type: 'upsert', collection: 'bays', record: {...b, column: b.column + delta}}) as NetworkOp)
    return {ops, count: ops.length}
}
