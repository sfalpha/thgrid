import {createElement} from 'react'
import {SubstationEquipmentType} from '@shared/models/substation.equipment'
import {TAKEOFF_ARM} from './geometry'
import {JUNCTION_COLOR, JUNCTION_FILL_OPACITY, JUNCTION_SYMBOL_PX, JUNCTION_SYMBOL_RECT, voltageSymbolColor, voltageSymbolShape} from './mapUtil'

/** Single-line diagram symbol of an equipment type, drawn centred on (0,0) within ±20 px. */
export function EquipmentSymbol({type}: { type: SubstationEquipmentType }) {
    switch (type) {
        case SubstationEquipmentType.CIRCUIT_BREAKER:
            return <rect x={-10} y={-10} width={20} height={20} className="sym fill"/>
        case SubstationEquipmentType.MTS_BREAKER:
            return (
                <g className="sym">
                    <rect x={-10} y={-10} width={20} height={20}/>
                    <path d="M-10,-10 L10,10 M-10,10 L10,-10"/>
                </g>
            )
        case SubstationEquipmentType.DISCONNECTING_SWITCH:
            return (
                <g className="sym">
                    <path d="M0,-14 L0,-10 M0,10 L0,14 M0,10 L10,-10"/>
                    <circle cx={0} cy={-10} r={2.5}/>
                </g>
            )
        case SubstationEquipmentType.GROUND_SWITCH:
            // An L like a take-off: from the terminal on the bay column along the row to the right, then the switch and the earth always pointing down.
            return (
                <g className="sym">
                    <path d={`M0,0 H${TAKEOFF_ARM} V8 M${TAKEOFF_ARM},8 L${TAKEOFF_ARM + 10},26 M${TAKEOFF_ARM},26 L${TAKEOFF_ARM},30 M${TAKEOFF_ARM - 8},30 L${TAKEOFF_ARM + 8},30 M${TAKEOFF_ARM - 5},34 L${TAKEOFF_ARM + 5},34 M${TAKEOFF_ARM - 2},38 L${TAKEOFF_ARM + 2},38`}/>
                    <circle cx={TAKEOFF_ARM} cy={8} r={2.5}/>
                </g>
            )
        case SubstationEquipmentType.SURGE_ARRESTER:
            return (
                <g className="sym">
                    <rect x={-6} y={-12} width={12} height={24}/>
                    <path d="M0,-8 L0,6 M-4,2 L0,6 L4,2"/>
                </g>
            )
        case SubstationEquipmentType.CURRENT_TRANSFORMER:
            return (
                <g className="sym">
                    {/* the primary runs through the ring from terminal to terminal (TERMINAL_OFFSET = 26) */}
                    <path d="M0,-26 L0,26"/>
                    <circle cx={0} cy={0} r={8}/>
                </g>
            )
        case SubstationEquipmentType.POTENTIAL_TRANSFORMER:
            return (
                <g className="sym">
                    <circle cx={-5} cy={0} r={7}/>
                    <circle cx={5} cy={0} r={7}/>
                </g>
            )
        case SubstationEquipmentType.POWER_TRANSFORMER:
        case SubstationEquipmentType.SERVICE_TRANSFORMER:
            return (
                <g className="sym">
                    <circle cx={0} cy={-6} r={9}/>
                    <circle cx={0} cy={6} r={9}/>
                </g>
            )
        case SubstationEquipmentType.SHUNT_REACTOR:
            return <path className="sym" d="M0,-14 L0,-10 C-6,-10 -6,-2 0,-2 C-6,-2 -6,6 0,6 C-6,6 -6,14 0,14 M0,14 L0,16" />
        case SubstationEquipmentType.POWER_FUSE:
            return (
                <g className="sym">
                    <rect x={-5} y={-12} width={10} height={24}/>
                    <path d="M0,-16 L0,16"/>
                </g>
            )
        case SubstationEquipmentType.STATIC_VAR_COMPENSATOR:
            return (
                <g className="sym">
                    <rect x={-14} y={-9} width={28} height={18}/>
                    <text x={0} y={4} textAnchor="middle" fontSize={9} className="sym-text">SVC</text>
                </g>
            )
        default:
            return <rect x={-10} y={-10} width={20} height={20} className="sym"/>
    }
}

export const equipmentTypeLabels: Record<SubstationEquipmentType, string> = {
    [SubstationEquipmentType.CIRCUIT_BREAKER]: 'Circuit breaker',
    [SubstationEquipmentType.MTS_BREAKER]: 'MTS breaker',
    [SubstationEquipmentType.DISCONNECTING_SWITCH]: 'Disconnecting switch',
    [SubstationEquipmentType.GROUND_SWITCH]: 'Ground switch',
    [SubstationEquipmentType.SURGE_ARRESTER]: 'Surge arrester',
    [SubstationEquipmentType.CURRENT_TRANSFORMER]: 'Current transformer',
    [SubstationEquipmentType.POTENTIAL_TRANSFORMER]: 'Potential transformer',
    [SubstationEquipmentType.POWER_TRANSFORMER]: 'Power transformer',
    [SubstationEquipmentType.SERVICE_TRANSFORMER]: 'Service transformer',
    [SubstationEquipmentType.STATIC_VAR_COMPENSATOR]: 'Static VAR compensator',
    [SubstationEquipmentType.SHUNT_REACTOR]: 'Shunt reactor',
    [SubstationEquipmentType.POWER_FUSE]: 'Power fuse',
}

/** A yard's voltage symbol (▼ 69 kV, ▲ 115 kV, ■ 230 kV, hexagon 500 kV, ● other) in the voltage colour, dulled when planned; same shapes as the map labels. */
export function VoltageSymbol({voltage, planned, size = 11}: { voltage?: string; planned?: boolean; size?: number }) {
    const {tag, attrs} = voltageSymbolShape(voltage)
    return (
        <svg className="vsym" width={size} height={size} viewBox="0 0 12 12" aria-hidden="true">
            {createElement(tag, {...attrs, fill: voltageSymbolColor(voltage, planned)})}
        </svg>
    )
}

/** The map's junction area in small (a see-through blue box), for the legend; a little larger than `VoltageSymbol`. */
export function JunctionSymbol({size = JUNCTION_SYMBOL_PX}: { size?: number }) {
    return (
        <svg className="vsym jsym" width={size} height={size} viewBox="0 0 12 12" aria-hidden="true">
            <rect {...JUNCTION_SYMBOL_RECT} fill={JUNCTION_COLOR} fillOpacity={JUNCTION_FILL_OPACITY * 2} stroke={JUNCTION_COLOR} strokeWidth={1}/>
        </svg>
    )
}
