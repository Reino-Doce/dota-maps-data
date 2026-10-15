# Dota Maps Data

`@reino-doce/dota-maps-data` owns the versioned Dota 2 map datasets, their
generation tools, and the shared calculations that interpret those datasets.
The application consumes committed data; scans and imports are explicit
maintenance operations.

## Install and import

To work on this standalone repository, install its development dependencies
from the repository root with `npm ci`.

The `@reino-doce/dota-maps-data` registry package contains the extractors,
runtime rules, and package publisher. It does not bundle every version's map
assets. Install it only when you need those tools:

    npm install @reino-doce/dota-maps-data

Each prebuilt patch is a separate lightweight data package:

    npm install @reino-doce/dota-maps-data-741f
    npm install @reino-doce/dota-maps-data-latest

The stable latest package is rebuilt from `currentPatch` in `package.json`. It
contains map data and essential overview images, but no generation tools,
runtime dependencies, or terrain skins. Consumers that need only map data can
install one patch package or the stable latest package; neither installs the
extractor system.

The data package can be aliased to the import namespace so the requested patch
paths remain stable:

    npm install @reino-doce/dota-maps-data@npm:@reino-doce/dota-maps-data-latest

Then import the map data and standard map image:

    import mapdata from '@reino-doce/dota-maps-data/latest/mapdata.json' with { type: 'json' };
    import mapImage from '@reino-doce/dota-maps-data/latest/dota-map.png';

A patch-specific package can be installed under the same namespace. Its exports
include both the stable `latest` path and the patch ID path:

    npm install @reino-doce/dota-maps-data@npm:@reino-doce/dota-maps-data-700
    import mapdata from '@reino-doce/dota-maps-data/700/mapdata.json' with { type: 'json' };

Terrain skins are separate image-only packages. Install the selected patch data
and only the skin image the application needs:

    npm install @reino-doce/dota-maps-data@npm:@reino-doce/dota-maps-data-latest
    npm install @reino-doce/dota-map-skin-741f-autumn
    import autumn from '@reino-doce/dota-maps-data/images/latest/autumn';

The `/images/<patch>/<skin>` and `/images/latest/<skin>` subpaths are small
re-export wrappers; the PNG remains in its independently installable package.
Each patch has its own skin set, based on the skins actually generated for that
patch. For all skins in one import, install the matching aggregate package and
import the default object or named skins from `/images/<patch>`:

    npm install @reino-doce/dota-map-skins-741f
    import skins, { autumn, winter } from '@reino-doce/dota-maps-data/images/741f';

For the current patch, `@reino-doce/dota-map-skins-latest` pairs with
`/images/latest`. Aggregate packages depend on all individual skin packages
for that patch; the map-data package itself has no skin dependencies. The
source workspace also exposes image files under `@reino-doce/dota-maps-data/latest/<skin>/<image>` and the Node entry point can resolve them with `resolveAssetPath()`.

If an application needs both the extractor tools and the map namespace alias,
install the extractor under a second npm alias so npm does not replace the
namespace package:

    npm install @reino-doce/dota-maps-extractor@npm:@reino-doce/dota-maps-data

Existing consumers of the stable latest package do not change automatically. Run npm update @reino-doce/dota-maps-data-latest, or update the alias target in package.json, to receive newer map data. Consumers of a patch-specific package remain on that patch until they change dependencies.

The repository can also be installed independently:

    npm ci
    npm run build
    npm test

The runtime package exports pure calculations from its root entry, installed-game readers and callable map extractors from `@reino-doce/dota-maps-data/node`, the prebuilt vision simulator from `@reino-doce/dota-maps-data/vision`, and the full patch and asset inventory from `@reino-doce/dota-maps-data/manifest.json`. The Node entry also exports `buildNpmPackagePlan()` and `prepareNpmPackages()` for package publishing. Its asset reader can use an installed version package when a patch is absent from the local source tree.

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
workflow dry-runs publication for the runtime package, every patch package,
the latest alias, every individual skin, and each aggregate skin package.
Publish individual skin packages before their aggregate packages, and publish
the data packages independently:

```sh
npm publish --access public ./npm-packages/core
for package in npm-packages/dota-maps-data-*; do
    npm publish --access public "./$package"
done
for package in npm-packages/dota-map-skin-*; do
    npm publish --access public "./$package"
done
for package in npm-packages/dota-map-skins-*; do
    npm publish --access public "./$package"
done
```

Increase the library package version before publishing changed contents under
existing package names. A new game patch gets a new version-specific package;
the latest package is regenerated from the `currentPatch` configured in
`package.json` and published with the new semver version.
