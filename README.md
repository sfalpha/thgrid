# THGrid – Thailand Transmission Grid Network

THGrid is an open, crowd-sourced effort to map the Thai high-voltage
transmission grid: substations and their yards, the equipment inside them,
the lines and circuits that connect them, and the junctions in between. The
project provides the data models, a local backend and a browser based editor so
that anyone can contribute mapping work and share it as plain JSON files.

Created by **Phattanon Duangdara** (<sfalpha@gmail.com>).
Licensed under the [MIT License](LICENSE).

## What is in the box

| Area | Description |
|---|---|
| **Templates** | Reusable specifications of standard equipment: conductors, line circuits and power transformers (e.g. the EGAT standard set). Grouped into named collections, exported as bundles. |
| **Network editor (map)** | OpenStreetMap based editor for substation sites, line junctions, transmission paths (routes with waypoints) and the circuits that run on them. Lines are coloured by the voltage they are energized at with the EGAT colour scheme (a dotted overlay in the rated colour marks a circuit operated below its design voltage) and drawn in parallel when circuits share a path. |
| **Substation editor** | Single-line diagram editor of one yard: buses, bays, equipment with terminals, take-offs and the wiring between them. |
| **Versioned storage** | A network is one JSON file. Every save archives the previous version for rollback; unsaved edits are journaled so nothing is lost on a crash. Networks can be exported and imported from the browser. |
| **Specifications** | [Models](docs/models.md), [backend](docs/backend.md) and [frontend](docs/frontend.md) documents describe every record, API and screen. |

## Quick start

Requires Node.js 20 or newer.

```bash
npm install
npm run seed      # optional: EGAT standard templates and a small sample grid
npm run dev       # backend on http://127.0.0.1:3300, UI on http://localhost:5173
npm run dev:host  # same, but the UI listens on all interfaces (IPv4 + IPv6, :5173) and accepts any host name (LAN, Cloudflare tunnel, ...); the API stays local behind the UI's proxy
```

Production-style run (UI served by the backend):

```bash
npm run build
npm start         # http://127.0.0.1:3300
```

Other scripts: `npm run smoke` (end-to-end API test), `npm run typecheck`,
`npm run dev:server`, `npm run dev:web`,
`npx tsx scripts/strip-circuits.ts <network id>` (keep substations and
junctions of a network, discard its circuits).

## Repository layout

```
src/models      runtime domain classes (substations, equipment, lines, paths, …)
src/templates   template models, validation, registry, resolver
src/factory     factories building runtime objects from templates
src/network     network (grid) records, journal operations, validation, migrations
src/server      Express backend (templates, collections, networks)
web             React + Vite web UI (template editors, map editor, substation editor)
scripts         seed, smoke test, data migrations
data            JSON data: templates, collections, networks
docs            specifications
```

## Data

* Templates: `data/templates/<kind>/<id>.json`; collections: `data/collections/<id>.json`.
* Networks: `data/networks/<id>.json`, archived versions in
  `data/networks/history/<id>.<datetime>.json`, unsaved journal in
  `data/networks/journal/`. The whole `data/networks/` folder is ignored by git;
  network data is versioned in its own repository (see Contributing).
* All files are pretty-printed JSON meant to be versioned in git and merged
  through pull requests. Ids are stable, human readable and unique within a
  network, so diffs stay reviewable.

## Contributing

Mapping contributions and code are welcome. The EGAT network data is kept in
the sibling repository [thgrid-egat](https://github.com/sfalpha/thgrid-egat):
clone it next to this one, copy or import its `data/networks/egat.json` into
the editor here, and open pull requests on that file there. See
[CONTRIBUTING.md](CONTRIBUTING.md)
for the full workflow, for how to add or correct templates here, and for the
conventions used in the data. Please only contribute information you are
allowed to share: public records, your own observations, and sources whose
licences permit reuse. Map tiles come from
[OpenStreetMap](https://www.openstreetmap.org/copyright) and are subject to the
OpenStreetMap tile usage policy.

## License

This project is released under the MIT License. See [LICENSE](LICENSE) for
the full text.
