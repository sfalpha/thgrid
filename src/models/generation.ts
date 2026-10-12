/** Kinds of generation a site (power plant / producer) can host. */
export enum GenerationType {
    HYDRO = 'HYDRO',
    SOLAR = 'SOLAR',
    BESS = 'BESS',
    WIND = 'WIND',
    GAS_TURBINE = 'GAS_TURBINE',
    COMBINED_CYCLE_GAS_TURBINE = 'COMBINED_CYCLE_GAS_TURBINE',
    THERMAL = 'THERMAL',
    GEOTHERMAL = 'GEOTHERMAL',
}

export const GENERATION_LABELS: Record<GenerationType, string> = {
    [GenerationType.HYDRO]: 'Hydro',
    [GenerationType.SOLAR]: 'Solar',
    [GenerationType.BESS]: 'BESS',
    [GenerationType.WIND]: 'Wind',
    [GenerationType.GAS_TURBINE]: 'Gas Turbine',
    [GenerationType.COMBINED_CYCLE_GAS_TURBINE]: 'Combined Cycle Gas Turbine',
    [GenerationType.THERMAL]: 'Thermal',
    [GenerationType.GEOTHERMAL]: 'GeoThermal',
}

/** Letter and colour of the small badge drawn for each generation type (the map, lists). */
export const GENERATION_BADGES: Record<GenerationType, { letter: string; color: string }> = {
    [GenerationType.HYDRO]: {letter: 'H', color: '#1f6feb'},
    [GenerationType.SOLAR]: {letter: 'S', color: '#e0a800'},
    [GenerationType.BESS]: {letter: 'B', color: '#8e44ad'},
    [GenerationType.WIND]: {letter: 'W', color: '#1aa39b'},
    [GenerationType.GAS_TURBINE]: {letter: 'GT', color: '#c8651b'},
    [GenerationType.COMBINED_CYCLE_GAS_TURBINE]: {letter: 'CC', color: '#d62828'},
    [GenerationType.THERMAL]: {letter: 'T', color: '#7a3b1e'},
    [GenerationType.GEOTHERMAL]: {letter: 'GE', color: '#a0522d'},
}

/** Colour of the large "G" badge of a generation site. */
export const GENERATION_SITE_COLOR = '#2e9e4f'
