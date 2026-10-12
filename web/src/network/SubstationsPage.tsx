import {useState} from 'react'
import {TransmissionVoltage} from '@shared/models/transmission.voltage'
import type {SubstationRecord} from '@shared/network/records'
import {cascadeDeleteOps, pickId} from '@shared/network/ops'
import {yardNaming} from '@shared/network/naming'
import {yardNameForVoltage} from '@shared/models/naming'
import {NewIdField, newIdOk} from './IdEditor'
import {enumLabel} from '../components/fields'
import {hrefTo} from '../hooks/useHashRoute'
import {useNetworkEditor} from './NetworkContext'
import type {MetaResponse} from '../api/client'

/** `#/network/:id/substations` – every yard of every site, with a quick "add yard". */
export function SubstationsPage({meta, navigate}: { meta: MetaResponse; navigate: (path: string) => void }) {
    const ed = useNetworkEditor()
    const [groupId, setGroupId] = useState('')
    /** Typed yard name; empty = from the voltage (`230KV`, `300KVDC`). */
    const [yardName, setYardName] = useState('')
    const [voltage, setVoltage] = useState<string>(TransmissionVoltage.AC230KV)
    const [newId, setNewId] = useState('')
    const groups = [...ed.doc.substationGroups].sort((a, b) => a.groupName.localeCompare(b.groupName))
    const selectedGroup = groupId || groups[0]?.id || ''

    const addYard = () => {
        const g = ed.doc.substationGroups.find(x => x.id === selectedGroup)
        if (!g) return
        const naming = yardNaming(ed.doc, g.id, yardName, voltage)
        const record: SubstationRecord = {
            id: pickId(ed.doc, newId, naming.id),
            groupId: g.id,
            yardName: naming.name,
            voltage: voltage as TransmissionVoltage,
        }
        if (ed.apply([{type: 'upsert', collection: 'substations', record}])) navigate(`/network/${ed.networkId}/substation/${record.id}`)
    }

    return (
        <div className="main narrow" style={{overflow: 'auto'}}>
            <div className="panel">
                <h2>Substations</h2>
                {groups.length === 0 && <p className="muted">No substation sites yet. Switch to the <a href={hrefTo(`/network/${ed.networkId}/map`)}>map</a>, choose "Add site" and click where the substation is.</p>}
                {groups.map(g => {
                    const yards = ed.doc.substations.filter(s => s.groupId === g.id).sort((a, b) => a.yardName.localeCompare(b.yardName))
                    return (
                        <div key={g.id} style={{marginBottom: 16}}>
                            <h3>{g.groupName}{g.name && g.name !== g.groupName ? ` · ${g.name}` : ''} <span className="muted small">({g.coords.latitude.toFixed(5)}, {g.coords.longitude.toFixed(5)})</span></h3>
                            {yards.length === 0 ? <p className="muted small">No yards.</p> : (
                                <table>
                                    <thead>
                                    <tr>
                                        <th>Yard</th>
                                        <th>Voltage</th>
                                        <th>Arrangement</th>
                                        <th>Buses</th>
                                        <th>Bays</th>
                                        <th>Equipment</th>
                                        <th>Take-offs</th>
                                        <th style={{width: 1}}/>
                                    </tr>
                                    </thead>
                                    <tbody>
                                    {yards.map(y => (
                                        <tr key={y.id}>
                                            <td><a href={hrefTo(`/network/${ed.networkId}/substation/${y.id}`)}><strong>{y.yardName}</strong></a> <span className="muted small mono">{y.id}</span></td>
                                            <td>{y.voltage}</td>
                                            <td className="muted small">{y.arrangement ?? '–'}</td>
                                            <td>{ed.doc.buses.filter(b => b.substationId === y.id).length}</td>
                                            <td>{ed.doc.bays.filter(b => b.substationId === y.id).length}</td>
                                            <td>{ed.doc.equipments.filter(e => e.substationId === y.id).length}</td>
                                            <td>{ed.doc.takeOffs.filter(t => t.substationId === y.id).length}</td>
                                            <td className="toolbar" style={{flexWrap: 'nowrap'}}>
                                                <button type="button" className="small" onClick={() => navigate(`/network/${ed.networkId}/substation/${y.id}`)}>Open</button>
                                                <button type="button" className="small danger" onClick={() => {
                                                    if (window.confirm(`Delete yard ${g.groupName} ${y.yardName} with all its buses, bays, equipment and take-offs?`)) ed.apply(cascadeDeleteOps(ed.doc, 'substations', y.id))
                                                }}>Delete
                                                </button>
                                            </td>
                                        </tr>
                                    ))}
                                    </tbody>
                                </table>
                            )}
                        </div>
                    )
                })}
            </div>
            {groups.length > 0 && (
                <div className="panel">
                    <h3>Add yard</h3>
                    <div className="toolbar">
                        <select value={selectedGroup} onChange={e => setGroupId(e.target.value)}>
                            {groups.map(g => <option key={g.id} value={g.id}>{g.groupName}</option>)}
                        </select>
                        <select value={voltage} onChange={e => setVoltage(e.target.value)}>
                            {meta.enums.transmissionVoltage.map(v => <option key={v} value={v}>{enumLabel(v)}</option>)}
                        </select>
                        <input type="text" value={yardName} onChange={e => setYardName(e.target.value.toUpperCase())} placeholder={`Yard name: ${yardNameForVoltage(voltage)}`} title="Left empty: named after the voltage" style={{width: 160}}/>
                        <NewIdField compact value={newId} onChange={setNewId} auto={selectedGroup ? yardNaming(ed.doc, selectedGroup, yardName, voltage).id : undefined}/>
                        <button type="button" className="primary" onClick={addYard} disabled={!selectedGroup || !newIdOk(ed.doc, newId)}>Add and open</button>
                    </div>
                </div>
            )}
        </div>
    )
}
