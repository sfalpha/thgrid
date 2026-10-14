# thgrid – Test cases

Tests of the editor's plan builders: the pure functions behind the map
editor's wizards and operations (`web/src/network/*.ts`), run without a
browser on a small synthetic network. The backend API has its own end-to-end
check, `npm run smoke` (`scripts/smoke.ts`).

## 1. Running

```
npm test              # every case
npm test -- LC-O      # the cases whose id starts with LC-O
npm test -- BV        # route via at the busy places
```

`web/test/run.ts` runs the cases registered by the `*.test.ts` files
(`harness.ts`: `test(id, title, fn)` and one line per case, the failed checks
listed under it); the exit code is non-zero when a case fails. The test files
are typechecked with the rest (`npm run typecheck`, `web/test/tsconfig.json`).

### Fixture (`web/test/fixture.ts`)

One site or junction per role, so each case reads "from <role> to <role>".
`npm run seed:fixture` writes it as the network `test_fixture` to try the
cases by hand; every run replaces it and clears its journal and history.

| Site / junction | Yards | Role |
|---|---|---|
| SA | 230 kV | FROM end, new take-off (no free take-offs) |
| SF | 230 kV | FROM end, existing take-off: free take-offs `230KV_SB_L1`, `230KV_SG_L1`, `230KV_SS_L1`, `230KV_J2_L1` |
| ST | 230 kV, site junction ST | FROM end at a substation junction (it exists) |
| SB | 230 kV | TO end, new take-off |
| SG | 230 kV | TO end, existing take-off: free take-offs `230KV_SA_L1`, `230KV_SF_L1`, `230KV_ST_L1`, `230KV_J1_L1` |
| SS | 230 kV, no site junction | TO end at a substation junction (created) |
| SC, SD | 115 kV only | yards below a 230 kV conductor |
| SH | 230 kV and 115 kV | a site with a yard at either voltage |
| SE | 230 kV only | a site without a 115 kV yard (auxiliary line) |
| SV | 230 kV, no site junction | passed in between (its site junction is created) |
| J1, J2 | – | line junctions: FROM end, TO end |
| J3, J4 | – | line junctions passed in between |

#### Busy area

Places that already carry lines, from de-energized to 500 kV, with one, two
or more voltages at a place, and two quiet sites whose lines are routed
through them. The lines are made by the line wizard when the fixture is
built (`BUSY_LINES`), so their records are what the editor makes; one
circuit each, conductors 4×1272 (500 kV), 2×1272 (230 kV), 1×795 MCM (115 kV).

| Place | Yards | What is there |
|---|---|---|
| MA | 500, 230, 115 kV | a three-yard site: 500 kV: `500KV_MB_L1`; 230 kV: `230KV_MC_L1`–`L3` (L3 de-energized), `230KV_ME_L1`; 115 kV: `115KV_MD_L1`, `L2` (a 230 kV-rated line at 115 kV) |
| MB | 500 kV | one yard: to MA, and to ME via JX |
| MC | 230 kV | one yard, a de-energized line beside two live ones (from MA) |
| MD | 115 kV | one yard, five lines: two to MA (one 230 kV-rated), open-ended ones to JQ, JX (230 kV-rated) and the site junction of MS |
| ME | 500, 230 kV | a two-yard site: 500 kV from MB; 230 kV from MS (via JQ), from MA (via MS), to JX |
| MS | 230, 115 kV, site junction MS | 230 kV yard: to ME via JQ; 115 kV yard: none; its junction: `MS_2` 230 kV splice (MA–ME), `MS_3` 115 kV open end (from MD), `MS_1` 0 V open end (from JX) |
| JP | – | one voltage: two 230 kV splices (MA–MC L1, L2) |
| JQ | – | two: a 230 kV splice (MS–ME), a 115 kV open end (from MD) |
| JX | – | four: a 500 kV splice (MB–ME), open ends at 230 kV (from ME), 115 kV (230 kV-rated, from MD) and 0 V (to MS) |
| QA, QB | 500, 230, 115 kV each | the quiet lines QA → QB, one per kind (`QUIET`): `500KV_QA_QB_L1`, `230KV_QA_QB_L1`, `115KV_QA_QB_L1`, `230KV_QA_QB_L2` (230 kV-rated at 115 kV, on the path of the 115 kV one), `230KV_QA_QB_L3` (230 kV-rated, de-energized, on the path of the 230 kV one) |

## 2. Line creation (`buildNewLinePlan`, `web/test/lineCreation.test.ts`) – automated

Every case builds the plan on a fresh fixture, applies it and checks:

* the plan: no errors (or the expected refusal and no ops); its **warnings
  and notes exactly** (each expected pattern matches one, nothing else is
  reported: an "info, not warning" case fails if a warning appears);
* the document validates;
* per circuit: the line exists, runs FROM → TO between the expected ends
  (`lineStatus`: no missing section, contiguous, first / last section at the
  line's ends) at the expected **line voltage**, is **named after the rated
  voltage** (`<rated kV>_…`, whatever it runs at) with the name and id the
  rules give it (`defaultNamingFor`: regenerating changes nothing); one section per leg, each on
  its leg's path, **rated** at the conductor voltage and **energized** at the
  line voltage;
* a yard end: the section leaves through the plan's take-off, **new** or the
  expected **existing** one, in the expected yard; the take-off's voltage
  (its circuit's, `takeOffVoltage`) and its connection's are the line voltage
  (the yard's for a de-energized line, the energized voltage for an auxiliary
  line); the take-off carries this section only;
* a junction end: a **node of its own** (only this section, open) at the
  expected junction (a site's junction: the existing one or the one created),
  its **nominal voltage** the line voltage;
* each junction passed: the two consecutive sections meet in one node there,
  holding them only, at the line voltage; a node of its own per circuit;
* no take-off carries a voltage of its own;
* **nothing that existed changes** (`unchangedExcept`): every junction,
  take-off, path, circuit, connection and line of the fixture is in the
  result exactly as it was; the wizard only adds.

### 2.1 Ends: FROM × TO (`LC-E-<from>-<to>`)

230 kV conductor, 230 kV yards, one circuit. Ends: **NT** a substation through
a new take-off (FROM SA, TO SB), **ET** a substation through an existing free
take-off toward the other end (FROM SF, TO SG; toward a line junction the
take-off is named after it), **SJ** a substation junction (FROM ST, existing;
TO SS, created), **J** a line junction (FROM J1, TO J2).

| FROM \ TO | NT | ET | SJ | J |
|---|---|---|---|---|
| **NT** | LC-E-NT-NT | LC-E-NT-ET | LC-E-NT-SJ | LC-E-NT-J |
| **ET** | LC-E-ET-NT | LC-E-ET-ET | LC-E-ET-SJ | LC-E-ET-J |
| **SJ** | LC-E-SJ-NT | LC-E-SJ-ET | LC-E-SJ-SJ | LC-E-SJ-J |
| **J** | LC-E-J-NT | LC-E-J-ET | LC-E-J-SJ | LC-E-J-J |

Expected: with a yard at either end the line runs at **230 kV** (line,
sections, take-offs, nodes); with junctions at both ends (SJ / J × SJ / J)
nothing feeds it: **0 V**, de-energized, everywhere. A junction end gives the
note "the line starts / ends at …: each circuit gets a node of its own there,
open …"; both ends at junctions add "both ends are junctions, so no yard
energizes it: … de-energized (0 V)". No warnings.

### 2.2 Junctions in between (`LC-V-*`)

SA → SB (new take-offs), 230 kV:

| Id | Via | Expected |
|---|---|---|
| LC-V-1 | J3 | 2 sections, joined in one node at J3 at 230 kV |
| LC-V-2 | site SV | SV's site junction is created; 2 sections joined there |
| LC-V-3 | J3, then SV, then J4 | 4 sections, a node at each of the three |
| LC-V-4 | J3, two circuits | a node of its own per circuit at J3 |
| LC-V-5 | J1 → J2 via J3 | de-energized: sections and the three nodes at 0 V |

### 2.3 Voltages (`LC-O-*`)

The line wizard **refuses** whatever would not be right and **notes** (blue)
what is unusual but sound; it gives **no warnings** (the verifier fails a case
on any warning). A line never runs above the rating of its conductor nor at
another current type, nor at another voltage than a yard end picked; a site
with a yard at the line's voltage must have that yard picked; both ends at
junctions cannot be energized; both ends in one site are refused. Running below
the rating, an auxiliary take-off (a yard above the line's voltage, the site
having none at it), an open end, de-energized, a path carrying other voltages
and an existing path running the other way are notes.

| Id | Case | Result |
|---|---|---|
| LC-O-1 | 230 kV conductor between 115 kV yards (SC → SD) | runs at 115 kV (line, sections energized, take-offs); note "rated AC230KV, … is at AC115KV: they run at AC115KV" |
| LC-O-2 | 230 kV conductor between 230 kV yards | 230 kV; nothing reported |
| LC-O-3a | energized 115 kV given, 115 kV yards, 230 kV conductor | 115 kV; note "energized at AC115KV, below their rated AC230KV" |
| LC-O-3b | energized 230 kV given = rating = yards | 230 kV; nothing reported |
| LC-O-3c | energized 115 kV given, SH's 230 kV yard picked (SH has a 115 kV yard) | **refused**: "SH 230KV is at AC230KV, the line runs at AC115KV: pick its AC115KV yard 115KV" |
| LC-O-3c2 | energized 115 kV given, SH's 115 kV yard picked | 115 kV at SH 115 kV; below-rating note |
| LC-O-3d | energized 115 kV given at SE (230 kV only) | an auxiliary take-off at SE 230 kV whose circuit is at 115 kV, named with its yard's voltage, `230KV_SC_L<n>`; **note** "… new take-offs there carry AC115KV on their circuit (a secondary / auxiliary line)"; below-rating note |
| LC-O-3e | energized 230 kV given between 115 kV-only yards | **refused**: "… cannot feed a line energized at AC230KV" |
| LC-O-3f | energized 230 kV given on a 115 kV conductor | **refused**: "… above the conductor's rated AC115KV" |
| LC-O-3g | energized DC 300 kV given on an AC 230 kV conductor | **refused**: "AC and DC do not mix" |
| LC-O-3h | energized 0 V given between 230 kV yards | de-energized: sections and line at 0 V, take-offs at their yard's 230 kV; note "the sections are de-energized (0 V)" |
| LC-O-4a | both ends open at junctions (J1 → J2) | **0 V automatically**; open-end notes and the de-energized note |
| LC-O-4b | both ends open, energized 230 kV given | **refused**: "both ends are open at junctions, so nothing feeds it: it cannot be energized at AC230KV (leave the energized voltage empty: 0 V)" |
| LC-O-4c | both ends open, 0 V given | 0 V; notes only |
| LC-O-5a | one end open at a junction, the other a 230 kV yard | 230 kV, the node at 230 kV; the open-end **note** |
| LC-O-5b | one end open, the other a 115 kV yard, 230 kV conductor | 115 kV; open-end and below-rating notes |
| LC-O-6 | yards at 230 kV and 115 kV, 230 kV conductor | **refused**: "the ends are at different voltages" |
| LC-O-7 | 115 kV conductor, SH's 230 kV yard picked | **refused**: "… pick its AC115KV yard 115KV" |
| LC-O-8 | DC 300 kV conductor between AC yards | **refused**: "AC and DC do not mix" |
| LC-O-9 | energized 115 kV at SE, which has a free take-off toward SC at 230 kV | the free take-off is **not reused** (another voltage): a new auxiliary take-off; auxiliary and below-rating notes |
| LC-O-10 | both ends in one site (SA's 230 kV yard → SA's site junction) | **refused**: "both ends belong to the same site: a line runs between two places" |

## 3. Busy places (`web/test/busyPlaces.test.ts`) – automated

New line, Route via, Route to and Route from at the busy area. Every case
checks, besides where the new or moved sections connect and at what voltage,
that what was there is left as it was: no record of the fixture changes but
the line being moved, its circuit, path and end connections
(`unchangedExcept`); a junction gets **a new node of its own**, never one
of the nodes there, whatever their voltage; line names are unique, and take-off
line names unique within each yard (numbered past the ones in use).

### 3.1 The fixture (`FX-*`)

| Id | Checks |
|---|---|
| FX-1 | the busy area is as listed above: the nodes at JP, JQ, JX and the site junction of MS (voltage, circuits held), the take-offs of MA, MD and MS (line name, voltage), the quiet lines (rated / energized) |
| FX-2 | it is named by the rules: regenerating every path, circuit, line and take-off changes nothing; line names are unique (the QA-QB lines between the 230 kV and the 115 kV yards are numbered apart: `230KV_QA_QB_L1`, `L3` on the 230 kV yards, `L2` on the 115 kV ones) |

### 3.2 New line (`BN-*`, `verifyLine` as in section 2)

| Id | Case | Result |
|---|---|---|
| BN-Y1 | MA 500 kV → QB 500 kV | new take-offs, 500 kV |
| BN-Y2 | a fourth line MA 230 kV → MC 230 kV | shares the direct path MA-MC, which carries the de-energized line: any voltage shares a route; note "MA 230KV → MC 230KV: shares the existing path "MA-MC" (it carries 0V circuits)" |
| BN-Y3 | the same on a new path, by choice | note "… a new path "MA-MC (2)", beside the existing "MA-MC""; take-offs `230KV_MC_L4` / `230KV_MA_L4`, line `230KV_MA_MC_L4` |
| BN-Y4 | 230 kV conductor, MD 115 kV (five lines) → QB 115 kV | runs at 115 kV, note |
| BN-Y5 | 230 kV conductor, MA's 500 kV yard picked | **refused**: "MA 500KV is at AC500KV, the line runs at AC230KV: pick its AC230KV yard 230KV" |
| BN-Y6 | MS 115 kV (empty yard) → MD 115 kV | line `115KV_MS_MD_L2` (`L1` is taken by `115KV_MD_MS_L1`, which ends at the site junction of MS), take-off `115KV_MS_L2` at MD; shares the path MD-MS, which runs the other way (two notes) |
| BN-J1, J2 | QA 230 / 500 kV → JX | an open node of its own at JX at the line voltage |
| BN-J3 | QA 115 kV → JQ | a node of its own, not the 115 kV open end there |
| BN-J4 | JX → JQ (both busy) | 0 V, nodes of their own |
| BN-J5 | JP → site junction of MS | 0 V, nodes of their own |
| BN-S1, S2 | QA 230 / 115 kV → site junction of MS | a node of its own beside the 230 kV splice / the 115 kV open end |
| BN-V1 | QA → QB via JX, 230 kV | spliced in a node of its own |
| BN-V2 | via JP, 500 kV | a 500 kV node beside the two 230 kV ones |
| BN-V3 | via the site MS, 115 kV | a node of its own beside the 115 kV open end |
| BN-V4 | via JX, JQ and the site MS, 230 kV | four sections, a node of its own at each; JQ → MS shares the path MS-JQ, which runs the other way (two notes) |
| BN-V5 | via JP, de-energized | a 0 V node of its own |

### 3.3 Route via (`BV-*`, `buildRouteViaPlan`)

The quiet line's circuit is routed via the place. Spliced at a junction: one
new node holding exactly the two parts, at the voltage the circuit runs at;
the line runs on through both parts, its ends kept. Looped into a yard: a new
take-off each way at the yard's voltage, the line split there, the new line
named after the rated voltage. Both parts keep the rated and energized voltage.

| Id | Line | Via | Result |
|---|---|---|---|
| BV-J1 | 230 kV | JX | a 230 kV node beside the 230 kV open end |
| BV-J2 | 500 kV | JX | a 500 kV node beside the 500 kV splice |
| BV-J3 | 230 kV-rated at 115 kV | JX | a 115 kV node beside the 115 kV open end |
| BV-J4 | de-energized | JX | a **0 V** node of its own beside the 0 V open end (its energized voltage) |
| BV-J5 | 115 kV (path shared with the 230 kV-rated one) | JQ | a 115 kV node; the other circuit and the path stay |
| BV-J6 | 500 kV | JP (230 kV only) | a 500 kV node |
| BV-S1, S2 | 230 / 115 kV | site junction of MS | a node of its own at the line's voltage |
| BV-S3 | de-energized | site junction of MS | a 0 V node of its own beside the 0 V open end |
| BV-Y1 | 230 kV | MA 230 kV (four lines) | take-offs at 230 kV, the line split |
| BV-Y2 | 500 kV | MA 500 kV | as BV-Y1 at 500 kV |
| BV-Y3 | 115 kV | MD 115 kV (five lines) | as BV-Y1 at 115 kV |
| BV-Y4 | 230 kV-rated at 115 kV | MA 115 kV | take-offs at 115 kV; the new line `230KV_…` |
| BV-Y5, Y6 | 500 / 230 kV | ME 500 / 230 kV | the yard at its voltage |
| BV-R1 | 230 kV-rated at 115 kV | MA 230 kV | **refused**: "yard MA 230KV: not at AC115KV (the voltage the circuits are energized at)" |
| BV-R2 | 500 kV | MC (230 kV only) | **refused** |
| BV-R3 | de-energized, 230 kV-rated | MB (500 kV only) | **refused**: "yard MB 500KV: beyond the rating of the de-energized … (AC230KV)" |
| BV-R4 | 115 kV | MB (500 kV only) | **refused** |
| BV-Y7 | de-energized | MA 230 kV | **allowed, a warning** "… is de-energized (0 V): entering yard MA 230KV at AC230KV, it stays de-energized; the take-offs are at the yard's voltage"; take-offs `230KV_QA_L1`, `230KV_QB_L1` at 230 kV; both parts stay 0 V |
| BV-Y8 | de-energized, 230 kV-rated | MA 115 kV (below its rating) | allowed, the same warning; take-offs `115KV_QA_L1`, `115KV_QB_L1` at 115 kV |
| BV-C | each quiet line | MA, MB, MC, MD, ME, MS | `yardChoices` offers the yard at the voltage a live circuit runs at: 500 kV at MA, MB, ME; 230 kV at MA, MC, ME, MS; 115 kV and 230 kV-rated at 115 kV at MA, MD, MS; a de-energized (230 kV-rated) one every yard within its rating: 230 and 115 kV at MA, MS; 230 kV at MC, ME; 115 kV at MD; none at MB |

### 3.4 Route to / Route from (`BT-*` / `BF-*`, `buildRouteEndPlan`)

The quiet line's TO end (route to) or FROM end (route from) is moved to the
place on a new straight path: the circuit is spliced at the old end's site
junction (QB / QA, created) with one new section, which keeps the rated and
energized voltage and ends in a new node of its own (a junction) or a new
take-off (a yard); the line now ends (starts) there and takes the section;
the take-off left at the old end is reported.

| Id | Line | Moved to | Result |
|---|---|---|---|
| BT-J1 | 230 kV | JX | a 230 kV node beside the 230 kV open end |
| BT-J2 | 500 kV | JX | a 500 kV node |
| BT-J3 | de-energized | JX | a 0 V node of its own |
| BT-J4 | 230 kV-rated at 115 kV | JQ | a 115 kV node beside the 115 kV open end |
| BT-S1 | 115 kV | site junction of MS | a 115 kV node |
| BT-Y1 | 230 kV | MA 230 kV | a take-off at 230 kV |
| BT-Y2 | 230 kV-rated at 115 kV | MD 115 kV | a take-off at 115 kV |
| BT-Y3 | 500 kV | MB 500 kV | a take-off at 500 kV |
| BT-R1 | 230 kV-rated at 115 kV | MA 230 kV | **refused** ("not at AC115KV") |
| BT-R2 | de-energized, 230 kV-rated | MB 500 kV | **refused** ("beyond the rating of the de-energized …") |
| BT-Y4 | de-energized | MC 230 kV | allowed, the de-energized-entry warning; a take-off `230KV_QA_L1` at 230 kV |
| BF-J1 | 230 kV | from JX | the line now starts at a node of its own there |
| BF-J2 | 500 kV | from JP | a 500 kV node |
| BF-S1 | 230 kV | from the site junction of MS | a 230 kV node |
| BF-Y1 | 115 kV | from MD 115 kV | a take-off at 115 kV |
| BF-Y2 | 500 kV | from ME 500 kV | a take-off at 500 kV |
| BF-R1 | 115 kV | from ME 230 kV | **refused** ("not at AC115KV") |

## 4. Junction and take-off naming, place lists (`web/test/naming.test.ts`) – automated

A new junction left unnamed is named after the site closest to where it is
placed, `<site>_J<n>` (`junctionNaming`, `closestSite`), `n` the first
number no junction of that name or id has; `J<n>` when the network has no
site. Lists of places show a junction name first, sorted with the sites.

| Id | Case | Result |
|---|---|---|
| JN-1 | a network without sites | `J1` (`TJT_J1`), then `J2` |
| JN-2 | near MA, twice; near ME | `MA_J1` (`TJT_MA_J1`), `MA_J2`; `ME_J1` (numbered per site) |
| JN-3 | `TJT_MA_J1` in use by a junction named otherwise; a typed name; no position | `MA_J2`; the typed name kept (`TJT_TAP_X`); `J5` (past J1-J4) |
| JN-4 | a site junction | named after its site: `SV` (`TJT_SV`) |
| JN-5 | splitting the path MA-MB at a new junction near MB | `MB_J1` |
| JN-6 | the circuit place list (`circuitPlaceOptions`) | `JX Junction`, no label starting with "Junction", sites and junctions sorted together |

A take-off's line name carries its yard's voltage (`takeOffLineName`,
`ruleLineName`), also when its circuit runs at another (an auxiliary line).

| Id | Case | Result |
|---|---|---|
| TN-1 | Regenerate a take-off named `115KV_SB_L1` in the 230 kV yard of SF, and `230KV_SD_L1` in the 115 kV yard of SC | `230KV_SB_L1`; `115KV_SD_L1` |
| TN-2 | the line wizard, energized 115 kV at SE (230 kV only) | the auxiliary take-off `230KV_SC_L1`, its circuit at 115 kV; Regenerate leaves it |
| TN-3 | the circuit wizard, the same | `230KV_SC_L1`, its circuit at 115 kV |

## 5. Other map operations (`web/test/operations.test.ts`) – automated

Create circuit, Create path, Form a line, Route via and Route to / from on
the base fixture (a 230 kV conductor unless stated). The expected results are
what the code gives today, to be refined. Every case checks that the result
validates and that what was there and is not part of the operation is left as
it was (`unchangedExcept`); line and take-off names stay unique.

A circuit **created or edited by hand** (the circuit wizard, the circuit
panel) is never refused for its voltages: every mismatch is a **warning**
(an end at another voltage than the circuit is energized at, energized above
or below its rating or at another current type, both ends open yet
energized, an auxiliary take-off); an open end, joining circuits that run at
the same voltage, a de-energized circuit and the path it runs on (shared, or
new beside existing ones) are notes, as in the line wizard. A new take-off
in a yard above the energized voltage, at a site without a yard at it, is
auxiliary: its circuit carries the energized voltage, as the line wizard
makes it. The circuit panel offers every voltage and
shows the same warnings, with a "use …" button per mismatched end. The
operations on existing circuits (Form a line, Route via / to / from) refuse
what would not run. A de-energized circuit may be routed into a yard within
its rating (warned; it stays 0 V, its take-offs at the yard's voltage), and
a node it is spliced in takes its energized voltage, 0 V. A path is shared
whatever its circuits' voltage (0 V included): each leg of a new line says
whether it shares an existing path or gets a new one.

### 5.1 Create circuit (`buildNewCircuitPlan`, `CC-*`)

Each case checks the plan's warnings and notes exactly, the rated and energized
voltage, whether the circuit follows a path the other way, and each end: the
yard and its connection voltage through a new take-off (or the existing one
picked), or the junction and node voltage in a node of its own (or the
existing node joined, the only record allowed to change).

| Id | Case | Current result |
|---|---|---|
| CC-E-1 | SA → SB, default connections | new take-offs at SA 230 kV and SB 230 kV, energized 230 kV; nothing reported |
| CC-E-2 | site junction ST → line junction J2, nodes of their own | 0 V, both nodes at 0 V; notes "the FROM end is open …", "the TO end is open …", "both ends are open: the circuit is de-energized (0 V) until it is connected"; no warning |
| CC-E-3 | SA → SB on the existing path SB → SA | follows the path: FROM SB, TO SA (the plan's `reversed`); note "shares the existing path "SB-SA", which runs SB → SA: the circuit follows its direction (FROM and TO swapped)" |
| CC-O-1 | SC → SD (115 kV only) | energized 115 kV, take-offs at 115 kV; **warning** "energized at AC115KV, below its rated AC230KV …" |
| CC-O-2 | energized 115 kV given, SH (230 + 115 kV) → SC | SH's 115 kV yard by default; below-rating **warning** |
| CC-O-3 | energized 115 kV given, a new take-off picked in SH 230 kV | **allowed**: the take-off in SH 230 kV at 230 kV; **warnings** "the FROM end: SH 230KV · new take-off … is at AC230KV, the circuit is energized at AC115KV", below rating |
| CC-O-4 | energized 115 kV given, new take-off at SE (230 kV only) | an **auxiliary** take-off, as the line wizard makes it: its circuit at 115 kV in the 230 kV yard; **warning** "SE 230KV · new take-off …: its circuit is set to AC115KV, below the yard's AC230KV (a secondary / auxiliary line)", below rating |
| CC-O-5 | energized 115 kV given, SF's free 230 kV take-off toward SB | **allowed**; **warnings** for the FROM take-off at 230 kV, the auxiliary new take-off at SB (230 kV only: its circuit at 115 kV), below rating |
| CC-O-6 | energized 115 kV given, joining node J3_1 whose circuits run at 230 kV | **allowed**, the node stays 230 kV; **warnings** "the FROM end: node J3_1 runs at AC230KV, the circuit is energized at AC115KV", below rating |
| CC-O-7 | SA (230 kV) → SC (115 kV), no energized voltage | energized 230 kV (the FROM yard's); **warning** "the TO end: SC 115KV · new take-off … is at AC115KV, the circuit is energized at AC230KV" |
| CC-O-8a | 115 kV conductor, energized 230 kV given | **allowed**; **warning** "energized at AC230KV, above its rated AC115KV" |
| CC-O-8b | energized DC 300 kV given on an AC 230 kV conductor | **allowed**; **warnings** for both ends at AC230KV, and "AC and DC do not mix" |
| CC-O-9a | both ends open, J1 → J2 | 0 V automatically; notes: the two open ends, de-energized; no warning |
| CC-O-9b | both ends open, energized 230 kV given | 230 kV, nodes at 230 kV; **warning** "both ends are open, yet it is energized at AC230KV: nothing feeds it …"; open-end notes |
| CC-O-9c | both ends open, 0 V given | 0 V; notes: the open ends, "de-energized (0 V)" |
| CC-O-10 | one end open, SA → J2 | 230 kV, the node at 230 kV; note "the TO end is open …" (as in the line wizard) |
| CC-O-11 | joining node J3_1 whose circuits run at 230 kV, other end SB | notes "the FROM end joins … at node J3_1, all at AC230KV" and "shares the existing path "J3-SB""; no warning |

### 5.2 Create path (`buildNewPathPlan`, `CP-*`)

The New path panel's rules, in `newPath.ts` (the panel uses it). No
voltages: a path is not voltage specific, and circuits of any voltage,
energized or not, may share it.

| Id | Case | Result |
|---|---|---|
| CP-1 | SA → SB, SA's 230 kV yard → J1, J1 → J2, ST's site junction → SB | `SA-SB` (`TPA_SA_SB`), `SA-J1`, `J1-J2`, `ST-SB`: a yard and a site junction stand for their site; no waypoints, no voltage |
| CP-2 | ST and its site junction; SA and its yard; one end missing | **refused**: "both ends are the same place"; "pick both ends" |
| CP-3 | a path SA-SB exists | listed (also for SB → SA); the new one `SA-SB (2)` (`TPA_SA_SB_2`); the other way round `SB-SA` |
| CP-4 | swapped ends, SB → J1 | `SB-J1`, FROM SB, TO J1 |
| CP-5 | a typed id / name | a free id is used, the name kept; an id in use or invalid: **refused** |

### 5.3 Form a line (`formLine`, `FL-*`)

Circuits made by the circuit wizard (no line). Each case checks the pairs of
ends offered exactly (by ends and number of sections), their voltage or
refusal; a pair formed as the panel forms it (its rule name,
`formedLineVoltageOps`) gives a line at that voltage, its sections energized
at it, the junction nodes along it set to it, named after the rated voltage,
contiguous.

| Id | Case | Result |
|---|---|---|
| FL-1 | SA → J3 → SB, 230 kV | offered: SA → J3 (1 section), SA → SB (2), at 230 kV; SA → SB formed: the J3 node at 230 kV |
| FL-2 | 230 kV-rated sections SC → J4 → SD (115 kV yards) | offered at 115 kV; formed: line, sections and the J4 node at 115 kV, the line named `230KV_SC_SD_L1` |
| FL-3 | SA (230 kV) → J3 → SC (115 kV), made by hand | SA → SC **refused**: "the ends are at different voltages: AC230KV (SA_230KV) and AC115KV (SC_115KV)"; SA → J3 offered at 230 kV |
| FL-4 | yard → an open junction end (SA → J3) | formed at 230 kV, the line ending at J3 |
| FL-5 | the second section rated 115 kV | SA → SB **refused**: "AC230KV is beyond the rating of section … (AC115KV)" |
| FL-6 | J1 → J2, both ends open | offered and formed at **0 V**: line and section de-energized |
| FL-7 | a circuit tied in at the J3 node of the 230 kV line SA → J3 → SB | to J4 (open): J3 → J4, SA → J4, SB → J4 offered at 230 kV; to SC (energized 115 kV): every pair **refused** "the ends are at different voltages" |
| FL-8 | SA → SB again after it was formed | **refused**: "already line …" |

### 5.4 Route via (`buildRouteViaPlan`, `RV-*`)

Also at the busy places, section 3.3. On a line SA → SB at 230 kV made by the line wizard; checked as there (`verifyRouteVia`), with the plan's notes exactly:

| Id | Case | Current result |
|---|---|---|
| RV-1 | via J3 | a node at J3 at 230 kV joining the two parts, both at 230 kV; nothing reported; the circuit panel notes "joins … all at AC230KV" |
| RV-2 | via site SV | SV's site junction created; as RV-1 |
| RV-3 | into SH 230 kV (loop in) | take-offs `230KV_SA_L1` and `230KV_SB_L1` in SH 230 kV, at 230 kV; the line split at SH |
| RV-4 | 230 kV-rated circuits at 115 kV (SC → SD), yards at SH | 115KV offered; 230KV not: "not at AC115KV (the voltage the circuits are energized at)" |
| RV-5 | circuits at 230 and 115 kV checked | no yard offered: "the checked circuits run at different voltages (AC230KV, AC115KV)" |
| RV-6 | de-energized (0 V), yards at SH | both yards offered (within its 230 kV rating); looped into SH 230 kV: **a warning** "… is de-energized (0 V): entering yard SH 230KV at AC230KV, it stays de-energized; …", take-offs `230KV_SA_L1`, `230KV_SB_L1` at 230 kV, the parts at 0 V |
| RV-7 | de-energized, via J3 | the parts stay at 0 V; the node at **0 V** (its energized voltage, `nodeVoltage`) |
| RV-8 | the first part on an existing path J3-SA, running the other way | it runs on J3-SA, following its direction (FROM and TO swap); note "path J3-SA runs … follow its direction (FROM and TO swap)" |

### 5.5 Route to / Route from (`buildRouteEndPlan`, `RT-*` / `RF-*`)

Also at the busy places, section 3.4 (`verifyRouteEnd`, the plan's notes exactly). On the same line; route from mirrors route to at the FROM end. The plan's
"warnings" are notes for the confirmation.

| Id | Case | Current result |
|---|---|---|
| RT-1 | to J2 | the circuit spliced at SB's junction (created) and run out to a node of its own at J2, all at 230 kV; the line now ends at J2; "take-off 230KV_SA_L1 (SB 230KV) is left without a circuit (kept)" |
| RF-1 | from J1 | the mirror: spliced at SA's junction, a node at J1 at 230 kV; SA's take-off `230KV_SB_L1` left free |
| RT-2 | to site SS | SS's site junction created; as RT-1 |
| RT-3 | to SH 230 kV | a new take-off `230KV_SA_L1` in SH 230 kV at 230 kV; the line now ends there; SB's take-off left free |
| RT-4 | 230 kV-rated circuits at 115 kV (SC → SD), to SH | to SH 230 kV **refused**: "yard SH 230KV: not at AC115KV (…)"; to SH 115 kV: a take-off `115KV_SC_L1` at 115 kV |
| RT-5 | to SS over existing paths SB → J4 and SS → J4 | two sections spliced in a node of their own at J4; the second follows SS-J4 (FROM and TO swap, a note); the line ends at SS's junction |
| RT-6 | a take-off left without a circuit at the old end | reported, kept; removed on request with every connection that held it (the plan lists it as removed, no note) |
| RT-7 | de-energized (0 V) | to SH 230 kV allowed, the de-energized-entry warning, a take-off at 230 kV; to J2: sections and the new nodes at 0 V |
| RT-8 | the line SA → J3 → SB, routed at J3 to J4 | spliced at J3 in a new node; the line now ends at J4, the section J3-SB dropped from it (in no line now, a note) |
