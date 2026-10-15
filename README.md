# Dota Maps Data

`@reino-doce/dota-maps-data` owns the versioned Dota 2 map datasets, their
generation tools, and the shared calculations that interpret those datasets.
The application consumes committed data; scans and imports are explicit
maintenance operations.

## Install

Initialize the application submodules before installing dependencies:

```sh
git submodule update --init --recursive
npm ci
```

This repository can also be installed on its own:

```sh
npm ci
npm run build
npm test
```

## Data and runtime imports

The package exports pure runtime functions from its root entry, installed-game
readers from `@reino-doce/dota-maps-data/node`, the prebuilt vision simulator
from `@reino-doce/dota-maps-data/vision`, datasets from `/data/*`, images from
`/image/*`, and the patch/file inventory from `/manifest.json`.

Patch directories retain the existing `assets/data/<patch>/` layout. Data files
carry source hashes and capture provenance where the importer can establish
them. `manifest.json` records the shipped patch directories and every committed
map asset hash.

## Generate map data

Run the maintenance commands from this repository. Importers take a patch ID
as a positional argument and accept prepared source paths as documented below;
paths to source inputs are resolved from the calling directory. Generated map
assets always go into this repository. Terrain scans, dedicated-server
Eyes/tree captures, Workshop Tools exports, and Source 2 Viewer extraction
require the corresponding installed tools. Temporary scan and capture files
stay under the ignored `map-captures/` directory.

Refresh prepared patch inputs in dependency order:

```sh
npm run import:terrain -- 741f
npm run import:structures -- 741f --resource-tool <Source2Viewer-CLI>
npm run import:wards -- 741f [extracted-dota.gnv]
npm run import:eyes -- 741f
npm run import:watchers -- 741f --resource-tool <Source2Viewer-CLI>
npm run import:building-vision -- 741f --resource-tool <Source2Viewer-CLI>
npm run import:live-trees -- 741f
npm run manifest
npm test
```

An import writes only to the selected library patch directory. It rejects stale,
incomplete, or mismatched inputs and will not silently reuse another patch's
data. Overview and screenshot imports accept explicit prepared input paths, for
example `npm run import:overview -- 741f ./overview.txt` and
`npm run import:screenshot -- 741f ./map.jpg`. Terrain skin capture and
registration use `npm run map:skins -- <action>`.

## Independent history

Commit and push validated library changes first. Then update the parent
application's submodule pointer in a separate application commit. Never include
machine-specific identity configuration or raw game captures in either Git
history.
