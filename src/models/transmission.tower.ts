import {ConductorMountType, isAerialMount, TransmissionWireType} from "./transmission.conductor";

/**
 * The tower a circuit hangs on, a hint for the tower drawing. Unset: none, the drawing's default (a lattice tower with a
 * pair of circuits per level). Only for an aerial mount (`towerTypeApplies`).
 */
export enum TowerType {
    LATTICE_STEEL_SINGLE_CIRCUIT = 'LATTICE_STEEL_SINGLE_CIRCUIT',
    LATTICE_STEEL_DOUBLE_CIRCUIT = 'LATTICE_STEEL_DOUBLE_CIRCUIT',
    LATTICE_STEEL_QUAD_CIRCUIT = 'LATTICE_STEEL_QUAD_CIRCUIT',
    MONOPOLE_SINGLE_CIRCUIT = 'MONOPOLE_SINGLE_CIRCUIT',
    MONOPOLE_DOUBLE_CIRCUIT = 'MONOPOLE_DOUBLE_CIRCUIT',
    MONOPOLE_QUAD_CIRCUIT = 'MONOPOLE_QUAD_CIRCUIT',
    LATTICE_STEEL_HORIZONTAL = 'LATTICE_STEEL_HORIZONTAL',
    LATTICE_STEEL_DELTA = 'LATTICE_STEEL_DELTA',
    LATTICE_STEEL_COMPACT_SINGLE_CIRCUIT = 'LATTICE_STEEL_COMPACT_SINGLE_CIRCUIT',
    LATTICE_STEEL_COMPACT_DOUBLE_CIRCUIT = 'LATTICE_STEEL_COMPACT_DOUBLE_CIRCUIT',
}

export const TOWER_TYPE_LABELS: Record<TowerType, string> = {
    [TowerType.LATTICE_STEEL_SINGLE_CIRCUIT]: 'Lattice Steel Single Circuit',
    [TowerType.LATTICE_STEEL_DOUBLE_CIRCUIT]: 'Lattice Steel Double Circuit',
    [TowerType.LATTICE_STEEL_QUAD_CIRCUIT]: 'Lattice Steel Quad Circuit',
    [TowerType.MONOPOLE_SINGLE_CIRCUIT]: 'Monopole Single Circuit',
    [TowerType.MONOPOLE_DOUBLE_CIRCUIT]: 'Monopole Double Circuit',
    [TowerType.MONOPOLE_QUAD_CIRCUIT]: 'Monopole Quad Circuit',
    [TowerType.LATTICE_STEEL_HORIZONTAL]: 'Lattice Steel Horizontal',
    [TowerType.LATTICE_STEEL_DELTA]: 'Lattice Steel Delta',
    [TowerType.LATTICE_STEEL_COMPACT_SINGLE_CIRCUIT]: 'Lattice Steel Compact Single Circuit',
    [TowerType.LATTICE_STEEL_COMPACT_DOUBLE_CIRCUIT]: 'Lattice Steel Compact Double Circuit',
}

/**
 * Whether a circuit can hang on a tower type: its mount is an aerial one; without a mount, its conductor is not an XLPE
 * cable.
 */
export function towerTypeApplies(mountType: ConductorMountType | undefined, wireType: TransmissionWireType | undefined): boolean {
    return mountType ? isAerialMount(mountType) : wireType !== TransmissionWireType.XLPE
}
