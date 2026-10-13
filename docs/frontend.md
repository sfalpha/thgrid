# thgrid – Frontend specification

The web UI is a single-page application for creating and editing templates
and collections. It runs locally against the backend described in
[backend.md](backend.md) and edits the shapes described in
[models.md](models.md).

---

## 1. Stack and layout

| Item | Choice |
|---|---|
| Framework | React 19, TypeScript (strict) |
| Build / dev server | Vite 8 (`web/vite.config.mts`) |
| Routing | hash router (no dependency), `#/templates/...` |
| Styling | one hand-written stylesheet, CSS variables, automatic light/dark via `prefers-color-scheme` |
| Map | Leaflet 1.9 with OpenStreetMap tiles |
| State | React hooks only (`useAsync`, local component state) |
| Shared code | imports `src/templates` and `src/models` directly through the `@shared/*` alias |

```
web/
  index.html
  vite.config.mts           root = web/, alias @shared → ../src, proxy /api → :3300
  tsconfig.json             browser tsconfig; also type-checks ../src/templates|models|network
  src/
    main.tsx                mount
    App.tsx                 top bar, section switch, meta loading
    styles.css
    api/client.ts           typed fetch wrapper (ApiError with issues), downloadJson()
    hooks/useHashRoute.ts   route segments + navigate(); hrefTo()
    hooks/useAsync.ts       data/error/loading/reload for a promise
    hooks/useTemplates.ts   template summaries of one kind (pickers)
    hooks/useSideWidth.ts   width of the editors' side panel (drag handle, remembered in localStorage)
    components/
      fields.tsx            TextField, NumberField, SelectField, CheckboxField, TagsField, TextAreaField, issueFor()
      IssueList.tsx         IssueList (validation issues), Notice (ok / warn / error)
      JsonEditor.tsx        raw JSON textarea that only emits when the text parses
      TemplateEditor.tsx    envelope + kind dispatch + save / delete / usage
      editors/
        ConductorForm.tsx           TRANSMISSION_CONDUCTOR (also exports EditorProps<D>)
        CircuitForm.tsx             TRANSMISSION_CIRCUIT (conductor picker)
        PowerTransformerForm.tsx    POWER_TRANSFORMER (windings + ratings)
    pages/
      TemplatesPage.tsx     kind sidebar, template list, editor
      CollectionsPage.tsx   collection list, editor, import / export
    network/                network editors (section 9)
```

### Running

```bash
npm run dev        # backend :3300 + Vite :5173 (open http://localhost:5173)
npm run dev:host   # same, Vite on every interface (`--host ::`, IPv4 + IPv6) in mode `host`: any Host name is accepted (`server.allowedHosts: true`), e.g. a LAN name or a Cloudflare tunnel; /api is proxied to the local backend
npm run dev:web    # Vite only (expects a backend on :3300, override with THGRID_API_URL)
npm run build      # web/dist, then `npm start` serves it from the backend on :3300
```

---

## 2. Routes

| Hash | Page | Content |
|---|---|---|
| `#/` or `#/templates` | Templates | first kind selected, overview table |
| `#/templates/:kind` | Templates | overview table of that kind |
| `#/templates/:kind/new` | Templates | create form |
| `#/templates/:kind/:id` | Templates | edit form + "Used by" panel |
| `#/collections` | Collections | cards overview |
| `#/collections/new` | Collections | create form |
| `#/collections/:id` | Collections | edit form |
| `#/network…` | Networks | list and the two network editors (section 9) |

`useHashRoute` returns the decoded segments; pages pick what they need. Links
are plain `<a href={hrefTo(path)}>` so they work with middle-click and the
browser history.

---

## 3. App shell (`App.tsx`)

* Loads `GET /api/meta` once. Until it arrives a loading state is shown; if it
  fails an error notice explains how to start the backend.
* Everything below receives `meta` (kinds, enums, patterns) as a prop so
  forms never hard-code enum values.
* Top bar: brand, section links (Templates, Collections, Networks), backend
  version.

---

## 4. Templates page

Layout: left sidebar, right main pane (`.workspace` grid, collapses to one
column under 800 px).

**Sidebar**
* Kind list from `meta.kinds` with counts from one `GET /api/templates` call.
* For the selected kind: filter box (matches name, id, tags), item list,
  "+ New" button.

**Main pane**
* No selection: description of the kind, its storage directory and a table of
  all templates (name, id, tags, updated).
* `new` or an id: `TemplateEditor`.

### 4.1 TemplateEditor

Props: `kind`, `id?` (undefined = create), `meta`, `onSaved(record)`,
`onDeleted()`. The page keys the component by `kind+id` so switching
templates remounts it with fresh state.

Data loading (via `useAsync`):
* record (`GET /api/templates/:kind/:id`) unless creating,
* usage (`…/usage`) unless creating,
* conductor summaries when the kind is `TRANSMISSION_CIRCUIT` (for the picker).

State: `data` (payload), `description`, `tags`, `customId` (create only),
`dirty`, `showJson`, `serverIssues`, `message`, `deleteBlocked`.

Behaviour:
* **Id**: on create the id field shows `slugifyTemplateId(name)` live and can
  be overridden; it must match the shared `TEMPLATE_ID_PATTERN`. On edit the
  id is read-only.
* **Live validation**: `validateTemplateData(kind, data, ctx)` from
  `src/templates/validation.ts` runs on every change; `ctx.exists` checks the
  loaded conductor list. Issues are listed at the top and attached to the
  matching field (`issueFor(issues, path)`). The Save button is disabled while
  client issues exist.
* **Server issues**: a 422 replaces the client issues (paths with the `data.`
  prefix stripped) until the next edit.
* **Form / JSON view**: the JSON view edits the raw payload; the text is only
  pushed to state when it parses, so partial edits never break the form. The
  form view re-reads state, so the two stay in sync.
* **Save**: `POST` (create) or `PUT` (edit) with `{ description, tags, data }`;
  success shows a notice, clears `dirty`, calls `onSaved` (the page reloads
  the list and, after a create, navigates to the new id).
* **Delete**: confirm dialog, `DELETE`. A 409 shows the usage (dependent
  templates and collections) with a "Delete anyway" button that retries with
  `?force=true`.
* **Download**: saves the stored record as `<id>.json`.
* **Used by** panel: links to dependent templates and collections.

### 4.2 Editor forms

All forms share `EditorProps<D> = { data, onChange, issues, meta }` and are
fully controlled: every change calls `onChange` with a new object.

| Form | Fields |
|---|---|
| `ConductorForm` | name, code, size, unit (select), wire type (select) |
| `CircuitForm` | name, voltage (optional select), bundle, conductor (select from conductor templates, with a link to open it) |
| `PowerTransformerForm` | name, modules; one `WindingEditor` block per winding key (renameable key, side, wiring, voltage, tap changer, ratings table with cooling / power kVA / per-module, add/remove rating, remove winding); add-winding row with key validation (`WINDING_KEY_PATTERN`, unique) |
| `YardTemplateForm` | name, arrangement (select), voltage (optional); bus table (name, type, number, row; add/remove; the name follows type and number while it is the rule name) |
| `BayTemplateForm` | name, bay type (select, labelled); suitable arrangements (checkboxes); equipment table (sequence, type, line-side / bus-tie flags; add, remove, sort) |

New transformers start with windings `H` (PRIMARY, 230 kV, ONLOAD) and `X`
(SECONDARY, 115 kV); new windings default to PRIMARY / SECONDARY / AUXILIARY by position.

---

## 5. Collections page

**Sidebar**: collection list with item counts, "+ New", "Import bundle…"
(hidden file input).

**Main pane**
* No selection: explanation plus cards for each collection.
* `CollectionEditor` (keyed by id): name, id (derived / read-only), description,
  tags; items table (kind badge, template name linked to its editor or
  "(missing)" in red, editable note, remove); add row with kind select,
  template select (only templates not yet included) and "Add" / "Add all".
* Live validation with `validateCollectionInput` against the loaded template
  list; server 422 issues are shown as returned.
* **Export bundle**: `GET /api/collections/:id/export` and download as
  `<id>.thgrid-bundle.json`.
* **Import bundle**: parse the chosen file, `POST /api/collections/import`;
  on 409 ask whether to overwrite and retry with `?overwrite=true`; report
  created / overwritten counts and navigate to the collection.
* **Delete**: confirm, `DELETE`, back to the overview (templates are kept).

---

## 6. API client (`api/client.ts`)

`api.meta()`, `api.templates.{list,get,create,update,validate,delete,usage,resolved}`,
`api.collections.{list,get,create,update,validate,delete,export,import}`,
`api.networks.{list,create,get,delete,working,journal,append,discard,save,export,import,versions,version,rollback,purgeVersions}`.

Non-2xx responses throw `ApiError { status, code, message, issues, details }`
so components can branch on `status === 409` or render `issues`. All
request/response types are imported from the shared source tree
(`@shared/templates/*`, `@shared/server/routes/meta`,
`@shared/server/services/*`) so a backend change surfaces as a type error in
the UI.

---

## 7. Adding an editor for a new template kind

1. Do the shared-code steps in models.md § 7 (kind, payload, validator,
   registry). The sidebar, list, meta, validation and JSON view then work
   without UI changes.
2. Add `components/editors/<Name>Form.tsx` implementing `EditorProps<D>`,
   using the field components and `issueFor` for per-field errors. Need extra
   data (e.g. templates of another kind to reference)? Load it in
   `TemplateEditor` with `useAsync` and pass it down, as done for conductors.
3. In `TemplateEditor.tsx`: add a default payload in `defaultData(kind)` and a
   branch in the form dispatch.
4. If the meta endpoint needs new enums, add them to `buildMeta` in
   `src/server/routes/meta.ts`; `MetaResponse` is shared so the form sees them
   typed.

---

## 8. Styling

* `styles.css` defines colour tokens on `:root` and overrides them under
  `@media (prefers-color-scheme: dark)`; components use classes only, no
  inline colours except through tokens.
* Layout primitives: `.app` (top bar + content), `.workspace` (sidebar +
  main), `.editor-layout` (canvas, drag handle, resizable side panel whose
  width is the `--side-w` variable), `.panel`, `.form-grid` (auto-fill columns, `.span-2`, `.span-all`),
  `.winding`, tables, `.notice`, `.issues`, `.badge`, `.tag`, `.cards`.
* Minimum supported width is a phone-sized viewport; the sidebar stacks above
  the content.

---

## 9. Network editors

```
web/src/network/
  NetworkContext.tsx    editing session: working document, journal sync, undo/redo, save/discard, selection
  NetworksPage.tsx      #/network – list, create, import, delete
  NetworkShell.tsx      toolbar (save / discard / undo / redo / export / versions / issues) + tabs, routes the two editors
  MapEditor.tsx         Leaflet + OpenStreetMap editor of sites, junctions and circuits
  MapPanels.tsx         side panels of the map (site, junction, circuit, connection, circuit wizard, overview)
  mapUtil.ts            Leaflet-free helpers (endLocation, locationOfRef, voltageColor, haversineKm, draft types)
  linkOps.ts            attach / detach ops for circuit ends and path ends, status helpers
  FindPanel.tsx         search over sites, yards, junctions, paths, circuits, lines with attention markers; also the per-type lists of the overview tabs
  IdEditor.tsx          inline id rename (unique in the network, references rewritten)
  SubstationsPage.tsx   #/network/:id/substations – yards of every site, add yard
  SubstationEditor.tsx  SVG single-line diagram editor of one yard
  SubstationPanels.tsx  side panels of the yard editor (yard, bus, bay, equipment, take-off, connection)
  geometry.ts           layout of the single-line diagram (columns, rows, terminals, wire paths)
  symbols.tsx           SVG equipment symbols
  VersionsPanel.tsx     archived versions: download, roll back, purge (all or all but the newest N)
```

### 9.1 Routes

| Hash | Content |
|---|---|
| `#/network` | networks list, create, import JSON |
| `#/network/:id` or `#/network/:id/map` | map editor |
| `#/network/:id/substations` | yards list |
| `#/network/:id/substation/:yardId` | substation (single-line) editor |

### 9.2 Editing session (`NetworkContext`)

`NetworkProvider` loads `GET /api/networks/:id/working` and exposes
`useNetworkEditor()`:

* `doc` – the working document; `dirty`, `journal.entries`, `savedRevision`.
* `apply(ops)` – applies the ops locally (optimistic, via the shared
  `applyOps`) and appends them to the server journal with `expectedLastSeq`.
  Appends are queued so they stay ordered; a failure sets `syncError` and the
  shell offers *Reload* / *Discard journal*.
* `undo()` / `redo()` – inverse ops computed against the current document
  (`upsert` ↔ previous record or `delete`); they are journaled like any edit.
* `save(force)` – `POST …/save`; the shell asks before forcing when the
  working document has validation issues. `discard()` drops the journal and
  reloads. `exportJson()` downloads the working document.
* `issues` – `validateNetworkDocument(doc)` recomputed on every change; the
  count is shown in the toolbar and the list in a panel.
* `selection` – `{ collection, id }` shared by canvas and side panel.

Every record form in the panels keeps a local draft and writes **one upsert
op on Apply**, so the journal records meaningful steps rather than
keystrokes. Marker drags and canvas actions (add, connect, delete) apply
immediately.

### 9.3 Map editor

* Tiles: `https://tile.openstreetmap.org/{z}/{x}/{y}.png` with the required
  attribution; markers are Leaflet `divIcon`s (no image assets).
* Planned records (`planned: true`, a checkbox in the site, yard, take-off,
  circuit, line and connection panels and in the "New line" wizard) look
  unbuilt: a planned site marker is grey and dashed; the yard symbol of a
  planned yard (or of a yard in a planned site), on the map and in the lists,
  keeps its shape and voltage colour but dulled (`plannedVoltageColor` in
  `mapUtil.ts`: the voltage colour mixed 55 / 45 with `PLANNED_COLOR`), its
  name in the detailed map label muted and italic; a planned circuit (the line
  wizard marks a planned line's circuits planned too) is a dotted line of round
  dots in the same dull voltage colour, which also hides the loose-end dashes
  and the energized-voltage overlay; in the substation editor a planned yard's
  whole diagram, or a planned take-off, is grey (`PLANNED_COLOR`). Validation warnings about planned records used by built
  ones appear with a ⚠ in the issues list and in the toolbar counter, and do
  not block saving.
* Ordering: every dropdown of sites, yards or junctions in the panels is
  sorted alphabetically (sites by code, yards by name, junctions by name).
  Template pickers (`useTemplates`) are the exception: they follow the order
  of the collections, as returned by the API, so the EGAT standard set runs
  from the smaller conductors to the larger ones; templates that belong to no
  collection follow alphabetically.
* Initial view: the centre and zoom the network was last shown at are
  remembered per network in `localStorage` (`thgrid.mapView.<network id>`,
  written on every `moveend`) and restored when the map view is opened
  again, e.g. after a visit to the substation editor or a reload. Without a
  remembered view the first draw zooms just enough to cover the sites
  (`fitBounds` over the `substationGroups` only, with 48 px of padding,
  after an `invalidateSize` since the container has no reliable size on the
  first draw; a lone site is centred at zoom 12; junctions, routes and
  waypoints never widen the fit); a network without sites opens on
  Thailand. The toolbar's *Fit* button runs the same fit again.
* Sites (`substationGroups`) are plain blue circle markers labelled with the group code
  followed, on the same line, by one voltage symbol per yard, highest
  voltage first, without text. *Site details* in the **Map features**
  panel (see below) switches the labels to the code, the
  site name (when it differs from the code) and one line per yard, highest
  voltage first: its symbol, its name and, when the name does not say it,
  its voltage. The symbol (`voltageSymbolShape` in
  `mapUtil.ts`; `VoltageSymbol` in `symbols.tsx` draws the same shapes in
  the panels) is filled with the colour of the circuit lines of that voltage
  (same EGAT scheme) and its shape gives the voltage too: ▼ 69 kV, ▲ 115 kV,
  ■ 230 kV, a hexagon for 500 kV and a solid circle for any other voltage.
  The same symbols mark yards in the *Sites* and *Yards* lists, the site
  panel's yards, the site popup and the legend. Junction labels keep one
  badge per node;
  hovering opens a popup with one row per yard (voltage, arrangement, number
  of buses, bays and take-offs) and the site's size class. A generation
  site (`generation` set in the site panel, with checkboxes for its
  `generationTypes`) carries a green **G** badge the size of a yard symbol
  on the line of its code, after the yard symbols; with *Details* on, one
  lettered badge per generation type follows it (H hydro, S solar, B BESS,
  W wind, GT gas turbine, CC combined cycle, T thermal, GE geothermal;
  colours in `GENERATION_BADGES`). Everything on that line (code, symbols,
  badges, "(planned)") is centred on one line. The popup names the types,
  and the *Sites* list shows the G and type badges at the same size. Sites are sized
  by what is inside them (`siteSize` in `mapUtil.ts`: more than 6 / 12 / 24
  take-offs or more than 4 / 8 / 16 bays make a site medium / large /
  x-large, else small) and the marker grows with the class: 14 / 18 / 24 / 30 px
  at full detail (`SITE_MARKER_PX`, zoom 11 and in), scaled down when zoomed
  out (`mapDetailScale` in `mapUtil.ts`: 35 % at the country view, zoom 6,
  growing linearly to 100 % at zoom 11; at least 6 px, a thinner rim below
  12 px). Whatever the zoom, a site is drawn at least wide enough to cover the
  ends of the parallel lanes running into it (outermost lane offset plus half
  the line weight, plus the white rim).
  When two sites are drawn within 48 px of each other at the current zoom,
  the smaller one (by class, then by take-offs + bays) loses its permanent
  label, which still appears while hovering; a selected site or one being
  picked as a circuit end always keeps its label. Recomputed on every zoom.
  A site extension (`extensionOf`) whose marker would lie within 24 px of
  its parent's (`EXTENSION_GROUP_PX`, i.e. zoomed out) is drawn grouped with
  it (`groupedView` in `MapEditor.tsx`): it and its site junction take the
  parent's position, so its other circuits and paths run to the parent; its
  own marker is left out; circuits and paths between grouped sites of one
  group are left out; the parent's label lists each grouped extension on a
  line of its own (code, yard symbols, generation icons, the name with *Site
  details*), and selecting or picking an extension highlights the parent's
  marker. The hover popup names the parent of an extension and the
  extensions of a parent. A line junction is grouped into a site the same
  way when its circle would come within 4 px of the marker of a site it is
  linked to by a path without waypoints (`JUNCTION_SITE_GAP_PX`; the circle's
  radius estimated as the width of the widest bundle running in, the marker
  by its size class at that zoom), e.g. BKI_JT1 1.4 km from BKI: it takes
  the site's position, its lines run into the site's marker, which grows to
  cover them, and its circle, connectors and the path to the site are left
  out; zoomed in further it is drawn on its own again. Junctions (other than a site's own
  junction) are a see-through blue area drawn behind the lines (a Leaflet
  pane `junctionAreas`, z-index 390, under the overlay pane; `JUNCTION_COLOR`
  in `mapUtil.ts`): a circle whose diameter is twice the width of the widest
  bundle of parallel lanes running in (outer edge to outer edge, so its
  radius equals that width; at least 8 px at full detail, scaled down when zoomed out like the sites). The lanes stop on the circle
  (`trimStartAtCircle` in `MapEditor.tsx`). The hover
  summary still names a size tier, the same four tiers as sites, classed by
  the path ending there that carries the most circuits (`junctionSize`, more
  than 2 / 4 / 6 circuits make it medium / large / x-large, else small).
  Where a lane meets the area's edge is
  its *port*, and the connections
  at the junction are drawn inside the area: a connection joining two
  circuit ends is one smooth curve between their ports (`portCurve`; where two
  such curves at one junction would cross, as when lanes arrive at a narrow
  angle and a curve swings out past its neighbours, both are flattened step
  by step towards the straight chord between their ports, which the lane
  order keeps from crossing; `polylinesCross`) (leaving each port in
  the lane's direction), one joining three or more ends (or one whose other
  ends are not drawn) is a spoke from each port to a dot (lines that cross
  without a dot are not joined), and a circuit end with no connection there
  is a short stub ending in an open circle. Connectors take the circuit
  colour (dotted when the connection is planned); hovering one names the
  connection and its circuits. Clicking the area, a connector or a stub
  inside it selects the junction (or picks it as an end in "+ Circuit" /
  "+ Path"), also while the areas are hidden; a connection selected in the
  junction panel is highlighted yellow. A selected junction's area gets a
  yellow outline (dashed while it is picked as an end). An invisible 14 px
  handle in the middle drags the junction and opens its hover summary.
* **Map features** panel (floating at the top right of the map, collapsible;
  remembered by the browser, `thgrid.mapFeatures`, which takes over the old
  `thgrid.mapDetails` once): *Site details* (see above), *Site labels* (off:
  a label shows only while hovering, or for the selected / picked site),
  *Junction areas* (off: only the connectors, which still select the
  junction), *Paths without circuits* (the selected or edited one is always
  drawn), *Planned* (off: planned sites, circuits and connections are left
  out, and parallel lanes close up), *Below 230 kV* (off: circuits running
  below 230 kV, by energized else rated voltage, and sites whose yards are
  all below 230 kV are left out, as are paths without circuits ending at such
  a site; a site with a 230 kV or higher yard stays, and so do circuits
  without a voltage) and *Base map* (the OpenStreetMap tiles). A line
  junction whose circuits are all left out (by *Planned* or *Below 230 kV*)
  is not drawn either, unless it is selected.
  Junctions carry no label by
  default, so the map only names substations; hovering a junction opens a
  popup with its name, coordinates and each connection with the circuit
  ends it joins, and while a junction is selected or picked as a circuit end
  its label (name plus one badge per connection, coloured by voltage) is
  shown next to the marker; circuits are polylines coloured by
  voltage using the EGAT scheme (`VOLTAGE_COLORS` in `mapUtil.ts`: 500 kV purple, 230 kV red, 115 kV green, 69 kV blue, 33 kV dark orange, 22 kV orange, `0V` black, other grey). `0V` (`TransmissionVoltage.DE_ENERGIZED`, "0V (De-Energized)" in every voltage select, `enumLabel` in `fields.tsx`) marks a circuit that is built but unused, or a planned line partly built: energized at 0V it is drawn black, with the dotted overlay in its rated voltage's colour; it is not a mismatch with the live nodes its ends stay attached to (`energizedMismatches`), re-attaching an end does not re-energize it (`energizeCircuitOps`), and *Below 230 kV* judges it by its rated voltage.
  The colour is that of the circuit's *energized* voltage (falling back to
  the rated voltage); when the two differ a dotted, non-interactive overlay
  in the rated colour is drawn on top (solid = energized, dots = rated) and
  the tooltip says "energized …". Lines are
  dashed when an end is loose (short dashes; a loose end is drawn at the path
  end so the circuit stays visible). Paths and circuits are independent: a
  path without circuits is a dashed grey route (a dashed grey ring when it has a
  single point), selectable; a circuit without a path is a straight line of
  long dashes between its attached ends (parallel ones between the same places
  get lanes, clicking selects the circuit); one attached at a single end
  cannot be drawn, so a ⚠ marker sits at that end (click selects the circuit)
  and its list rows carry "⚠ no path: not drawn"; the line
  weight grows with the bundle size
  (`circuitWeight`: 2 px for a single conductor, +0.5 px per extra
  sub-conductor). Circuits sharing a transmission path are drawn as parallel
  lines offset sideways in screen pixels (`offsetPoints`, recomputed on
  zoom; 5 px apart at full detail, closer when zoomed out by the same
  `mapDetailScale` as the sites), up to six distinct lanes; further circuits overlap the last lane.
  The lanes are laid out by `layoutLanes` (`MapEditor.tsx`): by default a
  path's circuits follow their tower positions (`towerLayout.ts`: a circuit's
  `lineGroup`, the tower line, and `groupCircuit`, its number on the tower, 1 / 2
  the top pair, 3 / 4 below; else assigned in name order: the next free number
  of its group, or two per new tower after the highest group in use): the
  towers run side by side, group 1 on the left of the path's direction, one lane
  apart, and on a tower its circuits fill the lanes from the middle outwards
  (1 left and 2 right in the middle, 3 / 4 outside them); the whole is centred,
  so one circuit runs on the path's line and the auto layout of S1 to S4 is two
  towers, S1 S2 | S3 S4. A path where any circuit
  sets its tower position keeps it (it is never reordered below and anchors its
  junctions); the others only start from it. At a junction
  drawn with a circle, paths that reach it from nearly the same direction
  (within 15°, `JUNCTION_CORRIDOR_DEG`) form a corridor and are laid side by
  side, each path shifted off its own line by whole lanes, instead of
  overlapping (the shift applies along the whole path; site markers grow to
  cover it); and the lanes are ordered after the lanes they connect to across
  the junction, so the connectors inside the circle do not cross (going round
  one bundle's ports, the partners come in the opposite order around the
  circle; a partner not laid out yet counts by the direction its path leaves
  in). Junctions are visited busiest first; at each, the corridor with a path
  laid out already (else the one with the most circuits) anchors and the
  others follow; a path is laid out once, at the first junction that reaches
  it, so chains of junctions follow on. Zoomed far out, once the lanes are
  closer than a 4-conductor bundle line is wide (5 px × `mapDetailScale` < 3.5 px,
  below about zoom 8.7; `mergeLanes`), the circuits of a path are drawn as
  one line per voltage (planned ones apart), highest voltage first, side by
  side: its width is the widths of its circuits added up divided by 4, at
  least 1 px and at most a 4-bundle line (3.5 px); it runs into a junction's
  centre (no connectors that far out), its tooltip lists the circuits, and
  clicking it selects the path as before. On the
  three zoom levels after that (`THIN_ZOOM_LEVELS`, `laneWidthFactor`), where the
  lanes are drawn apart but still close, circuits are drawn thinner: half their
  width on the first level after merging, then two thirds, five sixths, and
  full width from the fourth level on (EGAT: zoom 9, 10, 11, full from 12). A circuit's geometry is derived from its
  TRANSMISSION connections (`endLocation`) plus the waypoints of its
  transmission path (shared by parallel circuits).
* Modes: **Select** (click to edit in the panel, drag markers to move;
  clicking a line selects its *transmission path* because parallel circuits
  overlap, the path panel lists its circuits with an *Edit* button per
  circuit, and the circuit panel has a back link to the path),
  **+ Site** / **+ Junction** (click on the map), **+ Path** (opens the "New
  path" panel, `NewPathPanel`: click the site or junction where the route
  starts, then where it ends, or pick them in its *From* / *To* selects;
  a right-click on a picked site or junction takes it out again (the ends
  are a `PathDraft` shared by the map and the panel, highlighted on the
  map). *Swap from / to* exchanges them; *Name* and *Id* default to the
  rule ones (`pathNaming`); the straight distance is shown, and paths that
  already run between the two places are listed with ⚠ (a new one is a
  duplicate unless it gets its own waypoints). *Create path* adds the
  empty path and selects it for *Edit waypoints*; `Esc` or *Cancel*
  returns to Select), **+ Line** (opens the
  "New line" wizard in the side panel; `Esc` or *Cancel* returns to Select), **+ Circuit**
  (opens the "New circuit" wizard, `NewCircuitWizard`, built on
  `circuitWizard.ts` / `buildNewCircuitPlan`):
  1. the ends: click the site or junction where the circuit starts, then
     the one where it ends, or pick them in the *From* / *To* selects
     (sites and line junctions; a site stands for its site junction). A
     right-click on a picked site or junction takes that end out again, as
     does the × next to it; the next pick fills the empty end, a place
     already picked is ignored (the ends are a `CircuitDraft` shared by the
     map and the panel, picked with the same `pickDraftEnd` /
     `dropDraftEnd` as **+ Path**), and *Swap from / to* exchanges them
     with their choices;
  2. how each end connects: at a site a select lists, per yard (highest
     voltage first), its *free* take-offs and **New take-off in yard …**
     (its line name defaults to the rule one toward the other end,
     `<kV>_<site>_L<n>`, and can be typed), then **Site junction**
     (existing, or created with the circuit and named after the site); at a
     junction (or the site junction) a select offers **A node of its own
     (open end)** or every existing node to join, with its ends and
     voltage. A new connection there (a node of its own, or the one a
     take-off starts) takes an optional name and id. Nothing is picked by
     default: at a site the yard at the rated voltage (else at a voltage the
     other site has too, else the highest) is used, through a free take-off
     it already has toward the other site, else a new one
     (`defaultCircuitConnect`); the site junction when the site has no
     yards; at a junction a node of its own. Each end shows what it
     connects to and at which voltage;
  3. the circuit: name and id (left empty: the rule `<kV>_<path name>_S<n>`
     shown as placeholder, see models.md 2.2), template (fills voltage,
     bundle, conductor), rated voltage (left empty: the one the ends
     suggest, `suggestedCircuitVoltage`), length (pre-filled with the
     straight-line distance), **energized voltage** (left empty: the
     connections', the FROM end first; the options mark the FROM end's,
     the TO end's and the rated voltage so a take-off voltage is one pick,
     and 0V marks a circuit not in service) and the transmission path: a
     path that already runs between the two places (either way; the best
     one by default, one that runs the other way makes the circuit follow
     it, its FROM and TO swapped) or **New path** with its name and id;
  4. any take-off voltage is accepted; ⚠ warnings name ends at different
     voltages, an open end, an energized voltage different from an end or
     from the rated one, and both ends in one site. *Create circuit* writes
     everything in one journaled step (site junctions, take-offs, the path,
     the circuit and its two TRANSMISSION connections; a new node gets the
     energized voltage) and selects the circuit; the button lists what else
     it creates. When an end is attached later (*Attach*, "move to" another
     node) the attach helpers in `linkOps.ts` energize the circuit at the
     connection voltage (`energizeCircuitOps`).
* **Split** mode (toolbar button, for the selected path or circuit): the
  panel offers a *Junction* select with every existing junction (site
  junctions labelled by their site; the path's own ends excluded) or "new
  junction": with an existing junction a **Split at …** button cuts the path
  at the segment nearest to that junction right away; with a new one the
  panel takes an optional name / id and the next click on the path (or the
  map) places the junction there (`splitPath.ts`, `buildSplitPathPlan`,
  option `existingJunctionId`). The path is cut at the segment nearest to the click (or junction):
  waypoints before it stay on the path, which now ends at the junction, the
  rest go to a new path from the junction to the old TO end. Every circuit on
  the path is split in two: the original is detached at its TO end and
  re-attached in a node of its own at the junction, a continuation circuit
  (same template, voltage, energized voltage, bundle and conductor; the
  length shared by distance) joins that node and is attached where the
  original used to end, reusing the old connection's id and name. Lines keep
  their sections: the continuation is inserted next to the original on the
  side that led on from the old end, so each line still reads yard to yard.
  Everything is one journaled step, after a confirmation that also offers to
  rename the split circuits and paths by the model rules; the new junction is
  selected afterwards.
* **Join** (the reverse of a split; `joinCircuits.ts`, `buildJoinCircuitsPlan`):
  a node at a junction holding exactly two circuit ends of two circuits whose
  paths meet there has a **Join** button in the connection panel; the
  junction panel does the same for several at once (*Bypass checked*,
  below).
  The first circuit (the one arriving at the junction) survives and takes over
  the far end of the second; its path is extended through the junction with
  the other path's waypoints when it has no other circuits (else the second
  path is extended, else a merged path is created), lengths are added, lines
  replace the two sections by the one, unused paths go, and a free junction
  with nothing left is removed. When a path already runs between the joined
  ends the dialog first asks whether to run the joined circuit on it instead
  (following its direction); then a summary with ⚠ notes about differing
  voltage / bundle / conductor / planned flags is confirmed, and renaming by
  the model rules is offered.
* **Bypass a junction** (`bypassJunction.ts`, `passThroughs`, `buildBypassPlan`;
  junction panel, *Through this junction*): every pass-through at the
  junction (a node holding two circuit ends; in a tee, each pair of ends
  that are consecutive sections of a line) is listed with its line name(s),
  the far ends and the node, with a checkbox (and *all*); one that cannot be
  joined is shown with the reason and no checkbox. *Bypass checked* joins
  each checked pair into one circuit that runs directly between its far
  ends, one `buildJoinCircuitsPlan` after the other, as one journaled step:
  in a tee the pair is first moved into a node of its own, so the tee keeps
  its other ends; parallel circuits bypassed in the same run share the path
  the first of them got (created or extended); a path that already ran
  between the far ends is used only when the user agrees (asked once). Nodes
  left without circuit ends go, unused paths go, and the junction too when
  nothing is left (the first joined circuit is selected then). The summary
  lists the joins, paths, removals and ⚠ notes, and renaming the joined
  circuits and paths by the model rules is offered.
* **Re-route lines** (path panel section, `PathLinesPanel`): checkboxes pick
  one or more circuits of the path (labelled by their lines, with *all*) and
  tabs pick the operation: **Route via**, **Route to**, **Route from**
  (below). The checks stay when switching tabs; the place lists offer every
  site and junction other than the path's ends.
* **Route via a station or junction** (`routeVia.ts`, `buildRouteViaPlan`;
  *Re-route lines*, *Route via*): *Via* picks a
  site or junction other than the path's ends. For a site, *Connect at*
  offers **Pass through the site junction** (created when the site has none)
  or **Into yard …**; a yard is selectable only when it is at the voltage
  every checked circuit runs at (energized voltage, else rated;
  `yardChoices`, `runVoltage`), the others are listed disabled with the
  reason. Each circuit is cut at the path segment nearest to the via point:
  the original keeps the first part (length shared by distance) and a
  continuation (same make-up) runs on to where the original used to end.
  Through a junction both parts are spliced in one node and lines keep them
  as consecutive sections; into a yard each part gets a new take-off toward
  its far end and every line through the circuit is split at the yard (the
  first part keeps the line, a new line runs on from the yard). When every
  circuit of the path is checked the path itself is cut (FROM end → via, plus
  a new path via → TO end); otherwise the checked circuits move to a new pair
  of paths and the others stay. When a path already runs between the FROM
  end and the via point, or between the via point and the TO end (either
  direction; a site, its junction and its yards count as one place;
  `routeViaPathChoices`), the panel shows a select for that part with the
  existing path(s) listed best first (most circuits, then most waypoints)
  and chosen by default, so no duplicate is created, and a *New path* / *Cut this path*
  option to opt out (`RouteViaOptions.reuseBeforeId` / `reuseAfterId`).
  Circuits on a reused path that runs the other way follow its direction
  (their FROM and TO ends swap, noted with ⚠ in the summary); reused paths
  keep their names when renaming is offered. With every circuit checked, the
  cut path carries the first part that is not reused, and it is removed
  when both parts reuse existing paths. One journaled step after a summary
  confirmation; renaming the changed circuits, paths and lines by the model
  rules is offered, and the first new path is selected.
* **Route to / Route from** (`routeEnd.ts`, `buildRouteEndPlan`; *Re-route
  lines*, *Route to* / *Route from*): the checked circuits no longer end at
  the path's TO end (*Route to*) or start at its FROM end (*Route from*)
  but run on past it to another site or junction (*To* / *From*). Each
  circuit is detached at that end and spliced, in a node of its own, with
  its first new section (same make-up; length = its path's route, when the
  circuit has a length) at the junction there: the line junction the path
  ends at, or the site's own junction (created when missing).
  *Route* picks the way out to the new place: existing paths that already
  lead there (`routeEndRoutes`): one path between the two places, or a
  chain of up to four paths through line junctions (never through a site,
  nor back past the path's own ends; chains more than three times the
  straight distance are left out), shortest first and the first chosen by
  default, labelled with their paths, junctions and length; or **New
  straight path**, whose waypoints are edited afterwards
  (`RouteEndOptions.reusePathIds`, a route's `routeKey`). There is one new
  section per path, consecutive sections spliced in a node of their own at
  each junction passed; sections on a path running the other way follow
  it, FROM and TO swapped (noted with ⚠).
  At a site, *Connect at* offers **Into yard …** (default: the first yard
  at the voltage every checked circuit runs at, the others disabled with
  the reason, as for *Route via*): the last section enters it through a
  new take-off named after the far station of the line; or the **Site
  junction** (created when missing). At a junction (or the site junction)
  the last section ends in a node of its own, to be joined to others from
  the junction panel. When the circuits leave a take-off at the old end
  without any circuit (`freedTakeOffs`), a checkbox (on by default) removes
  it with its wiring in the yard (`RouteEndOptions.removeFreedTakeOffs`,
  `cascadeDeleteOps`); unchecked, it is kept and noted with ⚠. Lines
  through a circuit now end (start) at the new place: the new sections
  replace the sections beyond the old end, which leave the line (circuits
  left in no line are noted with ⚠), and the line's end becomes the new
  yard, or the junction. Lines that shared the circuit up to a tee at the old end end up
  with the same sections, noted with ⚠. One journaled step after a summary
  confirmation; renaming the new path, the new and changed circuits and the
  lines by the model rules is offered (reused paths and lines without both
  ends keep their names), and the first path of the new sections is
  selected.
* **Duplicate paths** (`mergePaths.ts`): paths between the same two places,
  in either direction (`placeKey`: a site, its yards and its site junction
  are one place; `duplicatePathGroups`, `duplicatesOf`) and none of them with
  waypoints (a path with its own route is a parallel line on another route,
  never a duplicate), are marked
  "⚠ same ends as …" in the Paths / Find lists. The path panel lists them
  under *Same ends as this path* (circuits, waypoints, "runs the other way")
  with **Merge … into** this path; the Paths tab's **Merge duplicates**
  merges every group into its preferred path (`preferredPath`: most
  circuits, then most waypoints). A merge (`buildMergePathsPlan`) moves the
  circuits onto the kept path, those of a path running the other way
  following its direction (FROM and TO swap), and deletes the others; the
  kept path keeps its route, a straight one taking over the route of the
  first merged path that has waypoints (a different route that is dropped
  is noted with ⚠). One journaled step after a summary; renaming the kept
  path and the moved circuits by the model rules is offered. Renaming only
  part of a group of parallel records never reuses a number a kept sibling
  carries (`sequenceAmong` in `naming.ts`): circuits merged onto a path
  with S1 to S4 become S5, S6.
* **Delete line** (`deleteLines.ts`, `buildDeleteLinesPlan`, `confirmDeleteLines`;
  line panel, *Lines* tab ×, Delete key / toolbar on a selected line): the
  dialog lists the circuits, take-offs and connections only this line uses
  and offers to delete them with it (OK), or, on Cancel, to remove only the
  line (its circuits stay). A circuit that is a section of another line is
  kept, a connection still holding a circuit end of a kept circuit is kept
  with the deleted ends removed (its take-off stays too), and paths left
  without circuits are kept for the Paths tab's *Delete unused*; the dialog
  names what is kept and why.
* **Lines without circuits are removed** (`NetworkEditor.apply` in
  `NetworkContext.tsx`, with `emptyLinesOps` and `linesRemovedBy` /
  `linesRemovedNote` in `deleteLines.ts`): after any edit, a line left without
  circuit sections is deleted in the same journaled step. Whenever an edit
  would remove lines the user has not already agreed to, a warning names them
  first ("This also removes line …: no circuits would be left in it") and
  Cancel drops the whole edit. A line renamed in the edit (a new id) counts
  as kept. The delete-line dialog passes its lines as
  confirmed (`ApplyOptions.confirmedLineIds`); deleting a circuit, site,
  junction or anything else from the lists or the toolbar names the lines it
  would empty in its own confirmation instead of asking twice. Undo / redo do
  not warn.
* **Waypoints** mode (toolbar button or "Edit waypoints" in the path or
  circuit panel, for the selected path): waypoints are draggable vertex markers
  and clicking one selects it. Adding is explicit: *New waypoint* (empty
  route) / *Add at end*, or *Add before* / *Add after* the selected point,
  arm the next map click (clicking the line counts as a map click while
  armed; `Esc` disarms). `Del` removes the selected point. The panel lists
  the points, reorders them, edits coordinates and clears the route. Every
  change is one `upsert` of the circuit's transmission path, so circuits
  sharing the path move together (the panel says which).
* **Find**: the overview panel (toolbar *Find* deselects to show it) starts
  with a tab strip **Find · Sites · Yards · Junctions · Paths · Lines ·
  Circuits** (the chosen tab is remembered for the session). *Find* is a
  search box over sites, yards, junctions, paths, circuits and lines whose
  result types can be limited with chips (none checked = every type); the
  other tabs are the same list restricted to one type, with their own search
  box (switching tabs starts a fresh search, page and set of checks), so every tab reads the same way: search on top, a checkbox per
  regenerable row, the scrolled list (100 rows per page; past that a
  *‹ Previous* / *Next ›* pager with the shown range sits under the list,
  and changing the search or filters goes back to the first page), the
  regenerate box; *Paths* adds a
  count and a **Delete unused** button for paths no circuit uses (new lines
  are made with the toolbar's *+ Line* wizard); *Lines* adds a count of the
  lines missing an end and **Fill missing ends (n)**, which sets every FROM /
  TO a line does not state from its own sections (`fillLineEnds` /
  `guessLineEnds` in `src/network/lines.ts`: where the first / last section
  leaves the line, a yard or a junction; a single section runs along the
  line unless a stated end, or else the line name `<kV>_<from>_<to>_L<n>`,
  says it runs the other way; an end stays unset when that section end is
  not connected) in one journaled step after a confirmation listing the
  changes, then offers to rename the lines by the model rules. Every row ends with a × that
  deletes the record after a confirmation naming what goes with it (a site
  with its yards and site junction, a yard with its contents, a junction with
  its nodes, a path with its circuits, a circuit alone; a line opens the
  delete-line dialog). A site row lists its yards, highest voltage first,
  each with its yard voltage symbol in front of the name (a yard row has the
  symbol too; circuit and line rows keep a voltage colour square), and a generation site carries the same G badge
  and lettered type badges as its map label. Rows are
  sorted by name. Rows carry a ⚠ marker for anything needing attention (loose
  circuit end, path without an end, path without circuits, end differing from
  the path, broken line); picking a row selects the record and pans the map to it.
  Rows of sites, yards, paths, circuits and lines have a checkbox ("all shown",
  or "all on page" when paged, checks every row of the current page; checks
  are kept across pages); with something checked a **Regenerate from model
  rules** box appears with *id* / *name* toggles, a preview of every change
  (`old → new`) computed by `regenerateNamingOps` (`src/network/naming.ts`:
  the model classes' static naming applied to the existing records, parallel
  paths / circuits / lines numbered in the order of the numbers their names
  already carry (`S2`, `L2`, `(2)`; not document order, which a rename
  changes), so a second run changes nothing; ids that targets trade with each
  other are swapped through a temporary id, other clashing ids suffixed `_2`,
  every reference rewritten through `renameRecordOps`) and a button that
  applies it as one journaled, undoable step. Sites regenerate their id only
  (`SSG_<code>`) and keep the name the user gave them, as yards keep their
  display name; junctions likewise regenerate their id only, from their name
  (`TJT_<name>`; an unnamed site junction from its site's code, any other
  unnamed junction is skipped), and the junction panel's id editor offers the
  rule id as *auto*.
* Site and junction panels end with "Paths and circuits here": every path
  that starts or ends there (and the path of any circuit attached there),
  each with its circuits listed as children, with the same ⚠ markers, so a
  circuit detached at one end can still be reached from the other. Lines
  come first, in two groups: *Lines ending here* (a yard of the site is the
  line's FROM or TO) and *Lines passing through the junction* (sections
  spliced at the site's junction, or at the junction itself in a junction
  panel, of a line that ends elsewhere; each names the junction).
* Panels: path (name, FROM / TO ends: a select of every site and every
  line junction (a route runs between places: a site's own junction is at
  the site and a yard is not a place of its own, so neither is offered; an
  end naming one shows as its site), changeable at any time, with a link to
  the place, the circuits attached there and *detach*; moving or detaching
  an end detaches the circuit ends at the old place after a confirmation
  (`PathEndRow`; the same site / junction list feeds *+ Path* and *Re-route
  lines*), edit waypoints, circuits on the path with
  drill-down and ⚠ markers, each with its line(s) as links and a tower
  position select ("auto (T1 1 (top left))" or a tower and number;
  `CircuitsWithTower`), then, below the list, a collapsible *Towers* section
  (open by default; folding it is remembered, `thgrid.towerPanel`) with
  schematic lattice towers seen from the FROM end, one per line group side by
  side on a common ground line, each as tall as its pairs of circuits need,
  labelled T1, T2, …, drawn like a double-circuit suspension tower
  (`TowerDiagram`): a narrow straight body braced with X panels from the
  earth-wire arm down past the lowest cross-arm, then legs splaying out to a
  wide braced base; on top the earth-wire arm (a flat top chord with members
  sloping down to the body, an earth wire at each end); per pair of circuits,
  1 / 2 on top, 3 / 4 below, three lattice cross-arms, one per phase (flat
  bottom chord, top chord rising to the body; the lowest reaches a little
  further), an insulator string hanging from each tip with the conductor under
  it, the left circuit's on the left, in the circuit's voltage colour, paler
  and dashed when its position is assigned automatically, hollow where no
  circuit hangs, named under its conductors by its line without the voltage
  (else the tail of its name); a click on a circuit's conductors opens it);
  the circuit panel has *Line group* and *Circuit on the tower* fields; plus a ⚠ list of any other yard / junction a
  circuit of the path is connected at, "Lines over this path" listing every
  line that uses one of its circuits with the line's ends as links and which
  sections lie on the path, delete with its circuits), circuit (each attached
  end shows its node with a *planned* checkbox for that connection,
  `EndPlannedToggle`, at a yard take-off or a junction alike) loose ends
  offer *Attach* at the path end (a free take-off of any yard of the site,
  or a new take-off at a chosen yard, defaulting to the yard at the circuit's
  voltage; the node at a junction; at a site, also its site junction,
  `SiteJunctionAttach`: one of its nodes or a new node, or, when the site has
  no junction yet, **+ junction & node** creating both in one step), site (code, name, coordinates, yards with "open editor", add yard,
  add take-off, an *Extensions* card (`SiteExtensionsPanel`: an extension shows
  the site it extends with **Unlink**; a site of its own picks the site it
  extends, nearest first, with **Link**, or one click on **Link to …** when
  its code points at a site within 10 km, `suggestedParentSite`: `BPK_T` →
  `BPK`, `SB_S4` → `SB`; a parent lists its extensions with **Unlink** each,
  **Add extension** and **Link all** for the sites whose code points at it;
  each change is one journaled step), a *Site junction* card showing the site's junction with its
  node count or a **+ Site junction** button creating it, named after the
  site code; the site's junction is not drawn as a separate marker, the site
  marker stands for it, its hover summary names the junction, and dragging
  the site moves the junction too, delete), junction (name, coordinates, the electrical nodes
  at the junction, each with an editable name (default `<junction>_<n>`) and
  a nominal voltage selector, a *planned* checkbox (drawn dotted; a built
  circuit joined there gets a warning), a × that deletes the node, and a "move to" select on
  every circuit end to put it into another node or a new one; every circuit end
  has a checkbox, circuit ends whose path ends here but that are not attached
  are listed under "Not connected here", and *Connect checked*
  (`formJunctionNodeOps` in `linkOps.ts`) puts two or more checked ends into
  one node: the node already holding most of them takes the others, or a new
  one is formed when none is attached; a single checked end that is not
  connected yet, or the *+ node* button on its "Not connected here" row, gets
  a node of its own (at a line junction or a site's junction alike: a path
  ending at the site counts as ending at its junction); a node is never added
  without circuit ends and is removed when its last one leaves; below them the
  *Through this junction* list to bypass the junction, see above; the circuit
  panel has the same select next to an end that sits at a junction), circuit (fields; no
  template is stored on a circuit, so instead of a template select there is
  an *Apply template…* button that reveals a picker on demand and replaces
  the rated voltage, bundle and conductor values with a template's, a
  deliberate step;
  rated and energized voltage, line, transmission path selector and path name, "new path for this
  circuit", detach either end, swap the FROM and TO ends, delete; an
  "Attention" notice appears when the energized voltage being edited differs
  from the connection at either end, with a "use …" button per end that
  adopts the connection voltage, and the circuit rows in the path, site,
  junction and find lists carry the same ⚠ marker; below it a **Lines**
  panel lists the lines the circuit is a section of, with a "remove" per
  line, and **Form a line**: walking from the circuit through junction
  nodes, every yard node and junction node reached on either side is a
  place the line can end at (`lineEndCandidates` in `src/network/lines.ts`:
  a yard ends the walk, a junction (a site junction or a line junction) is
  also passed on; fewest sections first; a circuit end that is not
  connected gives an unset end). *From* lists the places on the circuit's
  FROM side and *To* those on its TO side, labelled with the place, the
  node when the junction has several and how many sections further; the
  nearest yard that still leaves a line to form is preselected. A pair is
  offered disabled, with the reason, when it would duplicate a line that
  already uses this circuit, lie within one or contain one (`formLine`:
  "already line …", "within line …", "would contain line …: extend that
  line instead"), when both ends are the same place or the two sides
  share a section; lines that only share part of their sections (a tie at
  a tee) are fine. The preview names the line (`<kV>_<from>_<to>_L<n>`) and
  its sections; **Form line** creates it, sections FROM → TO along the
  circuit, and selects it; when nothing is left the panel says so), line
  (name, voltage, FROM / TO end: a yard, a site junction or a line junction
  (a junction end: the line stays open there or ties in),
  *Swap from / to* which exchanges the ends and reverses the sections and
  then asks whether to regenerate the id and name from the rules, since
  `<kV>_<from>_<to>_L<n>` reads the other way round (the selection follows
  a new id), **Fill missing ends** when the line does not state an end and
  its sections tell where it is (`guessLineEnds`),
  ordered sections with swatch, move up / down, remove, "Order along route",
  "Add section" offering the circuits joined to either end, ⚠ notice for
  sections that are not joined or do not reach the stated ends; selecting a
  line highlights all its sections on the map and *Find* lists lines; the
  site panel lists the lines ending at its yards), overview (the tab strip
  described under *Find* above, then network name and description, counts,
  loose circuits; the toolbar's *+ Line* opens the **New line** wizard in
  the side panel (`lineWizard.ts`: pick the FROM and TO ends, each a site, then one of its yards (the circuits leave it through take-offs; the yard at the other end's voltage, else the highest, is preselected) or its site junction (created when missing), or a line junction (`LineEndField`; end keys `Y:` / `G:` / `J:`, `NewLineSpec.from` / `to`); at a junction end each circuit gets a node of its own and the line ends at that junction, open until it is extended or tied in (lines toward the same open end take the next free `L<n>`), a take-off facing a line junction is named after it, and the voltage must be picked when neither end is a yard; an optional *Energized voltage* (e.g. 0V de-energized) is set on every new section instead of the one their connections give; then optionally the stops
  in between (**+ Junction in between** adds an ordered stop with move up /
  down and remove; a stop is a free junction or a *site*, passed through its
  site junction, which the plan creates named after the site when the site
  has none yet; each junction at most once, the end yards' sites excluded;
  the same stops can be picked on the map: the first two sites or junctions
  clicked set the FROM and then the TO end (a site gives the yard at the
  other end's voltage, else at the line's voltage, else its highest one;
  the panel can change it; a site without yards gives its site junction),
  further sites and junctions clicked are appended as stops in between, in
  click order, and a right-click on a site or junction takes it
  out again; the wizard's stops and voltage live in the map editor as a
  `LineDraft` with `lineDraftSiteClick` / `lineDraftJunctionClick` /
  `lineDraftRemove` in `mapUtil.ts`, and the sites and junctions on the line
  are highlighted),
  a conductor via a circuit template with voltage / bundle / conductor
  overrides, the number of parallel circuits and the total length,
  pre-filled with the straight-line distance through the stops; it previews
  and then creates in one journaled step a take-off per circuit at each yard
  named `<voltage>_<other site>_L<n>` (when a yard already has free
  take-offs, attached to no circuit, whose line name points at the other
  site, a checkbox, on by default, attaches the circuits to those instead,
  lowest `L<n>` first, one per circuit, new ones only beyond them; the
  preview marks such take-offs *existing*), one transmission path per *leg*
  (consecutive stops) shared by the circuits, per circuit one section per
  leg named `<line name>_<path name>` (the line is named first) attached at the yards, joined section to
  section in a node of its own at every junction (parallel circuits stay
  isolated) and energized, with the length shared among the sections by
  straight-line distance, and one line per circuit named
  `<kV>_<site>_<site>_L<n>` whose sections run FROM → TO; for every leg
  where a path already runs between the two stops (the yards' sites or the
  junctions, either direction) the wizard reuses it by default and offers, with a *Route*
  select per leg, to create a separate path instead; a path whose circuits
  are energized at another voltage than the FROM yard (the line voltage,
  also the voltage and name of the new line) is offered too, marked with the
  voltage it carries, but never picked on its own: when only such paths
  exist the leg has no default, the select asks to choose between sharing
  the route and a new path, and *Create* stays disabled until the choice is
  made (sharing adds a ⚠ note); sections follow the
  direction of a reused path, the line keeps the chosen FROM / TO ends);
  the *Paths* tab lists the paths with deletion of the unused ones; legend).
  The toolbar
  also has a *Rename* button; both write a `meta` op.

### 9.4 Substation editor

* SVG drawing computed by `layoutSubstation` from bus `row`, bay `column`,
  equipment `row`, take-off `row`. Buses, wires, equipment symbols,
  terminals and take-offs are coloured with the same EGAT voltage scheme as
  the map: a bus by its voltage, equipment by its first terminal voltage or
  the bay voltage, a wire by the bus it touches or else a terminal voltage,
  everything falling back to the yard voltage (CSS variable `--vc`). Buses are horizontal rails, bays are
  dashed columns, equipment are symbols (`symbols.tsx`) with terminal dots
  (a ground switch is an L off the bay column, its terminal at the corner,
  the switch and earth hanging down to the right of the column).
  A bus is labelled with its name and its number in parentheses, `MAIN_BUS (1)`
  (`busLabel`: a rule name ending in the number, `MAIN_BUS_1`, loses that
  tail; a transfer bus shows its name only, as the naming rules give it no number); the items list
  uses the same label.
  A faint dotted line per row (0 up to the highest row in use, numbered at the
  left margin, lighter than the dashed bay columns) shows the grid.
  Rows count from the bottom: row 0 is the lowest line of
  the diagram. Each bay has a *take-off column* to the right of its main
  column: a take-off with the *Take-off column* flag (`takeOffColumn`, set
  on new take-offs) is drawn there as a vertical arrow at its row, its
  terminal at the end opposite the head; the arrow points up, or down when
  the yard wiring reaches it from a bus or equipment at a higher row /
  row. Every take-off the UI creates (yard toolbar, site panel, circuit and
  line panels, line wizard) is flagged; a take-off without the flag (older
  data, or unticked by hand) stays in the bay column and is marked ⚠
  (diagram label, panel note and a validation warning). Equipment can be
  placed in that column too (*In take-off column of* select in the
  equipment panel, listing the bay's take-offs; `takeOffId`), at its own
  row on the same rows as the bay column, nothing is stacked automatically;
  the wires between bay column, equipment and take-off are drawn in connect
  mode as L shapes, horizontal from the bay-column side (or the take-off)
  first, then vertical; wires between bays stay Z-shaped. **+ Equipment**
  with a take-off (or equipment of its column) selected adds into that
  column at the next free row. Take-offs without a bay
  are drawn in extra columns on the right. A **yard link** (toolbar *yard
  link to…* + **+ Yard link**, listing the other yards of this site only;
  collection `yardConnections`) joins nodes of two yards, e.g. the two sides of a
  transformer: each yard draws its own nodes of the link wired to a *port*,
  an arrow whose tip is a box in the other yard's voltage colour naming that
  site, yard and the link, placed above the rows when the other yard's
  voltage is higher and below them otherwise (in the column of the link's
  first node here, or an extra column while it has none); the wires take a
  node's own voltage colour, else the lower of the two yards. In Connect
  mode a node followed by the port (or the reverse) wires the node into the
  link; the link panel lists the nodes on both sides, removes the ones here
  and opens the other yard.
* The toolbar and the hint bar are sticky inside the scrolling canvas (top
  and bottom-left), so they stay in view while the diagram scrolls in either
  direction; the map editor keeps them fixed over the map.
* Toolbar: Select / Connect modes, + Bus, + Bay, equipment type + Equipment
  (into the selected bay, next free row), "line to…" site picker + Take-off
  (with a site picked the take-off is named `<voltage>_<site code>_L<n>`, the next free
  number toward that site from this yard, via `takeOffLineName`; without one
  it gets a generic `LINE_<n>`), Delete. The site panel's "Add take-off" row
  on the map has the same picker (the typed name wins), and the take-off
  panel has a "Line to site" select that sets the line name. Keys:
  `C` toggles connect mode, `Del` deletes the selection, `Esc` cancels.
* Yard panel, *Move the whole yard*: four buttons apply at once, in one
  journaled step (`yardShift.ts`): ▲ / ▼ add or subtract one from the row
  of every bus, equipment and placed take-off of the yard, ◀ / ▶ from the
  column of every bay. A move that would put a row or column below 0 is
  refused with a note.
* Yard panel, *From yard template*: pick a `SUBSTATION_YARD` template and a
  number of bays, **Deploy** (`deployYardTemplateOps` in
  `deployTemplates.ts`): the yard takes the template's arrangement, its
  buses are added (a bus of the same type and number already in the yard is
  kept and reported) and that many empty bays go into the next columns.
* Bay panel, *Equipment from bay template*: lists the `SUBSTATION_BAY`
  templates whose arrangements include the yard's (none until the yard has an
  arrangement), a direction (up / down) and an optional start row (left
  empty: the lowest bus going up, the highest bus going down). **Add
  equipment** (`deployBayTemplateOps`) creates one equipment per template
  entry at row start ± sequence, coded `<bay>-<n>`, with default terminals
  and the template's line-side / bus-tie flags, and no connections. Entries
  flagged line side go into the bay's line (take-off) column; in a TAKEOFF
  bay they hang on the bay's first flagged take-off (`takeOffId`), or a
  `LINE_<n>` take-off is created one row beyond them in the deploy
  direction, while other bay types place them by the flag alone. The panel reports the rows
  used and the take-off. When any new item (or the take-off to create) would
  share a row with equipment already in the same column nothing is added:
  the panel shows the clashing rows and an alert says so. Going down below
  row 0 is refused.
* Take-off panel, *Voltage*: left empty the take-off is at the yard voltage;
  set, the take-off is drawn in that colour, the connection a circuit is
  attached to (and so the circuit's energized voltage) takes it, *Line to
  site* prefixes the name with it, and a transformer winding wired to the
  take-off is expected at that voltage instead of the yard's. The line
  wizard sets it on the take-offs it creates when the circuit voltage
  differs from the yard's and energizes the line at the circuit voltage.
* Equipment panel, transformers: instead of the terminals table the panel
  edits the **windings** with the same editor as the power-transformer
  template form (`WindingsEditor`: side, wiring, tap changer, voltage,
  ratings per cooling mode with add / remove, renameable keys, add / remove
  winding, validated as a template's windings); the terminals follow, one
  per winding, on *Apply*. Picking a transformer template copies its windings.
* Equipment panel, *Position and purpose*: the row (with ▲ / ▼ one-row
  buttons) and the *Line side* / *Bus tie* checkboxes (drawn as ↑ / ⇔
  after the code) apply at once, without *Apply*. Line-side equipment is
  drawn in the bay's line column even without a take-off. A power
  transformer belongs there like a take-off: **+ Equipment** flags a new one,
  an unflagged one stays in the bay column marked ⚠ with a validation
  warning, and Connect bay chains such loose line-side equipment with the
  bay's first take-off (or on its own) and ties it at the disconnector pair.
  The transformer symbol keeps its first winding (H) at the top and the
  second (X) at the bottom, so in the yard whose port is below (the other
  yard has the lower voltage) the bay stack belongs above the transformer
  (deploy the bay template downward), and in a yard whose port is above the
  stack belongs below it; a winding of another voltage wired inside the yard
  gets a warning saying so.
  A power transformer wired
  (in a yard connection or a yard link) to a bus or to equipment that is not
  flagged line side gets a validation warning. The other fields of the
  panel stay a draft until *Apply*, and a draft keeps its unapplied edits
  when such an immediate change (or an undo) alters the record.
* Bay panel, *Wiring*: **Connect bay** wires the whole stack of one bay
  (`wireBayOps` in `autoWire.ts`): the bay column (buses, equipment and
  unflagged take-offs) is chained in row order, each item's top terminal to
  the bottom terminal of the item above (single-node items such as a bus,
  a take-off, a PT or a ground switch join both neighbours; two buses are
  never joined); then the take-off column is chained per take-off (the
  take-off plus the equipment with its `takeOffId`) and tied to the bay
  column at the point where two disconnecting switches meet, the nearest
  such point when there are several (each take-off takes a different one).
  Without such a point a lone take-off chain is wired but left unattached
  (error shown); with several take-offs in the column and no point for one
  of them nothing in the take-off column is wired and the panel shows the
  error. Nodes already wired join their connection; nodes of a yard link
  are not touched. **Disconnect bay** removes the bay's equipment and
  take-offs from every yard connection (connections left with fewer than
  two nodes are deleted; yard links are kept), after a confirm.
* Connect mode: click two nodes (terminal dot, bus rail or take-off dot).
  Free nodes form a new SUBSTATION connection; clicking a node that is
  already wired joins its connection; two wired nodes merge their
  connections. Wired nodes are solid dots in the colour of their node's
  voltage (the connection's own voltage when set, else the terminal, bay or
  yard voltage), the first pick is highlighted. A
  connection shared by several nodes is drawn as one vertical segment per
  column through that column's nodes, neighbouring columns linked by a
  horizontal leg that leaves the left column at the middle of its segment
  (a T with a dot; at the node itself when there is only one) and lands on
  the right column at that height when it lies within its segment (another
  dot) or turns up or down to the closest node there, so a bay column is
  tied to the nearest equipment of the take-off column, never to a
  mid-point hub.
* Everything that can be created takes an optional id (a `NewIdField`,
  empty = generated): the "New site" / "New junction" panel shown while the
  map waits for a click, the yard / take-off / line rows, the circuit wizard
  (circuit, new path and the connections at both ends) and a "next id" box in
  the substation toolbar used by the next bus / bay / equipment / take-off.
* Every panel header shows the record id with an *id…* button: the new id
  must match the id pattern and be unique in the network; the rename is one
  journaled step that rewrites every reference (renaming a yard also changes
  the editor URL). Next to it an *auto* button appears whenever the id the
  model rules give the record (`draftNaming`: the rules run on the record as
  currently edited, so a changed code or name is reflected at once) differs
  from the current id; it pre-fills the rename box with that id, confirmed
  with *Rename*. The *Name* field of the yard (yard name), bus, bay,
  equipment, take-off, circuit, path and line panels has the same *auto*
  button, which fills the draft with the rule name (applied with *Apply*).
  A site has them too: its rule id is `SSG_<code>` and its rule name is the
  code (a new site is named after its code when the name is left empty;
  the map popup and *Find* hide a name equal to the code). Junctions have
  none, and the mass regeneration in *Find* gives a site its id only.
* Panels edit the records (apply on *Apply*). The equipment panel can change
  the type (terminals reset), pick a power-transformer template (one terminal
  per winding) and edit terminals; nodes of removed terminals are dropped
  from connections. The take-off panel shows the node, circuits and lines
  the take-off carries (links open the map with that record selected); the
  *Items* list says the same per take-off (or *free*) and the diagram writes
  the circuit and line names under a linked take-off's arrow (full text in
  the tooltip). A take-off in use is never deleted from the yard editor:
  the panel's *Delete*, the Delete key and the mass delete refuse it with
  the circuits and lines named, detach the end or delete the line on the
  map first. The connection panel sets the node's voltage (empty = the yard
  voltage; it colours the wire) and an optional current limit, both applied
  at once, and lists and removes nodes. A bus or take-off with its own
  voltage on a connection at another voltage, and a piece of equipment
  (other than a transformer) bridging two connections at different voltages
  (an unset voltage counts as the yard's), are reported as warnings.
* Names and ids follow the model rules (models.md 2.2) unless given: a new
  bus / bay / equipment / take-off is created with the rule name (`MAIN_BUS_1`,
  `BAY_8041`, the equipment code, the line name) and id; in the bus, bay,
  equipment and take-off panels the *Name* field shows the rule name as
  placeholder (recomputed from the number / code / line name being edited)
  and an empty name is filled with it on *Apply*; every one of those panels
  and the yard panel has an *Auto id / name* button (`RegenerateButton`)
  that re-derives the record from its current code in one step, e.g. after
  the code was changed, and the selection follows the new id.
* The yard panel ends with **Items**: every bay, bus, piece of equipment and
  take-off of the yard with a checkbox and a link that selects it, an *all*
  checkbox (the list is a tree: buses, then each bay with its bay-column
  equipment, highest row first as drawn, and its take-offs, each with the
  equipment of its column; items without a known bay at the end), a **Delete checked** button (confirms with the counts, then one
  journaled step of cascading deletes, a bay taking its equipment along;
  disabled with a ⚠ note while a checked take-off is in use) and the same
  **Regenerate from model rules** box as *Find* on the map (`RegenerateBox`:
  id / name toggles, preview, one journaled step).

### 9.5 Versions, import, export

* *Save version* commits the journal; the previous file is archived. The
  *Versions* panel lists archived versions with download links and *Roll
  back* (confirms, warns when unsaved edits exist).
* *Export JSON* downloads the working document from the browser; the
  networks list imports a JSON file (`POST /api/networks/import`, asking
  before overwriting an existing network).

