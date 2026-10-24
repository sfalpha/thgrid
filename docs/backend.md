# thgrid – Backend specification

The backend is a small local HTTP service that stores templates and
collections as JSON files and serves the web UI. It is written in TypeScript on
Node.js with Express 4 and has no database.

Companion documents: [models.md](models.md) (data shapes) and
[frontend.md](frontend.md) (web UI).

---

## 1. Stack and layout

| Item | Choice |
|---|---|
| Runtime | Node.js ≥ 20 (developed on 24) |
| Framework | Express 4 |
| Language | TypeScript (strict), CommonJS output in `dist/` |
| Dev runner | `tsx watch` |
| Storage | JSON files under `data/` |
| Tests | `scripts/smoke.ts` end-to-end API test (in-process server, temp data dir) |

```
src/server/
  index.ts                 entry point: load config, create context, listen
  config.ts                env → ServerConfig, repo root, data layout constants
  app.ts                   express app factory, routing, static UI, error middleware
  errors.ts                HttpError hierarchy and wire format
  storage/
    json.file.store.ts     generic one-file-per-document store (atomic writes)
    network.store.ts       current document + history/ archive + journal/ per network
    template.store.ts      one store per template kind + TemplateSnapshot (lookup / validation context)
    collection.store.ts    collection store
  services/
    template.service.ts    create/update/delete/validate/usage/resolve
    collection.service.ts  CRUD, export bundle, import bundle
    network.service.ts     journal, save with versioning, rollback, import/export
  routes/
    async.ts               asyncHandler wrapper, query flag helper
    meta.ts                GET /api/meta (kinds, enums, patterns)
    templates.ts           /api/templates/*
    collections.ts         /api/collections/*
    networks.ts            /api/networks/* (documents, journal, versions)
scripts/
  seed.ts                  writes the EGAT standard templates (conductors, circuits, transformers, yard and bay layouts) + collection into data/
  smoke.ts                 API smoke test
```

Shared code used by the backend **and** the UI lives in `src/templates`
(envelope, payloads, validation, registry, resolver) and `src/models` (enums).

---

## 2. Running

```bash
npm install
npm run seed          # optional: populate data/ with the EGAT standard set
npm run seed:fixture  # optional: the test fixture as network test_fixture, replaced on every run
npm run sample:grid   # optional: take the sample grid anew from the egat network (PDG and one line away)
npm run dev           # backend (tsx watch, :3300) + Vite dev server (:5173) together
npm run dev:server    # backend only
npm run build         # tsc → dist/, vite build → web/dist/
npm start             # node dist/server/index.js, serves API and the built UI on :3300
npm run smoke         # end-to-end API test against a temporary data dir
npm run typecheck     # tsc for backend and web
```

### Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3300` | listen port |
| `HOST` | `127.0.0.1` | bind address (local tool; set `0.0.0.0` to expose on the LAN) |
| `THGRID_DATA_DIR` | `<repo>/data` | root of the JSON data |
| `THGRID_WEB_DIST` | `<repo>/web/dist` | built UI to serve; if `index.html` is missing a plain-text hint is served at `/` |

`repoRoot` is resolved relative to the compiled file, so the same config works
from `src/` (tsx) and `dist/` (tsc).

---

## 3. Architecture

```
HTTP ──► routes (parse params, status codes) ──► services (rules) ──► stores (files)
                                                   │
                                                   └─► src/templates registry / validation / resolve
```

* **Routes** are thin: they parse the kind, call one service method and map the
  result to a status code. Async errors are forwarded by `asyncHandler`.
* **Services** own the rules: id derivation, validation, conflict and reference
  checks, timestamps.
* **Stores** know only about files. `TemplateStore` keeps one `JsonFileStore`
  per template kind, in the directory given by the registry.
* **TemplateSnapshot** – a service takes one snapshot (`listAll()`) per request
  and uses it as both `ValidationContext` (does a referenced template exist?)
  and `TemplateLookup` (resolve references, find dependants). A request
  therefore sees a consistent view even if files change concurrently.
* **Registry driven** – adding a template kind touches `src/templates` only;
  the backend picks up the directory, validator and reference extractor from
  `getTemplateKindDefinition(kind)`.

### Storage behaviour

* Path: `<dataDir>/templates/<kind.directory>/<id>.json`,
  `<dataDir>/collections/<id>.json`.
* Ids must match `^[a-z0-9][a-z0-9_-]{0,79}$`; the store refuses to build a
  path from anything else (no path traversal).
* Writes: serialise with 2-space indent + trailing newline into
  `<file>.<pid>.<time>.tmp`, then `rename` over the target (atomic on POSIX
  and NTFS).
* Reads: every list/get reads from disk; files hand-edited while the server
  runs are picked up immediately. A file with invalid JSON raises a 500 with
  the path in the server log.
* Directories are created on start-up (`init()`); missing directories while
  listing yield an empty list.

---

## 4. API reference

Base path `/api`. All bodies and responses are JSON. Timestamps are ISO-8601
UTC strings.

### 4.1 Error format

```json
{ "error": { "code": "VALIDATION_FAILED", "message": "Validation failed",
             "issues": [ { "path": "data.bundle", "message": "bundle must be >= 1" } ] } }
```

| Status | `code` | When |
|---|---|---|
| 400 | `BAD_REQUEST` | unknown kind, id in body differs from URL, bad bundle format |
| 400 | `BAD_JSON` | malformed JSON body |
| 404 | `NOT_FOUND` | unknown template / collection / route |
| 409 | `CONFLICT` | id already exists; delete refused because referenced (`details` = usage); import clash (`details.templates`) |
| 422 | `VALIDATION_FAILED` | `issues[]` with `path` + `message` (+ `severity: 'warning'` for issues that never block; a network save fails only on issues without it) |
| 500 | `INTERNAL` | unexpected error (logged) |

Issue paths for template payloads are prefixed `data.` (e.g.
`data.windings.H.voltage`); envelope issues use `id`, `description`, `tags`.

### 4.2 Health and meta

| Method & path | Response |
|---|---|
| `GET /api/health` | `{ ok: true, version, dataDir }` |
| `GET /api/meta` | `{ kinds: TemplateKindInfo[], enums: {...}, patterns: { templateId, windingKey }, version }` |

`enums` carries every enum the forms need: `transmissionVoltage`,
`transmissionWireType`, `transmissionWireUnit`, `conductorMountType`,
`towerType`, `transformerWindingSide`,
`transformerWindingWiring`, `transformerWindingTapChanger`,
`transformerCooling`. `kinds` is in display order with `label`, `pluralLabel`,
`directory`, `description`.

### 4.3 Templates

`:kind` is a `TemplateKind` value (`POWER_TRANSFORMER`, `TRANSMISSION_CIRCUIT`,
`TRANSMISSION_CONDUCTOR`).

| Method & path | Body | Success | Notes |
|---|---|---|---|
| `GET /api/templates` | – | 200 `TemplateSummary[]` | all kinds, sorted by name; `?kind=K` filters; `?data=true`: whole `TemplateRecord[]`, data included |
| `GET /api/templates/:kind` | – | 200 `TemplateSummary[]` | `?data=true`: whole `TemplateRecord[]` (the circuit template pickers group by their voltage) |
| `POST /api/templates/:kind` | `TemplateInput` | 201 `TemplateRecord` + `Location` | id from body or derived from `data.name`; 409 if it exists |
| `POST /api/templates/:kind/validate` | `TemplateInput` | 200 `{ valid, issues }` | never writes |
| `GET /api/templates/:kind/:id` | – | 200 `TemplateRecord` | |
| `PUT /api/templates/:kind/:id` | `TemplateInput` | 200 `TemplateRecord` | full replace of `description`, `tags`, `data`; `createdAt` kept; `body.id` must be absent or equal |
| `DELETE /api/templates/:kind/:id` | – | 200 `{ deleted, prunedFrom, dangling }` | 409 with usage when referenced unless `?force=true` |
| `GET /api/templates/:kind/:id/usage` | – | 200 `{ templates: TemplateSummary[], collections: TemplateCollectionSummary[] }` | who references it |
| `GET /api/templates/:kind/:id/resolved` | – | 200 resolved template | references embedded (circuit → conductor); 409-like `CONFLICT` is not used, a missing reference is a 500 `TemplateResolveError` (cannot happen for validated data) |

**Validation** (`TemplateService.validate`): envelope first; if `data` is not
an object the payload is not inspected. Payload rules are in models.md § 3.3.
Cross references are checked against the current snapshot.

**Delete semantics**:
* not referenced → delete file.
* referenced by templates or collections → 409, `details` = usage.
* `?force=true` → delete anyway; the template is removed from every collection
  (`prunedFrom`) and templates that still reference it are returned as
  `dangling` (they will fail validation on their next save and cannot be
  resolved).

### 4.4 Collections

| Method & path | Body | Success | Notes |
|---|---|---|---|
| `GET /api/collections` | – | 200 `TemplateCollectionSummary[]` | sorted by name |
| `POST /api/collections` | `TemplateCollectionInput` | 201 `TemplateCollection` | id from body or derived from `name` |
| `POST /api/collections/validate` | `TemplateCollectionInput` | 200 `{ valid, issues }` | |
| `POST /api/collections/import` | `TemplateBundle` | 201 `ImportResult` | 409 on clash unless `?overwrite=true` |
| `GET /api/collections/:id` | – | 200 `TemplateCollection` | |
| `PUT /api/collections/:id` | `TemplateCollectionInput` | 200 `TemplateCollection` | full replace of name/description/tags/items |
| `DELETE /api/collections/:id` | – | 200 `{ deleted: true }` | templates are untouched |
| `GET /api/collections/:id/export` | – | 200 `TemplateBundle` | `?download=true` adds `Content-Disposition: attachment` |

**Validation**: name required; items must be unique `{kind,id}` pairs that
exist; `note` ≤ 500 chars.

**Export**: the bundle contains every item and, transitively, every template
those items reference (via the registry's `references()`), so a bundle is
self-contained.

**Import** (`ImportResult = { collection, created[], overwritten[], skipped[] }`):
1. Check `format === 'thgrid.template-bundle'` and `version === 1`.
2. Validate every template payload against *bundle + stored data* and the
   collection against the same context. Any issue → 422 with paths like
   `templates.3.data.conductorId` or `collection.items.0.id`.
3. If the collection id or any template id already exists and `overwrite` is
   not set → 409.
4. Write templates (existing `createdAt` preserved, `updatedAt` = now), then
   the collection.

### 4.5 Networks

See section 6.3.

### 4.6 Static UI

When `<webDist>/index.html` exists the app serves it with `express.static` and
falls back to `index.html` for every non-`/api` path (single-page app). In
development the Vite dev server serves the UI and proxies `/api` to the
backend instead.

---

## 5. Scripts

### `npm run seed` (`scripts/seed.ts`)

Writes the EGAT standard set: 11 conductors (1272 / 795 / 477 MCM, ACSR/GA and
ACSR/AW, 477 MCM AAC, and 1272 / 795 MCM HTLS/INVAR and HTLS/ACCC), 44 line
circuits (500 kV ×1, 230 kV ×18, 115 kV ×25: ACSR in the usual bundles plus
HTLS 1× / 2× / 4× of both sizes and core types at 115 and 230 kV), 5 power
transformers (230/115/22 kV 200 MVA; 500/230 kV banks 3×333 MVA FA and 3×200
MVA ONAF with 22 or 24 kV tertiary), the collection `egat_standard` (items ordered from the smaller conductors to the
larger: conductors by size, circuits by voltage, conductor size and bundle; the
template pickers in the editors follow this order) and a
`sample_grid` network, written from `scripts/sample-grid.json` (see
`npm run sample:grid`: PDG, the lines connected to it and the sites one line
away, taken from the EGAT network).
Existing files are skipped unless `--force` is passed. The script validates
every record with the shared validators before writing.

### `npm run sample:grid` (`scripts/sample-grid.ts`)

Takes the sample grid from a network: a site, every line connected to it (at
its yards or its site junction, with all their sections) and the sites and
line junctions those lines reach (`extractAround` in
`src/network/extract.ts`), by default PDG (Pluak Daeng) and one line away in
the network `egat` (`-- --site <code> --hops <n> --from <network id>`; with
more hops the lines of the sites reached are added ring by ring). The sites
keep their yards, in-yard records and generation units; take-offs only where a
kept circuit leaves through them (all of the centre's); a site junction only
with a kept circuit end at it; connections at line junctions keep the kept
circuit ends; an extension whose parent is left out becomes a site of its own.
The source is read as last saved (unsaved journal entries are named and left
out). The result is validated, written to `scripts/sample-grid.json` (what
`npm run seed` seeds `sample_grid` from) and replaces the `sample_grid`
network: through the API when the backend runs (an import with overwrite: the
old version archived, the journal discarded), else in `data/networks`
(archived too).

### `npm run seed:fixture` (`scripts/seed-fixture.ts`)

Writes the network the creation tests run on (`lineFixture()` in
`web/test/fixture.ts`, see docs/testing.md "Fixture") as `test_fixture`
("Test fixture"; `-- --id <id>` for another id), to try the wizards and
operations by hand on the same sites and junctions. Every run starts over: the
network is replaced, its journal is cleared and every archived version is
removed. With the backend running (`PORT`, default 3300) it goes through the
API (an import with overwrite, then `DELETE /versions`), so open editors pull
the new network (the revision continues from the replaced one); otherwise it
writes `data/networks` directly (revision 0). Typechecked with the tests
(`web/test/tsconfig.json`, for the `@shared` imports of the fixture).

### `npm run smoke` (`scripts/smoke.ts`)

Starts the app in-process on a random port with a temporary data directory and
runs ~70 checks over the whole API: templates and collections (validation,
conflicts, references, force delete, bundle export/import, file layout) and
networks (journal, stale seq, take-off rule, save/versions/rollback,
import/export, history files). Exit code 1 on any failure. Extend
it whenever a route or rule is added.

---

## 6. Networks

A network (grid) is one JSON document; see models.md § 6 for the records.
The backend keeps the **current version**, an **archive of every previous
version** and a **journal of unsaved operations** per network.

### 6.1 Storage (`storage/network.store.ts`)

```
<dataDir>/networks/<id>.json                    current document
<dataDir>/networks/history/<id>.<stamp>.json    archived versions; stamp = UTC archival time YYYYMMDDTHHMMSSmmmZ
<dataDir>/networks/journal/<id>.json            unsaved ops: { id, networkId, baseRevision, startedAt, entries[] }
```

* `save(doc)` copies the existing current file to `history/` (if any) and
  then writes `doc`. Rollback, overwrite-import and delete go through the same
  archive step, so nothing is ever overwritten without a copy.
* `listVersions(id)` reads the history files of a network (newest first) and
  returns `{ stamp, archivedAt, revision, updatedAt, name, bytes }`.
* Journals are documents of their own in a `JsonFileStore`.

### 6.2 Service (`services/network.service.ts`)

| Method | Behaviour |
|---|---|
| `create({name,id?,description?})` | empty document, revision 0 |
| `working(id)` | saved document with the journal replayed, plus `journal` state (`baseRevision`, `entries`, `lastSeq`, `stale`, `error?`) and validation `issues` of the working document |
| `appendOps(id,{ops,expectedLastSeq?})` | validates op shapes, replays the journal, checks the new ops apply cleanly, appends them; 409 when `expectedLastSeq` differs from the journal's last seq (another editor) or when the journal belongs to another revision; 422 when an op cannot apply |
| `discard(id)` | deletes the journal |
| `save(id,{force?})` | replays the journal, validates (422 with issues unless `force`; issues with `severity: 'warning'` never block), archives the current file, writes `revision+1`, clears the journal |
| `versions(id)`, `version(id,stamp)` | archive listing / archived document |
| `rollback(id,stamp)` | archives the current file, writes the archived document as current with `revision+1`, clears the journal |
| `purgeVersions(id,keep?)` | deletes archived versions beyond the newest `keep` (default 0 = the whole history); 400 unless `keep` is a whole number; the current file and journal are untouched |
| `export(id,{working?})` | saved or working document |
| `import(doc,{overwrite?,id?})` | validates the document; 409 if the id exists unless `overwrite` (then archived, `revision+1`); journal cleared |
| `delete(id)` | archives then removes the current file and the journal |

All mutating methods of one network run through a per-network promise chain
(`locked`) so a journal append never interleaves with a save.

### 6.3 API

| Method & path | Body | Success | Notes |
|---|---|---|---|
| `GET /api/networks` | – | 200 `NetworkSummary[]` | includes `journalEntries`; files are migrated before counting, so older files without a newer collection still list |
| `POST /api/networks` | `{ name, id?, description? }` | 201 `NetworkDocument` | 409 if exists |
| `POST /api/networks/import` | `NetworkDocument` | 201 (new) / 200 (replaced) `{ document, archivedVersion?, replaced }` | `?overwrite=true`, `?id=` |
| `POST /api/networks/validate` | `NetworkDocument` | 200 `{ valid, issues }` | |
| `GET /api/networks/:id` | – | 200 `NetworkDocument` | saved version |
| `DELETE /api/networks/:id` | – | 200 `{ deleted, archivedVersion }` | |
| `GET /api/networks/:id/working` | – | 200 `WorkingState` | `{ document, savedRevision, savedAt, journal, issues }` |
| `GET /api/networks/:id/journal` | – | 200 `NetworkJournal` | `?after=N`: 200 `JournalSince` `{ networkId, savedRevision, baseRevision, startedAt, lastSeq, entries }` with only the entries after seq N; 400 for a malformed N |
| `POST /api/networks/:id/journal` | `{ ops, expectedLastSeq? }` | 200 `{ lastSeq, appended[], entries, startedAt }` | 409 / 422 as above |
| `GET /api/networks/:id/events` | – | 200 `text/event-stream` | one `NetworkChangeEvent` `{ type, networkId, revision?, lastSeq?, client? }` per journal append (`journal`), save (`saved`), discard (`discarded`), rollback / overwrite-import (`replaced`) and delete (`deleted`); a `: ping` comment every 25 s |
| `DELETE /api/networks/:id/journal` | – | 200 `{ discarded }` | |
| `POST /api/networks/:id/save` | – | 200 `{ document, archivedVersion, appliedEntries }` | `?force=true` saves despite issues |
| `GET /api/networks/:id/export` | – | 200 `NetworkDocument` | `?working=true`, `?download=true` (attachment) |
| `GET /api/networks/:id/versions` | – | 200 `NetworkVersionInfo[]` | newest first |
| `GET /api/networks/:id/versions/:stamp` | – | 200 `NetworkDocument` | `?download=true`; 400 for a malformed stamp |
| `POST /api/networks/:id/versions/:stamp/rollback` | – | 200 `{ document, archivedVersion, appliedEntries }` | |
| `DELETE /api/networks/:id/versions` | – | 200 `{ deleted, kept, stamps }` | `?keep=N` keeps the N newest versions (default 0 = purge all); 400 for a malformed `keep` |

The JSON body limit is 50 MB to allow large documents.

Requests may carry `X-Thgrid-Client: <id>` (letters, digits, `_`, `-`; up to 64): the id of the editor (browser tab).
Changes it makes carry it as `client` in their events, so that editor can skip its own. `NetworkService.events`
(an `EventEmitter`, event `'change'`) is the source of the stream. A journal's `startedAt` is set when its first entry is
appended; with `baseRevision` it tells a journal from one discarded and started again since.

### 6.4 Journal protocol (what the UI does)

1. Open: `GET …/working` → document + `journal.lastSeq`.
2. Every edit: apply the ops locally, then `POST …/journal` with
   `expectedLastSeq`; update `lastSeq` from the response. Posts are
   serialised. A 409 (another editor appended first) pulls their entries and
   retries; a 422 drops the batch and reloads the working document.
3. Save: `POST …/save` → new revision; the UI replaces its document.
4. Discard: `DELETE …/journal` then reload.
5. Crash / reload: `GET …/working` replays the journal, so no edit is lost.
6. Other editors: `GET …/events` while open. On an event from another
   client: `GET …/journal?after=lastSeq` and apply the entries; when the saved
   revision, the journal's `baseRevision` / `startedAt` or its `lastSeq` show
   it was saved, discarded or replaced meanwhile (or entries are missing),
   `GET …/working` instead. Unsent edits are replayed on top; one touching a
   record that changed is dropped and the user told (see frontend 9.2). On
   (re)connecting the stream the UI pulls once to catch up.

