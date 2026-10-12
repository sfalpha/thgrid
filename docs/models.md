# thgrid – Model specification

This document describes the data models of thgrid: the runtime domain classes,
the **template** models that the template editor persists as JSON, the
**collection** model that groups templates, and the **draft network records**
reserved for the future connection editor.

Companion documents: [backend.md](backend.md) (API and storage) and
[frontend.md](frontend.md) (web UI).

---

## 1. Overview

```
src/
  models/      runtime domain classes (object graph, used by computations)
  templates/   template payloads, envelope, collections, validation, registry, resolver
  factory/     turn a template + meta into runtime objects
  network/     records of a grid (substations / equipment / lines / connections), ops, validation
data/
  templates/<kind-directory>/<id>.json      one file per template
  collections/<id>.json                     one file per collection
  networks/<id>.json                        one grid per file (+ history/ and journal/)
```

Three layers of representation exist for the same concepts:

| Layer | Example | Lives in | Serialisable |
|---|---|---|---|
| Runtime class | `SubstationPowerTransformer`, `TransmissionCircuit` | `src/models` | No (back-references) |
| Template (spec) | `PowerTransformerTemplate`, `TransmissionCircuitTemplateData` | `src/templates`, `data/templates` | Yes |
| Network record | `SubstationEquipmentRecord`, `ConnectionRecord` | `src/network`, `data/networks` | Yes |

Templates describe *what kind of thing* to build; factories build runtime
objects from templates; network records describe *which concrete things exist
and how they are connected*.

---

## 2. Runtime domain models (`src/models`)

These already existed and are unchanged. Summary for orientation:

### 2.1 Enums

| Enum | Values | File |
|---|---|---|
| `TransmissionVoltage` | `AC500KV, AC230KV, AC115KV, AC69KV, AC33KV, AC24KV, AC22KV, AC400V, DC300KV, 0V` (`DE_ENERGIZED`: built but unused, or a planned line partly built; shown as "0V (De-Energized)", drawn black) | `transmission.voltage.ts` |
| `TransmissionWireType` | `GENERIC, AAC, ACSR/GA, ACSR/AW, HTLS/INVAR, HTLS/ACCC` (HTLS = high-temperature low-sag, Invar core or ACCC composite core; `GENERIC` with size 0 SQMM is the conductor of a circuit whose conductor is unknown, `GENERIC_CONDUCTOR`) | `transmission.conductor.ts` |
| `TransmissionWireUnit` | `SQMM, MCM, AWG` | `transmission.conductor.ts` |
| `TransformerWindingSide` | `PRIMARY, SECONDARY, AUXILIARY` (older files with `HIGH_SIDE` / `LOW_SIDE` are read as such) | `transformer.ts` |
| `TransformerWindingWiring` | `SINGLE, STAR, DELTA, TWELVE_PHASE` | `transformer.ts` |
| `TransformerWindingTapChanger` | `NONE, BASIC, ONLOAD` | `transformer.ts` |
| `TransformerCooling` | `ONAN, ONAF, OA, FA` | `transformer.ts` |
| `SubstationEquipmentType` | `CIRCUIT_BREAKER, MTS_BREAKER, DISCONNECTING_SWITCH, GROUND_SWITCH, SURGE_ARRESTER, CURRENT_TRANSFORMER, POTENTIAL_TRANSFORMER, POWER_TRANSFORMER, SERVICE_TRANSFORMER, STATIC_VAR_COMPENSATOR, SHUNT_REACTOR, POWER_FUSE` | `substation.equipment.ts` |
| `SubstationArrangement` | `SINGLE_BUS, DOUBLE_BUS, …, BREAKER_AND_A_HALF, RING, MESH` | `substation.ts` |
| `SubstationBusType` | `MAIN, TRANSFER` | `substation.bus.ts` |
| `BayTemplateType` | `TAKEOFF, BUS_TIE, HIGH_SIDE_TRANSFORMER, LOW_SIDE_TRANSFORMER, CAPACITOR_BANK, SHUNT_REACTOR, STATIC_VAR_COMPENSATOR` (purpose of a bay template) | `substation.bay.ts` |
| `GenerationType` | `HYDRO, SOLAR, BESS, WIND, GAS_TURBINE, COMBINED_CYCLE_GAS_TURBINE, THERMAL, GEOTHERMAL` (labels and badge letters / colours in `GENERATION_LABELS` / `GENERATION_BADGES`) | `generation.ts` |

### 2.2 Class hierarchy

```
SubstationUnit (id, name, coords)
├── SubstationGroup            substations[]
├── Substation                 substationGroup, voltage, arrangement, buses[], bays[], takeOffs[], equipments[]
├── SubstationCircuit          current, voltage
│   └── SubstationBay          substation, bayNumber, column
│       └── SubstationBus      busType, busNumber, row
├── SubstationTakeOff          bay, circuit (SubstationCircuit), lineName
└── SubstationEquipment        bay, code, equipmentType, brand, model
    ├── SubstationCircuitBreaker / MtsBreaker / DisconnectingSwitch / PowerFuse / ShuntReactor / CurrentTransformer   circuitA, circuitB
    ├── SubstationPotentialTransformer / GroundSwitch / SurgeArrester       circuit
    └── SubstationTransformer  windings{key → TransformerWinding}, modules
        └── SubstationPowerTransformer

SubstationEquipmentUnit (id, name)
└── SubstationEquipmentCircuit (current, voltage)      a connectable terminal of a piece of equipment
    └── TransformerWinding     transformer, windingSide, wiring, tapChanger, ratings[]

TransmissionUnit (id, name, coords)
├── TransmissionPath           name, waypoints[] (physical route shared by parallel circuits)
├── TransmissionCircuit        current, voltage, bundle, conductor, path (TransmissionPath)
├── TransmissionJunction       connections{key → TransmissionConnection}
├── TransmissionConnection     circuits[] (TransmissionCircuit | SubstationCircuit), junction (TransmissionJunction | Substation)
└── TransmissionLine           connections[]
```

#### Default ids and names

Every `SubstationUnit` / `TransmissionUnit` subclass carries a static
`idPrefix` and two static methods, `defaultId(hints)` and
`defaultName(hints)`, that build an id / name from the names of related
items (the hints are plain strings, so the frontend feeds them from the
records, see `src/network/naming.ts`). A constructor fills `id` / `name`
with them when the props leave them empty; with no usable hint the id is
`<prefix>_<uuid>`. Helpers live in `src/models/naming.ts` (`joinId`
sanitises tokens to `[A-Za-z0-9_.-]`).

| Class | Prefix | Default id | Default name |
|---|---|---|---|
| `SubstationGroup` | `SSG` | `SSG_<site>` | site code |
| `Substation` (yard) | `SSY` | `SSY_<site>_<yard>` | yard name; the yard name itself defaults to the voltage without its AC prefix, `DC` suffixed for direct current (`AC230KV` → `230KV`, `DC300KV` → `300KVDC`, `AC400V` → `400V`; `yardNameForVoltage`) |
| `SubstationCircuit` | `SCC` | `SCC_<site>_<yard>_<line \| X<n>>` | line name / `X<n>` |
| `SubstationBay` | `SBA` | `SBA_<site>_<yard>_<bay>` | `BAY_<bay>` |
| `SubstationBus` | `SBU` | `SBU_<site>_<yard>_<type>_BUS_<n>` | `<type>_BUS_<n>` (`TRANSFER_BUS`) |
| `SubstationTakeOff` | `STO` | `STO_<site>_<yard>_<line>` | line name; the line name itself defaults to `<voltage>_<target site code>_L<n>` (`230KV_CTI_L1`, `300KVDC_CTI_L1`; the voltage token is the yard's, as in the yard name), `n` numbering the yard's lines toward that site (`takeOffLineName` picks the next free number, counting older `<code>_L<n>` names too) |
| `SubstationEquipment` | per type (`SCB`, `SMT`, `SDS`, `SGS`, `SSA`, `SCT`, `SPT`, `SKT`, `SKW`, `SSV`, `SSR`, `SFU`; `SXX` unknown, `STF` generic transformer) | `<prefix>_<site>_<yard>_<code>` | equipment code |
| `TransmissionJunction` | `TJT` | `TJT_<name>` | `JT<n>` |
| `TransmissionPath` | `TPA` | `TPA_<from>_<to>[_<n>]` | `<from>-<to>[ (n)]`; the ends are sites (by code) or junctions, a route is not specific to a voltage (`CTI-TRD`, `TPA_CTI_TRD`), `n` numbering the routes between the same two names |
| `TransmissionCircuit` | `TCC` | `TCC_<name>` | in a line: `<line name>_<path name>` (of several lines the first by name; e.g. `230KV_PDG_BKI_L1_PDG-BKI`); in no line: `<kV>_<path name>_S<n>`, n numbering the circuits on that path that are in no line (e.g. `115KV_KLA_JT1-KLA_S1`); without a path `<FROM>-<TO>` (site codes) stands for the path name; the kV is the rated voltage, else the energized one (`circuitNaming` / `defaultNamingFor` in `naming.ts`; a regeneration names circuits after the paths and lines it renames) |
| `TransmissionConnection` | `TCN` | `TCN_<at>_<take-off \| n>` | take-off line name at a yard, `<junction>_<n>` at a junction |
| `TransmissionLine` | `TLN` | `TLN_<name>` | `<kV>_<from>_<to>_L<n>` (`n` numbers the lines between the same two substations, in either direction: `230KV_CNO_CTI_L1`, `230KV_CNO_CTI_L2`) |

`<from>` / `<to>` are the names of the ends: a site by its code (a path ends
at a site; a circuit or line end at a yard is named by the yard's site code
too); a junction by its name.
Uniqueness within a network is not the classes' concern: the editors pass
the result through `uniqueId()` / `pickId()`, which append `_2`, `_3`, …

### 2.3 Factories (`src/factory`)

| Factory | Input | Output |
|---|---|---|
| `SubstationPowerTransformerFactory.new(template, {bay, code})` | `PowerTransformerTemplate` | `SubstationPowerTransformer` with one `TransformerWinding` per template winding |
| `TransmissionCircuitFactory.new(template, {name})` | `TransmissionCircuitTemplate` (conductor embedded) | `TransmissionCircuit` |

Factories take the **resolved** template shapes (section 3.4), never the
persisted ones.

---

## 3. Template models (`src/templates`)

### 3.1 Template kinds

```ts
enum TemplateKind {
  POWER_TRANSFORMER      = 'POWER_TRANSFORMER',
  TRANSMISSION_CIRCUIT   = 'TRANSMISSION_CIRCUIT',
  TRANSMISSION_CONDUCTOR = 'TRANSMISSION_CONDUCTOR',
  SUBSTATION_YARD        = 'SUBSTATION_YARD',
  SUBSTATION_BAY         = 'SUBSTATION_BAY',
}
```

`TemplateDataByKind` maps each kind to its payload interface; everything else
(`TemplateRecord<K>`, `TemplateInput<K>`, `resolveTemplate`) is generic over
it. The **registry** (`registry.ts`) holds one `TemplateKindDefinition` per
kind:

| Field | Meaning |
|---|---|
| `label`, `pluralLabel`, `description` | UI text |
| `directory` | sub-directory of `data/templates` (`transmission-conductor`, `transmission-circuit`, `power-transformer`, `substation-yard`, `substation-bay`) |
| `validate(data, ctx)` | payload validator (section 3.5) |
| `references(data)` | `TemplateRef[]` the payload points at (used for integrity checks and bundle export) |

`templateKindOrder` lists kinds dependencies-first (conductor → circuit →
transformer) and drives the UI sidebar.

### 3.2 Envelope

Every persisted template is a `TemplateRecord`:

```ts
interface TemplateMeta {
  id: string            // ^[a-z0-9][a-z0-9_-]{0,79}$ ; file name without .json ; immutable
  kind: TemplateKind
  description?: string  // ≤ 2000 chars
  tags?: string[]
  createdAt: string     // ISO-8601, set by backend
  updatedAt: string     // ISO-8601, set by backend
}
interface TemplateRecord<K> extends TemplateMeta { kind: K; data: TemplateDataByKind[K] }
```

The human readable name is **inside the payload** (`data.name`) because the
original template interfaces define it there; `TemplateSummary` lifts it out
for listings:

```ts
interface TemplateSummary { id; kind; name; description?; tags?; updatedAt }
```

Clients send a `TemplateInput`:

```ts
interface TemplateInput<K> { id?: string; description?: string; tags?: string[]; data: TemplateDataByKind[K] }
```

`id` is only honoured on create. When omitted it is derived with
`slugifyTemplateId(data.name)` (lower-case, non `[a-z0-9_-]` runs → `_`,
trimmed, max 80 chars). Ids never change afterwards, so renaming a template
does not rename its file.

### 3.3 Payloads

#### TRANSMISSION_CONDUCTOR – `TransmissionConductorTemplate`

| Field | Type | Rules |
|---|---|---|
| `name` | string | required, ≤ 120 |
| `size` | number | required, ≥ 0 |
| `unit` | `TransmissionWireUnit` | required |
| `type` | `TransmissionWireType` | required |
| `code` | string | optional, ≤ 60 |

```json
{
  "id": "tc_1272mcm_acsr_ga",
  "kind": "TRANSMISSION_CONDUCTOR",
  "description": "EGAT standard conductor",
  "tags": ["EGAT"],
  "createdAt": "2026-10-08T14:02:50.356Z",
  "updatedAt": "2026-10-08T14:02:50.356Z",
  "data": { "name": "TC_1272MCM_ACSR_GA", "size": 1272, "unit": "MCM", "type": "ACSR/GA" }
}
```

#### TRANSMISSION_CIRCUIT – `TransmissionCircuitTemplateData` (persisted)

| Field | Type | Rules |
|---|---|---|
| `name` | string | required, ≤ 120 |
| `voltage` | `TransmissionVoltage` | optional |
| `bundle` | integer | required, ≥ 1 (sub-conductors per phase) |
| `conductorId` | string | required, must be the id of an existing `TRANSMISSION_CONDUCTOR` template |

```json
{
  "id": "tct_230kv_4x1272mcm_acsr_ga",
  "kind": "TRANSMISSION_CIRCUIT",
  "data": { "name": "TCT_230KV_4x1272MCM_ACSR_GA", "voltage": "AC230KV", "bundle": 4, "conductorId": "tc_1272mcm_acsr_ga" }
}
```

The in-memory `TransmissionCircuitTemplate` (used by the factory) has
`conductor: TransmissionConductorTemplate` embedded instead of `conductorId`.
Storing a reference means a conductor is defined once and shared by many
circuits.

#### POWER_TRANSFORMER – `PowerTransformerTemplate`

| Field | Type | Rules |
|---|---|---|
| `name` | string | required, ≤ 120 |
| `modules` | integer | required, ≥ 1 (1 = three-phase unit, 3 = bank of single-phase units) |
| `windings` | `{ [key]: TransformerWindingTemplate }` | required, ≥ 1 entry, exactly one `PRIMARY`; keys match `^[A-Za-z0-9_-]{1,16}$` (conventionally `H`, `X`, `Y`) |

`TransformerWindingTemplate`:

| Field | Type | Rules |
|---|---|---|
| `windingSide` | `TransformerWindingSide` | required |
| `wiring` | `TransformerWindingWiring` | required |
| `voltage` | `TransmissionVoltage` | required |
| `tapChanger` | `TransformerWindingTapChanger` | required |
| `ratings` | `TransformerWindingRating[]` | optional; each `{ cooling: TransformerCooling, power: number ≥ 0 (kVA), perModule: boolean }` |

```json
{
  "id": "tr_230kv_115kv_a22kv_200mva_onaf",
  "kind": "POWER_TRANSFORMER",
  "data": {
    "name": "TR_230KV_115KV_A22KV_200MVA_ONAF",
    "modules": 1,
    "windings": {
      "H": { "windingSide": "PRIMARY", "wiring": "STAR", "voltage": "AC230KV", "tapChanger": "ONLOAD",
             "ratings": [ { "cooling": "ONAN", "power": 120000, "perModule": false },
                          { "cooling": "ONAF", "power": 200000, "perModule": false } ] },
      "X": { "windingSide": "SECONDARY",  "wiring": "STAR",  "voltage": "AC115KV", "tapChanger": "NONE" },
      "Y": { "windingSide": "AUXILIARY", "wiring": "DELTA", "voltage": "AC22KV",  "tapChanger": "NONE" }
    }
  }
}
```

#### SUBSTATION_YARD – `SubstationYardTemplate`

| Field | Type | Rules |
|---|---|---|
| `name` | string | required, ≤ 120 |
| `arrangement` | `SubstationArrangement` | required |
| `voltage` | `TransmissionVoltage` | optional, informational (a deployed yard keeps its own voltage) |
| `buses` | `SubstationBusTemplate[]` | required array, may be empty; each `{ name (required), busType (required), busNumber? (ignored for TRANSFER), row (integer ≥ 0) }`; no two buses of the same type and number, no two on the same row |

Deployed onto a yard (yard panel, *From yard template*) it sets the yard's
arrangement, adds the buses (a bus of the same type and number already in
the yard is kept) and a chosen number of empty bays in the next columns.

#### SUBSTATION_BAY – `SubstationBayTemplate`

| Field | Type | Rules |
|---|---|---|
| `name` | string | required, ≤ 120 |
| `bayTemplateType` | `BayTemplateType` | required (purpose: TAKEOFF, BUS_TIE, …) |
| `arrangements` | `SubstationArrangement[]` | required, ≥ 1, no repeats: the yard editor offers the template to yards of these arrangements only |
| `equipments` | `BayEquipmentTemplate[]` | required, ≥ 1; each `{ equipmentType (required), sequence (integer ≥ 0, unique), lineSide?, busTie? }` |

A bay template is independent of yard and bus templates. `sequence` is the
distance from the start row when the template is deployed (row = start +
sequence going up, start − sequence going down); 0 is the start row itself,
usually a bus, so templates begin at 1, and skipped numbers leave blank
rows. The flags are copied to the equipment records (`lineSide`, `busTie`).
Equipment flagged `lineSide` is the line side of the bay and is drawn in
the bay's line (take-off) column. In a TAKEOFF bay it is attached to the
bay's first flagged take-off (`takeOffId`), and when the bay has none a
take-off (`LINE_<n>`, flagged `takeOffColumn`) is created one row beyond
that equipment in the deploy direction; in the other bay types (transformer,
bus tie, …) the flag alone places it in the column and no take-off is made. Deployed equipment has no
connections (the bay panel's *Connect bay* wires the stack and ties the
column to the bay column where two disconnecting switches meet).

### 3.4 References and resolution (`resolve.ts`)

```ts
interface TemplateRef<K = TemplateKind> { kind: K; id: string }
interface TemplateLookup { get(ref): TemplateRecord | undefined }

resolveTemplate(record, lookup)                  // kind-dispatched
resolveTransmissionCircuitTemplate(data, lookup) // conductorId → embedded conductor
lookupFromRecords(records)                       // lookup over an in-memory list (e.g. a bundle)
```

`resolveTemplate` returns the factory-ready type for the kind
(`ResolvedTemplateByKind`). A missing reference throws `TemplateResolveError`.
Conductors and transformers resolve to themselves.

### 3.5 Validation (`validation.ts`)

Validators are plain functions shared by backend and UI:

```ts
interface ValidationIssue { path: string; message: string }   // path like "windings.H.ratings.0.power"
interface ValidationContext { exists(ref: TemplateRef): boolean }

validateTemplateEnvelope(input)                  // id / description / tags / data-is-object
validateTemplateData(kind, data, ctx)            // dispatches to the per-kind validator
validateTransmissionConductorTemplate(data)
validateTransmissionCircuitTemplate(data, ctx)   // checks conductorId exists via ctx
validatePowerTransformerTemplate(data)
validateCollectionInput(input, ctx)
validateTemplateId(id)
```

The backend prefixes payload issue paths with `data.`; the UI strips the
prefix again so form fields can map issues by path.

---

## 4. Collections (`collection.ts`)

A collection is a named, ordered set of template references of any kind.

```ts
interface TemplateCollectionItem extends TemplateRef { note?: string }    // note ≤ 500
interface TemplateCollection {
  id: string               // same pattern as template ids; file data/collections/<id>.json
  name: string             // required, ≤ 120
  description?: string
  tags?: string[]
  items: TemplateCollectionItem[]   // no duplicates; every ref must exist
  createdAt: string
  updatedAt: string
}
interface TemplateCollectionInput { id?; name; description?; tags?; items? }
interface TemplateCollectionSummary { id; name; description?; tags?; itemCount; updatedAt }
```

Collections hold references, not copies: editing a template is visible in
every collection containing it. Deleting a referenced template is refused
unless forced, in which case the item is pruned from collections.

### 4.1 Bundle (export / import format)

```ts
interface TemplateBundle {
  format: 'thgrid.template-bundle'
  version: 1
  exportedAt: string
  collection: TemplateCollection
  templates: TemplateRecord[]   // every item plus transitive references (e.g. circuits' conductors)
}
```

Importing a bundle validates all templates against *bundle + existing data*,
then writes the templates and the collection (`createdAt` of existing records
is preserved).

Example (`data/collections/egat_standard.json`):

```json
{
  "id": "egat_standard",
  "name": "EGAT standard",
  "description": "Standard conductors, line circuits and power transformers used by EGAT.",
  "tags": ["EGAT"],
  "items": [
    { "kind": "TRANSMISSION_CONDUCTOR", "id": "tc_1272mcm_acsr_ga" },
    { "kind": "TRANSMISSION_CIRCUIT",   "id": "tct_230kv_4x1272mcm_acsr_ga" },
    { "kind": "POWER_TRANSFORMER",      "id": "tr_230kv_115kv_a22kv_200mva_onaf", "note": "default 230/115 kV" }
  ],
  "createdAt": "…", "updatedAt": "…"
}
```

---

## 5. Storage layout (`data/`)

```
data/
  templates/
    transmission-conductor/<id>.json
    transmission-circuit/<id>.json
    power-transformer/<id>.json
  collections/<id>.json
  networks/<id>.json                   current version of a grid (section 6.8)
  networks/history/<id>.<stamp>.json   archived versions
  networks/journal/<id>.json           unsaved ops
```

* One pretty-printed JSON document per file, trailing newline, so files diff
  well in git. Files may be edited by hand; the backend reads from disk on
  every request.
* Writes are atomic (temp file + rename).
* File names are the `id`; ids are restricted to `^[a-z0-9][a-z0-9_-]{0,79}$`
  so they are safe on every file system and in URLs.

---

## 6. Network records (`src/network`)

A **network** (grid) is one JSON document (`NetworkDocument`) holding every
record of the grid: sites, yards, buses, bays, equipment, take-offs, junctions,
circuits, lines and connections. Records are flat and reference each other by
id; every id is unique within the document. A loader (future) turns records
into the `src/models` classes; the map editor and the substation editor edit
them through journaled operations (section 6.6).

### 6.1 Document

```ts
interface NetworkDocument {
  format: 'thgrid.network'; version: 1
  id: string                 // file name: data/networks/<id>.json (TEMPLATE_ID_PATTERN)
  name: string; description?: string
  revision: number           // +1 on every save / rollback / overwrite-import
  createdAt: string; updatedAt: string
  substationGroups: SubstationGroupRecord[]
  substations:      SubstationRecord[]
  buses:            SubstationBusRecord[]
  bays:             SubstationBayRecord[]
  equipments:       SubstationEquipmentRecord[]
  takeOffs:         SubstationTakeOffRecord[]
  junctions:        TransmissionJunctionRecord[]
  paths:            TransmissionPathRecord[]
  circuits:         TransmissionCircuitRecord[]
  lines:            TransmissionLineRecord[]
  connections:      ConnectionRecord[]
  yardConnections:  SubstationYardConnectionRecord[]   // yard links (added on read when missing)
}
```

`NetworkCollectionName` is the union of the eleven array keys; `networkCollectionNames`
lists them. `NetworkSummary` (for listings) carries id, name, revision,
`counts` per collection and the number of unsaved journal entries.

### 6.2 Records

All records extend `NetworkRecordBase { id, name?, planned?, coords? }`
(`planned: true` marks something not built yet: sites, yards, take-offs,
circuits, lines and connections expose it in the editors; the map draws them
in grey or a dull voltage colour, planned circuits dotted, and the
single-line diagram in grey; see *Planned* below). Record ids match
`^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$` (`NETWORK_ID_PATTERN`); when the user
leaves an id empty the UI derives it from the related records with the
static naming of the model classes (section 2.2, `src/network/naming.ts`:
`SSY_CNO_230KV`, `SBA_CNO_230KV_8041`, `TCC_230KV_CNO_CTI_S1`, …) and makes
it unique via `uniqueId()`.

| Record | Mirrors | Required fields | Optional fields |
|---|---|---|---|
| `SubstationGroupRecord` | `SubstationGroup` | `groupName`, `coords` | `name`, `generation` (the site is a power plant / producer), `generationTypes[]` (`GenerationType`, unique; meaningful when `generation` is set), `extensionOf` (id of the site it extends, e.g. a plant switchyard next to a substation; one level deep: the parent is no extension itself; renaming the parent follows, deleting it leaves the extensions as sites of their own; helpers in `src/network/extensions.ts`) |
| `SubstationRecord` (yard) | `Substation` | `groupId`, `yardName`, `voltage` | `arrangement`, `coords` |
| `SubstationBusRecord` | `SubstationBus` | `substationId`, `busType`, `row` | `busNumber`, `bayNumber`, `voltage`, `current` |
| `SubstationBayRecord` | `SubstationBay` | `substationId`, `bayNumber`, `column` | `voltage`, `current` |
| `SubstationEquipmentRecord` | `SubstationEquipment` + subclasses | `substationId`, `bayId`, `code`, `equipmentType`, `terminals[]`, `row` | `brand`, `model`, `template` (POWER_TRANSFORMER ref), `attributes`, `takeOffId` (drawn in that take-off's take-off column, right of the bay column, at its `row`), `lineSide` / `busTie` (purpose tags, from bay templates; drawn as ↑ / ⇔ after the code; line-side equipment is drawn in the bay's line (take-off) column even without `takeOffId`; a power transformer belongs there like a take-off and gets a warning while unflagged, as does one wired to equipment that is not line side or to a bus; files written before migration v5 carry `takeOff`) |
| `SubstationTakeOffRecord` | `SubstationTakeOff` | `substationId`, `lineName` | `bayId`, `row`, `takeOffColumn` (drawn in the bay's take-off column; unset = bay column, with a warning), `voltage` (set when the line leaves at another voltage than the yard's, e.g. the secondary or auxiliary side of a transformer in the yard: it colours the take-off, is the voltage of the node a circuit is energized at when attached (`connectionVoltage`), prefixes the rule line name, and is what a transformer winding wired to it is expected to have) |
| `TransmissionJunctionRecord` | `TransmissionJunction` | `coords` | `name`, `groupId` (set on a *site junction*: the one junction a substation site may own, named after the site by default and moving with it; circuits are joined or teed there without entering a yard, and a connection there counts as being at the site for path ends) |
| `TransmissionPathRecord` | `TransmissionPath` | `name`, `waypoints[]` | `from`, `to` (`ConnectionJunctionRef` of kind SUBSTATION_GROUP or TRANSMISSION_JUNCTION: the site or junction where the route starts / ends; a route is not specific to a voltage, so circuits of any yard of the site may share it) |
| `TransmissionCircuitRecord` | `TransmissionCircuit` | `name`, `pathId` | `voltage` (rated), `energizedVoltage` (operated at; set from the connection when an end is attached), `bundle`, `conductor` (`{ size, unit, type, code? }`, copied from the conductor template), `current`, `lengthKm`, `lineGroup` / `groupCircuit` (tower position, a drawing hint: the line group is one tower line, several running side by side with 1 on the left, and the circuit's number on it, 1 / 2 on the top pair of arms, left / right looking from the path's FROM end, 3 / 4 on the pair below, and so on; unset = assigned when drawn, two per new tower, see `web/src/network/towerLayout.ts`; a position taken twice on one path warns) (no template reference is stored; `conductorTemplateId` is a deprecated leftover of older documents) |
| `TransmissionLineRecord` | `TransmissionLine` | `name`, `circuitIds[]` (sections, FROM → TO) | `voltage`, `from`, `to` (`ConnectionJunctionRef` of kind SUBSTATION: the yards the line runs between) |
| `ConnectionRecord` | `TransmissionConnection` + in-yard wiring (`voltage` of the node when not the yard's, `current` limit in A; see 6.5) | `scope`, `junction`, `nodes[]`; `name` when located at a junction | `voltage` (nominal voltage of the node, informational: it does not restrict connected circuits) |
| `SubstationYardConnectionRecord` | yard link | `name`, `yardAId`, `yardBId` (two different yards), `nodes[]` (buses, equipment terminals and take-offs of either yard; a node in at most one link) | `voltage` (informational) |

Changes versus the runtime classes, made so the records can be edited
graphically:

* **Site vs yard** – `SubstationGroup` is the site drawn on the map (it owns
  the coordinates); `Substation` is a voltage yard of the site.
* **Layout integers** – bus `row`, bay `column`, equipment `row` and take-off
  `row` (named `row` in files written before migration v4) position items on the single-line diagram (section 6.4), plus the
  optional equipment `takeOffId` and take-off `takeOffColumn` flags that
  move them into a bay's take-off column. They are the only layout data stored.
* **Terminals** – equipment exposes `terminals[]` instead of the typed
  `circuitA/circuitB/circuit/windings` fields (section 6.3).
* **Take-off without bay** – `bayId` is optional so a take-off can be created
  from the map before the yard is detailed; the yard editor shows it in an
  extra column until it is assigned.
* **Circuit copies template values** – `voltage` and `bundle` come from the
  circuit template and the conductor's `size`, `unit`, `type` and `code` are
  copied from the referenced TRANSMISSION_CONDUCTOR template into
  `conductor`, so the document is self-describing and a circuit never points
  at a template of either kind (older documents' `template` reference is
  dropped on load). The values stay editable in the circuit panel and both
  wizards; *Apply template…* in the circuit panel replaces them from another
  circuit template, and the conductor block's *From conductor template…*
  button reveals a picker that re-fills the conductor fields from any
  conductor template (no dropdown is shown until asked).
* **Rated vs energized voltage** – `voltage` is the design voltage of the
  circuit (from the template); `energizedVoltage` is the voltage it is
  operated at. Whenever a circuit end is attached (creation, *Attach*, moving
  an end into another node) the editor sets `energizedVoltage` to the voltage
  of the connection it joins: the node's `voltage` at a junction, the yard
  voltage at a substation (a new take-off connection is created with the
  yard voltage). It stays editable; the circuit panel and the lists flag a
  circuit whose energized voltage differs from a connection at either end.
  Documents written before this field existed get it filled from the first
  connected end on load (`migrateNetworkDocument`). On the map a circuit is
  drawn in the colour of its energized voltage, with a dotted overlay in the
  rated colour when the two differ (e.g. a 230 kV line operated at 115 kV).
* **Planned** – `planned: true` on a site, yard, take-off, circuit, line or
  connection means "not built yet". A planned record used by one that is not
  planned is reported by `validateNetworkDocument` as an issue with
  `severity: 'warning'`: a built yard in a planned site, a built take-off in a
  planned yard, a built connection at a planned yard or holding a planned
  take-off or circuit end, a built circuit joined in a planned connection, a
  built line with a planned section or a planned end yard. Warnings are shown
  in the editors but never block a save (the backend blocks only on issues
  without `severity: 'warning'`); the "New line" wizard can create a whole
  line as planned.
* **Transmission path** – a circuit may reference one
  `TransmissionPathRecord` (`pathId`, optional: paths and circuits are added
  independently, a path with the map's *+ Path* tool); the path holds the name, where it
  starts and ends (`from` / `to`, a *site* or a junction: a route is not
  specific to a voltage, so circuits of different yards of the site, e.g. a
  115 kV and a 230 kV line on the same towers, may share it) and the map
  waypoints (FROM → TO), and may be shared by parallel circuits on the same
  towers. Circuits attach at the path ends (through a take-off at a yard of
  the site, a node at a junction); a circuit end connected anywhere else is a
  validation issue (`atPathEnd` in `src/network/refs.ts` does the yard-to-site
  comparison). Deleting a path keeps its circuits, without a path; deleting a
  site or junction clears the path ends that pointed at it. A path without
  circuits is drawn as a dashed grey route (a dashed ring when it has a single
  point). A circuit without a path is drawn as a dashed straight line between
  its attached ends; attached at one end only (or none) it cannot be drawn, so
  `validateNetworkDocument` gives a warning and the map marks the attached end
  with a ⚠. Older documents whose path ends named yards
  are lifted to the yard's site by `migrateNetworkDocument`.
* **Line** – a named group of circuit sections joined end to end through
  TRANSMISSION connections, from one yard to another: `circuitIds` lists the
  sections FROM → TO, `from` / `to` name the yards. The circuits form a graph
  (nodes = transmission connections, edges = circuits; `src/network/lines.ts`):
  a line is a walk through it that passes junction nodes and stops at yards.
  A circuit may be a section of several lines (a *tie*: two lines that leave
  the same yard and part at a tee share the section up to the tee). The
  circuit panel detects when a circuit is joined substation to substation
  (`proposalsForCircuit`) and offers to group the chain into a line; the line
  panel reports sections that are not joined or do not reach the stated
  ends (`lineStatus`). Deleting a circuit removes it from its lines; deleting
  a line keeps its circuits. A line exists only while it has at least one
  circuit: deleting its last circuit removes it (`cascadeDeleteOps`), and the
  editor removes any line an edit leaves without circuits (`emptyLinesOps`),
  warning first. Documents written with the old `circuit.lineId`
  are migrated into `circuitIds` on load.

### 6.3 Equipment terminals

```ts
interface EquipmentTerminalRecord { key: string; label?: string; voltage?: TransmissionVoltage; current?: number }
```

`defaultTerminals(type)` mirrors the runtime classes:

| Equipment | Terminal keys |
|---|---|
| Circuit breaker, MTS breaker, disconnecting switch, power fuse, shunt reactor, current transformer (in series) | `A`, `B` |
| PT, ground switch, surge arrester, SVC | `T` |

A current transformer saved by an older version with a single terminal is
migrated on read: that terminal becomes `A` (connections follow) and `B` is
added.
| Power / service transformer | one per winding, derived from `windings` (`terminalsFromWindings`: key = winding code, label = side, voltage = winding voltage); a new transformer starts with `H` (PRIMARY, star, on-load tap changer, the yard voltage) and `X` (SECONDARY, one level down), `defaultTransformerWindings`; applying a power-transformer template copies its windings and stores `modules` in `attributes` |

Transformer records carry `windings: { [code]: TransformerWindingRecord }`,
the same shape as a template winding (`windingSide`, `wiring`,
`tapChanger`, `voltage`, `ratings[]` per cooling mode), validated like a
template's (one PRIMARY, keys `^[A-Za-z0-9_-]{1,16}$`); the terminals must
be one per winding. Older records get their windings derived from the
terminals on read (migration v6: side from the terminal label or position,
star wiring, on-load tap changer on the primary, the terminal voltage or
else the yard voltage for the primary, one level down for the secondary and
22 kV for an auxiliary, no ratings).

### 6.4 Single-line layout

Horizontal axis = bay `column`; vertical axis = one shared integer index used
by bus `row`, equipment `row` and take-off `row`, counted from the bottom
(a bus at row 0 is the lowest line, equipment at rows 1…n sit above it; a
second bus can sit at row 6 above them, as in a breaker-and-a-half
arrangement). Every bay has a narrower *take-off column* to the right of
its main column: a take-off with `takeOffColumn` is drawn there (one
without it sits in the bay column and gets a validation warning), and
equipment with `takeOffId` is drawn there too, at its own `row` on the
same rows as the bay column (nothing is stacked automatically). A take-off
is a vertical arrow whose terminal is the end opposite the head; the arrow
points up unless the yard wiring reaches it from a bus or equipment at a
higher row, then it points down. The wires between the bay column,
the equipment in the take-off column and the take-off are ordinary
connections drawn as an L: horizontal from the bay-column side (or from the
take-off's terminal) first, then vertical to the other node; wires between
different bays are a Z through the mid height. The take-off must belong to the same yard; deleting it
puts the equipment back into the bay column. A yard link (`yardConnections`) appears in both yards' diagrams
as a *port*: an arrow whose tip is a box in the other yard's voltage colour
naming that site, yard and the link, placed in an extra row at the top when
the other yard's voltage is higher and at the bottom otherwise, in the
column of the link's first node of this yard; only this yard's nodes are
wired to it, like a connection. bay column. A ground switch is drawn as an L from its single
terminal on the bay column, along the row to the right, then the switch and
the earth always pointing down. Terminals are drawn above/below the symbol
(index 0 top, 1 bottom, 2 right, 3 left). Nothing else is stored; pixel
positions are computed by `web/src/network/geometry.ts`.

### 6.5 Connectivity

```ts
enum NetworkNodeKind { SUBSTATION_BUS, EQUIPMENT_TERMINAL, SUBSTATION_TAKE_OFF, TRANSMISSION_CIRCUIT }
interface NetworkNodeRef { kind: NetworkNodeKind; id: string; terminal?: string }
//   EQUIPMENT_TERMINAL   → id = equipment id, terminal = terminal key
//   TRANSMISSION_CIRCUIT → id = circuit id,   terminal = 'FROM' | 'TO'

enum ConnectionScope { SUBSTATION, TRANSMISSION }
interface ConnectionRecord extends NetworkRecordBase {
  scope: ConnectionScope
  junction: { kind: 'SUBSTATION' | 'TRANSMISSION_JUNCTION'; id: string }   // yard id or junction id (SUBSTATION_GROUP is for path ends only)
  nodes: NetworkNodeRef[]
  voltage?: TransmissionVoltage   // nominal voltage of the node; NOT a constraint on the circuits
}
```

A connection is one electrical node. Rules (enforced by
`validateNetworkDocument`, shown in both editors, and blocking a save unless
forced):

| Scope / location | Allowed nodes | Rule |
|---|---|---|
| `SUBSTATION` at a yard | buses, equipment terminals, take-offs **of that yard** | ≥ 2 nodes, no circuit ends |
| `TRANSMISSION` at a yard | exactly **one take-off** of that yard + ≥ 1 circuit end | a line always leaves a substation through a take-off |
| `TRANSMISSION` at a junction | ≥ 1 circuit end, nothing else | several circuit ends in one connection are spliced / teed; separate connections at the same junction are isolated. A node is never added on its own: it is formed by circuit ends (a new circuit attached there, or several ends checked in the junction panel and *Connect checked*), and `cascadeDeleteOps` / detaching remove it when its last circuit end goes |
| any | – | each terminal, take-off and circuit end is used by at most one connection per scope; buses may be in many |

The take-off is therefore the boundary between the two editors: inside the
yard it is wired like any node (SUBSTATION scope), on the map it is the start
of a circuit (TRANSMISSION scope). `SubstationTakeOff.circuit` of the runtime
model corresponds to the TRANSMISSION connection holding the take-off.

### 6.6 Operations and journal (`ops.ts`)

Editing is expressed as operations that are applied locally and appended to
a server-side journal until the user saves a version:

```ts
type NetworkOp =
  | { type: 'upsert'; collection: NetworkCollectionName; record }   // insert or replace by id
  | { type: 'delete'; collection: NetworkCollectionName; id }        // fails if missing
  | { type: 'meta'; name?; description? }

interface JournalEntry { seq: number; at: string; op: NetworkOp }
interface NetworkJournal { networkId; baseRevision; entries: JournalEntry[] }
```

Helpers: `applyOp` / `applyOps` (pure, throw `NetworkOpError` when an op cannot
apply), `renameRecordOps(doc, collection, oldId, newId)` (re-inserts the record
under a new, network-unique id and rewrites every reference: parent ids, path
and line ids, path ends, connection junctions and nodes; `checkNewId` gives the
reason a new id is refused), `cascadeDeleteOps(doc, collection, id)` (deletes a record with its
dependants and prunes it from connections, dropping connections left with
fewer than two nodes; deleting a bay keeps its take-offs but clears their
`bayId`), `uniqueId(doc, prefix)`, `connectionsOfNode`, `findRecord`.
Undo/redo in the UI is implemented with inverse ops, so undos are journaled
too.

### 6.7 Validation (`validation.ts`)

* `validateNetworkRecordShape(collection, record)` – per-record field rules
  (used for journal ops and documents).
* `validateNetworkDocument(doc)` – format/version/name, shapes, id uniqueness,
  references (`groupId`, `substationId`, `bayId`, `lineId`, node refs, same
  yard checks), and the connection rules of section 6.5.
* `validateNetworkOps(ops)` – shape of a journal batch.

### 6.8 Migrations (`migrate.ts`)

`migrateNetworkDocument(doc)` upgrades documents written by earlier versions
and runs on every read, replay, import and validate, so old files keep working
and are upgraded on their next save. Current migrations:

* junction connections without a `name` get `<junction name>_<n>`
  (`nextJunctionConnectionName`), numbered in document order.
* documents without a `paths` collection get an empty one; circuits with the
  legacy `path[]` waypoints get a path of their own named `<circuit name> path`,
  taking over the waypoints (a circuit without `pathId` is otherwise fine).
* paths without `from` / `to` take the ends from the first circuit on them that
  is connected there.
* equipment and take-off `slot` → `row` (one vertical axis shared with
  buses).
* v5: the equipment flag `takeOff` → `lineSide` (bay template files are
  normalised the same way on read).
* v6: transformer equipment without `windings` gets them derived from its
  terminals.

### 6.9 Storage and versions

```
data/networks/<id>.json                       current version
data/networks/history/<id>.<stamp>.json       archived versions, stamp = archival time YYYYMMDDTHHMMSSmmmZ
data/networks/journal/<id>.json               unsaved ops ({ id, networkId, baseRevision, entries[] })
```

The current file is copied to `history/` before every overwrite (save,
rollback, overwrite-import, delete), so any earlier state can be restored.
Journals are working files and are excluded from git.

---

## 7. Adding a new template kind (checklist)

1. Add the payload interface under `src/templates/<name>.ts` (persisted shape;
   reference other templates by id).
2. Add a member to `TemplateKind` and a row in `TemplateDataByKind`
   (`template.ts`).
3. Write `validate<Name>Template` in `validation.ts` and add it to
   `validateTemplateData`.
4. Register the kind in `registry.ts` (label, directory, validator,
   `references`), and add it to `templateKindOrder`.
5. If the persisted shape differs from the factory input, add a resolver in
   `resolve.ts` and extend `ResolvedTemplateByKind`.
6. Add a form component in the web UI (see frontend.md § 7) and a default
   payload in `TemplateEditor.defaultData`.
7. Extend `scripts/smoke.ts` with a create/validate case.
