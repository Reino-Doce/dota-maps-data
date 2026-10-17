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

    npm install @reino-doce/dota-maps-data-741
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
    import mapImage from '@reino-doce/dota-maps-data/latest/illustrated.jpg';

A patch-specific package can be installed under the same namespace. Its exports
include both the stable `latest` path and the patch ID path:

    npm install @reino-doce/dota-maps-data@npm:@reino-doce/dota-maps-data-700
    import mapdata from '@reino-doce/dota-maps-data/700/mapdata.json' with { type: 'json' };
    import worlddata from '@reino-doce/dota-maps-data/700/worlddata.json' with { type: 'json' };

Every version package includes its own `worlddata.json` coordinate bounds with
its map data. Consumers can use the package without installing the extractor
or depending on a shared legacy dataset. The `latest` alias also exports
`latest/worlddata.json`.

Terrain skins are separate image-only packages. Install the selected patch data
and only the skin image the application needs:

    npm install @reino-doce/dota-maps-data@npm:@reino-doce/dota-maps-data-latest
    npm install @reino-doce/dota-map-skin-741-autumn
    import autumn from '@reino-doce/dota-maps-data/images/latest/autumn';

The `/images/<patch>/<skin>` and `/images/latest/<skin>` subpaths are small
re-export wrappers; the PNG remains in its independently installable package.
Each patch has its own skin set, based on the skins actually generated for that
patch. For all skins in one import, install the matching aggregate package and
import the default object or named skins from `/images/<patch>`:

    npm install @reino-doce/dota-map-skins-741
    import skins, { autumn, winter } from '@reino-doce/dota-maps-data/images/741';

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

The runtime package exports pure calculations from its root entry, installed-game readers and callable data/image generators from `@reino-doce/dota-maps-data/node`, the prebuilt vision simulator from `@reino-doce/dota-maps-data/vision`, and the full patch and asset inventory from `@reino-doce/dota-maps-data/manifest.json`. The Node entry also exports `buildNpmPackagePlan()` and `prepareNpmPackages()` for package publishing. Its asset reader can use an installed version package when a patch is absent from the local source tree.

Patch data remains under `assets/data/<patch>/`, including each patch's own `worlddata.json` bounds. Every shipped image is grouped under `assets/img/<patch>/`: `map_data.png` is the gameplay raster, `illustrated.jpg` is the overview texture, `screenshot.jpg` is the calibrated game screenshot, and `<skin>.jpg` is a terrain image. The source overview texture is retained as `overview.png` for the overview importer; original terrain capture PNGs are not committed. Terrain data records each capture's source hash and provenance. npm image packages include only the ready-to-use JPEG assets, while `manifest.json` records the shipped patch directories and checksums for all committed assets.

## Generate map data

Run the maintenance commands from this repository. Importers take a patch ID
as a positional argument and accept prepared source paths as documented below;
paths to source inputs are resolved from the calling directory. Generated map
assets always go into this repository. Terrain scans, dedicated-server
Eyes/tree captures, Workshop Tools exports, and Source 2 Viewer extraction
require the corresponding installed tools. Temporary scan and capture files
stay under the ignored `map-captures/` directory.

To rebuild entity locations and navigation inputs directly from one exact
versioned map archive, pass the patch, archive, Source 2 Viewer CLI, and absolute
output directory explicitly:

```sh
npm run import:mapdata -- --patch 683 --archive <absolute-dota_683.vpk> \
  --resource-tool <absolute-Source2Viewer-CLI> --output <absolute-assets-data-683> \
  [--game-client-version <numeric-build>]
```

The importer writes `mapdata.json`, the six lane spawners and paths,
`fow_blockers.json`, provenance in `source.json`, and the archive's
`gridnav.gnv` when present. Map data includes
all supported entity classes, with empty arrays for classes confirmed absent
from the selected archive. It preserves existing per-patch unit stats and
exact-location runtime hull annotations when refreshing. The optional
`--game-client-version` records the numeric client build used to verify runtime
identities. It refuses to replace existing outputs unless `--overwrite` is
supplied. Each invocation uses only its selected archive; patch 728 has no
navigation grid in its archive. This produces the complete map-archive layer
set; terrain/elevation and ward rasters, Eyes patterns, Watcher/building vision
ranges, live-tree runtime indices, and screenshot/skin calibration need their
matching versioned game resources or loaded-map captures and are not inferred
from another patch.

Capture loaded terrain and runtime structure/tree positions from the exact
patch archive with an isolated local server. First inspect the archive identity
and sampling grid without starting Dota:

```sh
npm run map:scan-data -- 683 --plan
```

Then capture to ignored `map-captures/<patch>/` output; pass `--archive` when
the exact archive is not at `game/dota/maps/<archive>` (for example, depot
patch 684). The scanner verifies the archive, map resource, tree coordinates,
and runtime structure positions before accepting a capture. It refuses to run
while Dota or Source Filmmaker is open and removes only its own temporary add-on
and Lua script after the dedicated server exits:

```sh
npm run map:scan-data -- 683 --archive <absolute-exact-map.vpk>
npm run map:scan-data -- 683 --archive <absolute-exact-map.vpk> --install
```

The first command only writes ignored captures. `--install` additionally adds
the matching `terrain_grid.json` and, when the engine returns a complete native
tree index, `live_tree_index.json`; existing differing data requires
`--overwrite`. Rebuild derived terrain and ward layers afterward with the
dependency-ordered commands below. Patch 728 has no native `.gnv`; its terrain
can be sampled against aligned world bounds, then exported as patch-specific
world bounds, elevation contours, and FOW contours. It cannot produce the
five-panel runtime raster or ward restrictions without native navigation data;
those are reported as unavailable rather than synthesized.

For Source 1 depot extracts, import the compiled BSP directly. Use the Dota
patch represented by the extracted game data as the label. For example, this
Source 1 depot is Dota 2 patch 6.70:

```sh
npm run import:source1-mapdata -- --patch 670 --map <absolute-dota.bsp> \
  --output <absolute-assets-data-670>
```

This writes map locations, world bounds, BSP-derived neutral trigger boxes,
the matching `.gnv` file when present, and checksummed source provenance. The
two neutral camps without an explicit type stay untyped; trigger associations
are recorded as minimum-distance inferences. Vision, ward, Watcher, Eyes, and
terrain-height data are not synthesized from the BSP.

Generate lane-spawner points and their linked creep paths from a decompiled
entity dump for that same patch:

```sh
npm run import:lanes -- --patch 688 --entities <absolute-entity-dump.txt> \
  --output <absolute-assets-data-688>
```

The importer writes `npc_dota_spawner.json` and `path_corner.json`, validates
all six lane chains, and refuses to replace existing files unless
`--overwrite` is supplied. Legacy visibility overlays can be reconstructed
from that patch's own five-panel `assets/img/<patch>/map_data.png` raster and
`worlddata.json` with `npm run generatejson -- <patch>`.

Powered by [Source 2 Viewer](https://s2v.app)
([ValveResourceFormat](https://github.com/ValveResourceFormat/ValveResourceFormat)).

Extract the simple and detailed minimaps referenced by every versioned overview
config in an installed Dota client:

```sh
npm run import:minimaps -- --game <absolute-dota-game-dir> \
  --resource-tool <absolute-Source2Viewer-CLI>
```

The importer scans indexed VPKs and writes decoded images under
`assets/img/<patch>/minimaps/`, with source hashes and resource paths in
`assets/provenance/minimaps/<patch>.json`. It never assigns an unversioned
current material to a historical patch. If a historical config names a shared
material, it can use an exact `dota_<patch>.vmat` or
`dota_minimal_<patch>.vmat` retained in the client VPK; provenance marks that
material as a fallback when the config did not reference it. Such a retained
asset still does not prove which historical Steam build produced it. The
importer does not synthesize simple images when no patch-specific simple
material exists, except patch 683 whose retained overview material is the
simple minimap. Existing outputs are protected unless `--overwrite` is passed.

Refresh prepared patch inputs in dependency order:

```sh
npm run import:terrain -- 741
npm run import:structures -- 741 --resource-tool <Source2Viewer-CLI> \
  --model-archive <matching-pak01_dir.vpk>
npm run import:wards -- 741 [extracted-dota.gnv]
npm run import:eyes -- 741
npm run import:watchers -- 741 --resource-tool <Source2Viewer-CLI>
npm run import:building-vision -- 741 --resource-tool <Source2Viewer-CLI>
npm run import:live-trees -- 741
npm run manifest
npm test
```

To process every patch with the full matching terrain inputs, run
`npm run import:terrain -- --all`. It generates only complete patch datasets and
reports missing inputs for the rest; it never borrows terrain from another
version. A single-patch import writes only to the selected library patch
directory. It rejects stale,
incomplete, or mismatched inputs and will not silently reuse another patch's
data. Overview and screenshot imports accept explicit prepared input paths, for
example `npm run import:overview -- 741 ./overview.txt ./overview.png` and
`npm run import:screenshot -- 741 ./map.jpg`. For historical overview configs,
pass the matching resource path as the final argument, such as
`resource/overviews/dota_737.txt`. Terrain skin capture and
registration use `npm run map:skins -- <action>`.

To render the detailed in-game terrain image for every installed patch with a
matching `worlddata.json`, prepare version-specific Source Filmmaker sweeps:

```sh
npm run images:generate -- prepare --all --overwrite
```

For each prepared patch, stage its complete map VPK at the add-on's matching
map path (usually `maps/dota.vpk`), then reopen that patch's generated
`map-captures/default-image-sweep/<patch>/session.dmx` in Dota 2's Source 2
Filmmaker. The session uses the map name embedded in the VPK. Keep the VPK
intact; do not extract or rename its internal `.vmap_c` resource.
Export a 45-second Image Sequence as PNG at 3840×2160 to the tile prefix shown
in `capture.json`; disable the Separate WAV File option. Stitch its 5×9 frames
into the 16,384×16,384 JPEG with:

```sh
npm run images:generate -- stitch --patch <patch> --overwrite
```

The capture manifest records the source VPK checksum and exact map resource.
Staging refuses mismatched archives and saves the add-on's original map VPK
before temporarily replacing it. After rendering all patches, restore the
Workshop Tools add-on with:

```sh
npm run images:generate -- restore
```

Keep capture sessions and PNG tiles under the ignored `map-captures/`
directory. The restore command verifies the staged VPK before putting the
original add-on map back.

Reconstruct every map and terrain skin with a matching version-4 tile set from
[devilesk/dota-map-tiles](https://github.com/devilesk/dota-map-tiles):

```sh
npm run images:reconstruct -- --tiles-root <dota-map-tiles> --all-available
```

The importer requires a complete patch-and-skin-matched version-4 grid and
writes a 16,384×16,384 `assets/img/<patch>/<skin>.jpg`. Existing outputs are
skipped unless `--overwrite` is passed. The source repository has default maps
for 688, 700, 706, 707, 709, 715, 719, and 720; patch 706 also has autumn,
desert, Immortal Gardens, Journey, Reef, Spring, and Winter skins. Patches 721,
722, and 723 still need their own tile sources; the importer does not borrow
another patch's map. Patch 741 uses the images extracted from the current
client.

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
