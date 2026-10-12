# Contributing to THGrid

Thank you for helping map the Thai transmission grid. Contributions come in
three forms: **network data** (the EGAT grid, kept in a sibling repository),
**templates** (`data/templates`, `data/collections` in this repository) and
**code**.

## EGAT network data

The EGAT network itself does not live here. It is one file,
`data/networks/egat.json`, in the sibling repository
**[thgrid-egat](https://github.com/sfalpha/thgrid-egat)**, and that is where
pull requests for mapping work go. This repository only ships the editor, the
models and the standard templates; its `data/networks/` folder is your local
working copy and is ignored by git.

1. Clone both repositories next to each other:

   ```bash
   git clone https://github.com/sfalpha/thgrid.git
   git clone https://github.com/sfalpha/thgrid-egat.git      # or your fork of it
   cd thgrid && npm install && npm run seed
   ```

2. Bring the current EGAT file into your local editor and start it:

   ```bash
   cp ../thgrid-egat/data/networks/egat.json data/networks/
   npm run dev                                                # UI on http://localhost:5173
   ```

   (*Networks → Import JSON* in the UI does the same without copying. The
   backend can also be pointed at another data root with the
   `THGRID_DATA_DIR` environment variable, but note that it then creates its
   `templates/`, `collections/` and `networks/history/` folders there, so do
   not point it straight at the data repository.)

3. Open the **EGAT** network and edit on the **Map** tab (sites, junctions,
   paths, circuits, lines) or the **Substations** tab (buses, bays, equipment,
   take-offs of one yard). Fix everything in the *Issues* panel, then
   **Save version**.

4. Copy `data/networks/egat.json` back into your clone of `thgrid-egat` (or
   use *Export JSON*), commit it there and open a pull request on that
   repository. Do not include `history/` or `journal/` files. Keep one topic
   per pull request (one area, one corridor, one correction) and say where
   the information comes from.

The data conventions (ids, names, voltages, generation sites, how routes and
lines are modelled) are documented in that repository's
[CONTRIBUTING.md](https://github.com/sfalpha/thgrid-egat/blob/main/CONTRIBUTING.md);
the summary below applies to any THGrid network.

## Templates and other networks

Standard templates (conductors, circuits, power transformers) and the EGAT
collection live under `data/templates` and `data/collections` here; add or
correct them through a pull request on this repository. A network for another
operator can be started with *Networks → New* and shared as its own JSON file
or repository, following the same conventions.

Conventions:

* **Ids and names** follow the model naming rules (see `docs/models.md`,
  section 2.2): leave id and name empty when creating a record and the editor
  derives them (`SSG_<site>`, `SSY_<site>_<yard>`, `SBA_<site>_<yard>_<bay>`,
  take-offs `<voltage>_<other site>_L<n>`, circuits `<kV>_<site>_<site>_S<n>`,
  lines `<kV>_<site>_<site>_L<n>`). Every panel has *auto* buttons to re-derive
  them, *Find* regenerates many at once, and the *id…* button renames with
  every reference updated.
* **Voltages** use the `TransmissionVoltage` values (`AC500KV`, `AC230KV`,
  `AC115KV`, `AC69KV`, `AC22KV`, …).
* **Circuits** always run on a **transmission path** (the physical route,
  shared by parallel circuits) and leave a substation through a **take-off**.
  A circuit end connects at the yard or junction where its path ends.
* Prefer the standard **templates** (conductor, circuit, power transformer)
  when creating equipment so the data stays comparable; add new templates
  under `data/templates` when a standard is missing.
* Only contribute information you are allowed to share: public records, your
  own observations, or sources whose licence permits reuse. Do not copy
  restricted material.

## Code

* `npm run typecheck` and `npm run smoke` must pass; `npm run build` must
  succeed.
* Shared models live in `src/templates` and `src/network`; both the backend
  and the web UI import them, so a change there is checked on both sides.
* New record fields need a migration in `src/network/migrate.ts` when old
  files would otherwise fail validation, plus a note in `docs/models.md`.
* Keep the specs in `docs/` in step with the code.

By contributing you agree that your contribution is licensed under the
project's [MIT License](LICENSE).
