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
| LC-O-3d | energized 115 kV given at SE (230 kV only) | an auxiliary take-off at SE 230 kV whose circuit is at 115 kV, named `115KV_SC_L<n>`; **note** "… new take-offs there carry AC115KV on their circuit (a secondary / auxiliary line)"; below-rating note |
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
| BN-Y2 | a fourth line MA 230 kV → MC 230 kV | the direct path MA-MC carries the de-energized line: **refused** until the leg is chosen ("path "MA-MC" already exists but carries 0V circuits; choose …"); on a new path: take-offs `230KV_MC_L4` / `230KV_MA_L4`, line `230KV_MA_MC_L4` |
| BN-Y3 | the same, sharing MA-MC | allowed; note "path "MA-MC" carries 0V circuits: the new AC230KV sections will share its route" – **open question**: should a de-energized circuit count as another voltage for sharing a path? |
| BN-Y4 | 230 kV conductor, MD 115 kV (five lines) → QB 115 kV | runs at 115 kV, note |
| BN-Y5 | 230 kV conductor, MA's 500 kV yard picked | **refused**: "MA 500KV is at AC500KV, the line runs at AC230KV: pick its AC230KV yard 230KV" |
| BN-Y6 | MS 115 kV (empty yard) → MD 115 kV | line `115KV_MS_MD_L2` (`L1` is taken by `115KV_MD_MS_L1`, which ends at the site junction of MS), take-off `115KV_MS_L2` at MD; reuses the path MD-MS, which runs the other way (note) |
| BN-J1, J2 | QA 230 / 500 kV → JX | an open node of its own at JX at the line voltage |
| BN-J3 | QA 115 kV → JQ | a node of its own, not the 115 kV open end there |
| BN-J4 | JX → JQ (both busy) | 0 V, nodes of their own |
| BN-J5 | JP → site junction of MS | 0 V, nodes of their own |
| BN-S1, S2 | QA 230 / 115 kV → site junction of MS | a node of its own beside the 230 kV splice / the 115 kV open end |
| BN-V1 | QA → QB via JX, 230 kV | spliced in a node of its own |
| BN-V2 | via JP, 500 kV | a 500 kV node beside the two 230 kV ones |
| BN-V3 | via the site MS, 115 kV | a node of its own beside the 115 kV open end |
| BN-V4 | via JX, JQ and the site MS, 230 kV | four sections, a node of its own at each; JQ → MS reuses the path MS-JQ the other way (note) |
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
| BV-J4 | de-energized | JX | the node at the rated **230 kV** – **open question** (as RV-7): 0 V? |
| BV-J5 | 115 kV (path shared with the 230 kV-rated one) | JQ | a 115 kV node; the other circuit and the path stay |
| BV-J6 | 500 kV | JP (230 kV only) | a 500 kV node |
| BV-S1, S2 | 230 / 115 kV | site junction of MS | a node of its own at the line's voltage |
| BV-S3 | de-energized | site junction of MS | at the rated 230 kV, beside the 0 V open end (open question) |
| BV-Y1 | 230 kV | MA 230 kV (four lines) | take-offs at 230 kV, the line split |
| BV-Y2 | 500 kV | MA 500 kV | as BV-Y1 at 500 kV |
| BV-Y3 | 115 kV | MD 115 kV (five lines) | as BV-Y1 at 115 kV |
| BV-Y4 | 230 kV-rated at 115 kV | MA 115 kV | take-offs at 115 kV; the new line `230KV_…` |
| BV-Y5, Y6 | 500 / 230 kV | ME 500 / 230 kV | the yard at its voltage |
| BV-R1 | 230 kV-rated at 115 kV | MA 230 kV | **refused**: "yard MA 230KV: not at AC115KV (the voltage the circuits are energized at)" |
| BV-R2 | 500 kV | MC (230 kV only) | **refused** |
| BV-R3 | de-energized | MA 230 kV | **refused** ("not at 0V") – open question (as RV-6) |
| BV-R4 | 115 kV | MB (500 kV only) | **refused** |
| BV-C | each quiet line | MA, MB, MC, MD, ME, MS | `yardChoices` offers only the yard at the voltage it runs at: 500 kV at MA, MB, ME; 230 kV at MA, MC, ME, MS; 115 kV and 230 kV-rated at 115 kV at MA, MD, MS; de-energized nowhere |

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
| BT-J3 | de-energized | JX | the node at the rated 230 kV (open question, as RV-7) |
| BT-J4 | 230 kV-rated at 115 kV | JQ | a 115 kV node beside the 115 kV open end |
| BT-S1 | 115 kV | site junction of MS | a 115 kV node |
| BT-Y1 | 230 kV | MA 230 kV | a take-off at 230 kV |
| BT-Y2 | 230 kV-rated at 115 kV | MD 115 kV | a take-off at 115 kV |
| BT-Y3 | 500 kV | MB 500 kV | a take-off at 500 kV |
| BT-R1 | 230 kV-rated at 115 kV | MA 230 kV | **refused** ("not at AC115KV") |
| BT-R2 | de-energized | MC 230 kV | **refused** ("not at 0V", open question) |
| BF-J1 | 230 kV | from JX | the line now starts at a node of its own there |
| BF-J2 | 500 kV | from JP | a 500 kV node |
| BF-S1 | 230 kV | from the site junction of MS | a 230 kV node |
| BF-Y1 | 115 kV | from MD 115 kV | a take-off at 115 kV |
| BF-Y2 | 500 kV | from ME 500 kV | a take-off at 500 kV |
| BF-R1 | 115 kV | from ME 230 kV | **refused** ("not at AC115KV") |

## 4. Drafted cases (not automated yet)

The results below are what the code gives today, probed on the fixture (a
230 kV conductor unless stated); the expected results are still to be refined.

A circuit **created or edited by hand** (the circuit wizard, the circuit
panel) is never refused for its voltages: every mismatch is a **warning**
(an end at another voltage than the circuit is energized at, energized above
or below its rating or at another current type, an open end, both ends open
yet energized); joining circuits that run at the same voltage and a
de-energized circuit are notes. The circuit panel offers every voltage and
shows the same warnings, with a "use …" button per mismatched end. The
operations on existing circuits (Form a line, Route via / to / from) refuse
what would not run.

### 4.1 Create circuit (`buildNewCircuitPlan`, `CC-*`)

| Id | Case | Current result |
|---|---|---|
| CC-E-1 | SA → SB, default connections | new take-offs at SA 230 kV and SB 230 kV, energized 230 kV; nothing reported |
| CC-E-2 | site junction ST → line junction J2, nodes of their own | 0 V, both nodes at 0 V; **warnings** "the FROM end is open …", "the TO end is open …"; note "both ends are open: the circuit is de-energized (0 V) until it is connected" |
| CC-E-3 | SA → SB on the existing path SB → SA | follows the path: FROM SB, TO SA (the plan's `reversed`); nothing reported |
| CC-O-1 | SC → SD (115 kV only) | energized 115 kV, take-offs at 115 kV; **warning** "energized at AC115KV, below its rated AC230KV …" |
| CC-O-2 | energized 115 kV given, SH (230 + 115 kV) → SC | SH's 115 kV yard by default; below-rating **warning** |
| CC-O-3 | energized 115 kV given, a new take-off picked in SH 230 kV | **allowed**: the take-off in SH 230 kV at 230 kV; **warnings** "the FROM end: SH 230KV · new take-off … is at AC230KV, the circuit is energized at AC115KV", below rating |
| CC-O-4 | energized 115 kV given, new take-off at SE (230 kV only) | **allowed**: the take-off at SE 230 kV stays at 230 kV (by hand no auxiliary voltage is set; the line wizard sets one); end and below-rating **warnings** |
| CC-O-5 | energized 115 kV given, SF's free 230 kV take-off toward SB | **allowed**; **warnings** for the FROM take-off at 230 kV, the TO take-off at 230 kV, below rating |
| CC-O-6 | energized 115 kV given, joining node J3_1 whose circuits run at 230 kV | **allowed**, the node stays 230 kV; **warnings** "the FROM end: node J3_1 runs at AC230KV, the circuit is energized at AC115KV", below rating |
| CC-O-7 | SA (230 kV) → SC (115 kV), no energized voltage | energized 230 kV (the FROM yard's); **warning** "the TO end: SC 115KV · new take-off … is at AC115KV, the circuit is energized at AC230KV" |
| CC-O-8a | 115 kV conductor, energized 230 kV given | **allowed**; **warning** "energized at AC230KV, above its rated AC115KV" |
| CC-O-8b | energized DC 300 kV given on an AC 230 kV conductor | **allowed**; **warnings** for both ends at AC230KV, and "AC and DC do not mix" |
| CC-O-9a | both ends open, J1 → J2 | 0 V automatically; two open-end **warnings**; the de-energized note |
| CC-O-9b | both ends open, energized 230 kV given | 230 kV, nodes at 230 kV; open-end **warnings** and "both ends are open, yet it is energized at AC230KV: nothing feeds it …" |
| CC-O-9c | both ends open, 0 V given | 0 V; open-end **warnings**; note "de-energized (0 V)" |
| CC-O-10 | one end open, SA → J2 | 230 kV, the node at 230 kV; **warning** "the TO end is open …" (the line wizard only notes an open end) |
| CC-O-11 | joining node J3_1 whose circuits run at 230 kV, other end SB | note "the FROM end joins … at node J3_1, all at AC230KV"; no warning |

### 4.2 Create path (`NewPathPanel`, `CP-*`)

No voltages: a path is not voltage specific, and circuits of any voltage,
energized or not, may share it.

| Id | Case | Current result |
|---|---|---|
| CP-1 | site → site, site → line junction, junction → junction | the path with its ends, rule name `<from>-<to>` (numbered), no circuits |
| CP-2 | both ends the same place (a site and its junction count as one) | ⚠ "Both ends are the same place."; Create disabled |
| CP-3 | a path already runs between the places | ⚠ listed "Already between these ends" (a duplicate unless it gets its own waypoints); Create allowed |
| CP-4 | swap from / to before creating | the ends exchange |

### 4.3 Form a line (`formLine`, `FL-*`)

Circuits made by the circuit wizard (no line), offered pairs of ends:

| Id | Case | Current result |
|---|---|---|
| FL-1 | SA → J3 → SB, 230 kV | offered: SA → J3 (1 section) and SA → SB (2 sections), at 230 kV |
| FL-2 | 230 kV-rated sections SC → J4 → SD (115 kV yards) | offered at 115 kV (the hint notes running below the rating) |
| FL-3 | SA (230 kV) → J3 → SC (115 kV), made by hand (warned then) | SA → SC **refused**: "the ends are at different voltages: AC230KV (SA_230KV) and AC115KV (SC_115KV)"; SA → J3 offered at 230 kV |
| FL-4 | yard → an open junction end (SA → J3) | offered at the yard's 230 kV |
| FL-5 | SA → J3 → SB at 230 kV, the second section rated 115 kV | SA → SB **refused**: "AC230KV is beyond the rating of section … (AC115KV)" |
| FL-6 | J1 → J2, both ends open | offered at **0 V** |
| FL-7 | a junction end tied in to live circuits (J3_1, 230 kV) | J3 → SB and J3 → J4: offered at 230 kV (through to SA / SB too); J3 → SC (115 kV): **refused** "the ends are at different voltages: AC230KV (…) and AC115KV (SC_115KV)" |
| FL-8 | SA → SB again after it was formed | **refused**: "already line …" (also "within line …", "would contain line …") |

### 4.4 Route via (`buildRouteViaPlan`, `RV-*`)

Automated at the busy places in section 3.3. On a line SA → SB at 230 kV made by the line wizard:

| Id | Case | Current result |
|---|---|---|
| RV-1 | via J3 | a node at J3 at 230 kV joining the two parts, both at 230 kV; nothing reported; the circuit panel notes "joins … all at AC230KV" |
| RV-2 | via site SV | SV's site junction created; as RV-1 |
| RV-3 | into SH 230 kV (loop in) | take-offs `230KV_SA_L1` and `230KV_SB_L1` in SH 230 kV, at 230 kV; the line split at SH |
| RV-4 | 230 kV-rated circuits at 115 kV (SC → SD), yards at SH | 115KV offered; 230KV not: "not at AC115KV (the voltage the circuits are energized at)" |
| RV-5 | circuits at 230 and 115 kV checked | no yard offered: "the checked circuits run at different voltages (AC230KV, AC115KV)" |
| RV-6 | de-energized (0 V), yards at SH | no yard offered: "not at 0V …" – **open question**: should a de-energized circuit loop into a yard at any voltage? |
| RV-7 | de-energized, via J3 | the parts stay at 0 V; the node gets **AC230KV** (the rated voltage, `nodeVoltage`) – **open question**: the line wizard and Form a line give a de-energized line's nodes 0 V |
| RV-8 | either part on an existing path running the other way | not probed (the circuits on it follow its direction, a note in the confirmation) |

### 4.5 Route to / Route from (`buildRouteEndPlan`, `RT-*` / `RF-*`)

Automated at the busy places in section 3.4. On the same line; route from mirrors route to at the FROM end. The plan's
"warnings" are notes for the confirmation.

| Id | Case | Current result |
|---|---|---|
| RT-1 | to J2 | the circuit spliced at SB's junction (created) and run out to a node of its own at J2, all at 230 kV; the line now ends at J2; "take-off 230KV_SA_L1 (SB 230KV) is left without a circuit (kept)" |
| RF-1 | from J1 | the mirror: spliced at SA's junction, a node at J1 at 230 kV; SA's take-off `230KV_SB_L1` left free |
| RT-2 | to site SS | SS's site junction created; as RT-1 |
| RT-3 | to SH 230 kV | a new take-off `230KV_SA_L1` in SH 230 kV at 230 kV; the line now ends there; SB's take-off left free |
| RT-4 | 230 kV-rated circuits at 115 kV (SC → SD), to SH | to SH 230 kV **refused**: "yard SH 230KV: not at AC115KV (…)"; to SH 115 kV: a take-off `115KV_SC_L1` at 115 kV |
| RT-5 | over existing paths through line junctions (multi-hop) | not probed |
| RT-6 | a take-off left without a circuit at the old end | reported (kept); removed on request |
| RT-7 | de-energized (0 V) | to a yard **refused** ("not at 0V …", as RV-6); to J2: sections at 0 V, the new nodes at **AC230KV** (rated, as RV-7) |
| RT-8 | lines through the circuits | they now end at the new place (RT-1, RT-3) |
