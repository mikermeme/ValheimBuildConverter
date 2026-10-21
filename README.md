# Valheim Build File Converter v3

One HTML file, no server: **`converter-v3.html`** (build it with `python build3.py`). Open it in a browser and drop files on it.

| Input | Output |
|---|---|
| `.rewind` | `.rewind` |
| `.blueprint` (Infinity Hammer; PlanBuild accepted as input only) | `.blueprint` (Infinity Hammer, with ZDO data blocks) |
| `.vbuild` | CSV bundle (meta / zdos / items) |
| CSV bundle | |
| **1.0 world chunks** (`.chunks` + `.chunk` files, or a whole world folder) — read-only: pick a region, export it | |

## What is new compared with v2
* **One name source.** The catalog (`..\ZdoCatalog\out\catalog.json`, Valheim 1.0.20) is embedded: 20k+ names with roles, prefab -> component lists, spawn keys, mod keys. No more fetching `master_hash_lookup.json`
  (that fetch fails on `file://` in Chrome) and no more mangled `Class_field` names — CSV columns now show `Class.field`.
* **Field-level inspector** (Overview / Fields / Unknown tabs): every field with name, type, role, object count, sample value, and — for `Type.field` override keys — whether the prefab actually has that component
  (**valid**), or not (**foreign**: the game never applies it).
* **Unknown hashes**: type the name (rejected unless it hashes to the same value), or press *Solve unknown hashes* (tries `Type.field` for every type × every known field name, ~2 s). Names you add are remembered in this browser (localStorage)
  and can be exported/imported as a small `.json`.
* **Clean up on export** (never silent, everything removed is in the loss report): server stamps, internal timestamps, transient values, inert fields, and overrides for components the prefab doesn't have (plus the `HasFields` switches
  that become pointless). Defaults: on for blueprint and CSV, off for `.rewind`.
* **World chunks**: choose a region (circle, rectangle, or click a chunk row), only the touched chunk files are read. Chunk ZDOs get fresh ids (user 0, id = list position), euler rotations become quaternions
  (half-degree precision), connection data is reported as dropped.
* Same self-checks as v2 (every export is re-parsed).

## Layout
```
Build File Converter 3\
  build3.py            assemble converter-v3.html (copies the two v2 codec files into .\vendor on first run)
  vendor\              codecs.js, codecs-ext.js   — the v2 codecs, UNMODIFIED
  src\bfc-catalog.js   catalog layer (names, roles, override classification, unknown-hash solver)
  src\bfc-chunks.js    chunk meta/reader/writer + chunk -> IR conversion
  src\bfc-items.js     container inventories (byte array / base64, versions 106-110) <-> items.csv rows
  src\app3.js          UI wiring
  src\app3-shell.html  page shell + CSS
  tests\               node tests (see below)
```
Rebuild after the catalog changes: `python ..\ZdoCatalog\run_all.py` then `python build3.py`.
You can also drop a newer `catalog.json` onto the page without rebuilding.

## Tests
```
node tests\run-all.js          # everything
npm install jsdom              # once, to enable the UI test (otherwise it is skipped)
```
`test-catalog.js` (catalog layer vs. independent Python numbers), `test-chunks.js` (chunk reader/writer: byte-identical round trip),
`test-roundtrip.js` (rewind -> rewind byte-identical; every variable survives rewind -> blueprint / CSV), `test-ui.js` (drives the page with real samples).
Tests look for samples in `..\ZdoCatalog` and `..\ZdoCatalog\samples` (e18eich / e18plac / e18Tip + .blueprint, cHQ_may29, `_main_211.chunks` + the three chunk files) and skip what they cannot find.
Pass `--samples DIR`, `--catalog FILE`, `--vendor DIR` to override.

## Known limits
* **Container inventories in the CSV** (fixed 2026-10-19): Valheim 1.0 stores a container's `items` as a **byte array**, written in the compact **version 110** format (v2 only looked for a base64 string in the v106 layout, so `items.csv` came out empty).
  `src\bfc-items.js` reads every inventory version (106/107 legacy, 108–110 compact), lists the items in `items.csv`, and writes them back as a v110 byte array. Empty chests stay empty chests.
  Item stands, armor stands and dropped items keep one item per slot as `<slot>_itemData` / `itemData` byte arrays (version byte + compact record); these are preserved exactly but are still shown as raw bytes in `zdos.csv`, not as rows in `items.csv`.
* Chunk worlds are read-only; the chunk *writer* exists (`bfc-chunks.js` / `ZdoCatalog\chunk_writer.py`, byte-exact) but is not wired to any UI yet.
* Editing (bulk operations, item data, diff, map, loot) is v4 — see `ZdoCatalog\PROJECT_HANDOFF.md` section 9. When override fields are added by the editor it must also set `HasFields` and `HasFields<Type>`.
* PlanBuild blueprints are accepted as input only; they carry only `additionalInfo`, so there are no custom fields in them.
