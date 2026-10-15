# Dota Maps Data

`@reino-doce/dota-maps-data` owns the versioned Dota 2 map datasets, their
generation tools, and the shared calculations that interpret those datasets.
The application consumes committed data; scans and imports are explicit
maintenance operations.

## Install and import

Initialize the application submodules before installing the workspace:

    git submodule update --init --recursive
    npm ci

Install the library runtime and generation tools with:

    npm install @reino-doce/dota-maps-data

Consumers that need only prebuilt map data can install one dependency-free patch package:

    npm install @reino-doce/dota-maps-data-741f
    npm install @reino-doce/dota-maps-data-latest

The stable latest package is rebuilt from the patch selected by currentPatch in package.json. It contains map data and essential overview images, but no generation tools, runtime dependencies, or terrain skins.

Use the stable import paths by installing the latest data package under the base package name:

    npm install @reino-doce/dota-maps-data@npm:@reino-doce/dota-maps-data-latest

Then import the map data and standard map image:

    import mapdata from '@reino-doce/dota-maps-data/latest/mapdata.json' with { type: 'json' };
    import mapImage from '@reino-doce/dota-maps-data/latest/dota-map.png';

A patch-specific package can be installed under the same base name. Its exports include both the stable `latest` path and the patch ID path:

    npm install @reino-doce/dota-maps-data@npm:@reino-doce/dota-maps-data-700
    import mapdata from '@reino-doce/dota-maps-data/700/mapdata.json' with { type: 'json' };

Terrain skins are optional image-only packages. Install the selected patch data and only the skin image the application needs:

    npm install @reino-doce/dota-maps-data@npm:@reino-doce/dota-maps-data-latest
    npm install @reino-doce/dota-map-skin-autumn
    import autumn from '@reino-doce/dota-maps-data/images/latest/autumn';

Patch-specific aliases expose the equivalent `@reino-doce/dota-maps-data/images/<patch>/<skin>` import path, such as `/images/741f/autumn`. That subpath is a small re-export wrapper; the PNG remains in the independently installable skin package, so install the matching `@reino-doce/dota-map-skin-<skin>` package as shown. Alternatively, import the PNG directly from that skin package. The source workspace also exposes `@reino-doce/dota-maps-data/latest/<skin>/<image>` and the Node entry point can resolve it with `resolveAssetPath()`.

Existing consumers of the stable latest package do not change automatically. Run npm update @reino-doce/dota-maps-data-latest, or update the alias target in package.json, to receive newer map data. Consumers of a patch-specific package remain on that patch until they change dependencies.

The repository can also be installed independently:

    npm ci
    npm run build
    npm test

The runtime package exports pure calculations from its root entry, installed-game readers from @reino-doce/dota-maps-data/node, the prebuilt vision simulator from @reino-doce/dota-maps-data/vision, and the full patch and asset inventory from /manifest.json. Its Node asset reader can use an installed version package when a patch is absent from the local source tree.

Patch directories retain the existing assets/data/<patch>/ layout. Data files carry source hashes and capture provenance where the importer can establish them. manifest.json records the shipped patch directories and every committed map asset hash.

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

Before a registry release, run `npm ci`, `npm run manifest`, `npm run build`,
`npm test`, `npm run packages:prepare`, and `npm run packages:verify`. The CI
workflow dry-runs publication for the runtime package, every patch package, and
the stable latest package. Publish from the generated directories so each
consumer downloads only its selected data:

```sh
npm publish --access public ./npm-packages/core
for package in npm-packages/dota-map*; do
    npm publish --access public "./$package"
done
```

Increase the library package version before publishing changed contents under
existing package names. A new game patch gets a new version-specific package;
the latest package is regenerated from the `currentPatch` configured in
`package.json` and published with the new semver version.
