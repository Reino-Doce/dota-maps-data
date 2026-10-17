import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { PNG } from 'pngjs';
import manifest from '../manifest.json' with { type: 'json' };

const assets = path.resolve('assets');
const patches = ['683', '684', '685', '688', '706', '719', '722', '728', '732', '737', '741'];
const applicationMapPatches = ['741', '723', '722', '721', '720', '719', '715', '709', '707', '706', '700', '688'];
const matrixMapPatches = ['683', '684', '685', '688', '700', '706', '707', '709', '715', '719', '720', '721',
    '722', '723', '728', '732', '737', '741'];
const applicationMapGeoJsonLayers = [
    'elevation.json', 'path_corner.json', 'npc_dota_spawner.json',
    'ent_fow_blocker_node.json', 'no_wards.json',
];
const applicationMapEntityLayers = [
    'trigger_multiple', 'npc_dota_neutral_spawner', 'ent_dota_tree', 'npc_dota_roshan_spawner',
    'dota_item_rune_spawner_powerup', 'dota_item_rune_spawner_bounty', 'ent_dota_fountain',
    'npc_dota_lotus_pool', 'npc_dota_unit_twin_gate', 'npc_dota_xp_fountain', 'npc_dota_barracks',
    'npc_dota_filler', 'npc_dota_tower', 'ent_dota_shop', 'npc_dota_fort', 'npc_dota_healer',
    'npc_dota_watch_tower', 'npc_dota_lantern',
];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

test('each prepared map has exact patch data required by the map viewer', () => {
    for (const patch of patches) {
        const directory = path.join(assets, 'data', patch);
        const readJson = filename => JSON.parse(fs.readFileSync(path.join(directory, filename), 'utf8'));
        const map = readJson('mapdata.json');
        const source = readJson('source.json');
        const overview = readJson('overview.json');
        const world = readJson('worlddata.json');
        const blockers = readJson('fow_blockers.json');

        assert.equal(source.patch, patch, `${patch} provenance must identify its patch`);
        assert.match(source.archiveSha256, /^[a-f0-9]{64}$/u, `${patch} must identify its source archive`);
        assert.ok(source.resources.map.available, `${patch} map resource is required`);
        assert.match(source.dataCoverage.patchSpecificDerivedData, /matching capture or game resources/u,
            `${patch} must state the limit of map-archive-only extraction`);
        assert.match(source.dataCoverage.laneGeometry, /this archive/u,
            `${patch} lanes must be linked to its own map archive`);
        assert.ok(map.data.ent_dota_tree.length > 1000, `${patch} tree entities are incomplete`);
        assert.deepEqual(Object.keys(source.mapEntityCounts).sort(), Object.keys(map.data)
            .filter(classname => Array.isArray(map.data[classname])).sort(),
        `${patch} source coverage must enumerate every exported entity class`);
        for (const [classname, count] of Object.entries(source.mapEntityCounts)) {
            assert.equal(map.data[classname].length, count, `${patch} ${classname} extracted count`);
        }
        for (const classname of ['npc_dota_lotus_pool', 'npc_dota_unit_twin_gate', 'npc_dota_lantern',
            'npc_dota_filler', 'npc_dota_tower']) {
            assert.ok(Array.isArray(map.data[classname]), `${patch} must record presence or an exact zero for ${classname}`);
        }
        for (const classname of applicationMapEntityLayers) {
            assert.ok(Array.isArray(map.data[classname]), `${patch} is missing application map layer ${classname}`);
        }
        assert.ok(map.data.npc_dota_neutral_spawner.length > 0, `${patch} neutral camps are missing`);
        assert.equal(map.data.trigger_multiple.length, map.data.npc_dota_neutral_spawner.length,
            `${patch} neutral camps and trigger hulls must correspond`);
        const campsById = new Map(map.data.npc_dota_neutral_spawner.map(camp => [camp.triggerName, camp]));
        for (const box of map.data.trigger_multiple) {
            const boxSource = box.source || {};
            const boxArchiveHash = boxSource.archiveSha256 || boxSource.mapArchiveSha256;
            assert.ok(campsById.has(box.campId), `${patch} has an unmatched neutral trigger hull`);
            assert.equal(box.triggerName, box.campId, `${patch} neutral hull identity must match its camp`);
            assert.equal(boxSource.patch, patch, `${patch} neutral hull provenance must identify this patch`);
            assert.equal(boxArchiveHash, source.archiveSha256,
                `${patch} neutral hull must come from this exact map archive`);
            assert.equal(boxSource.entityResource?.path, source.resources.entities.path,
                `${patch} neutral hull must identify the exact entity resource`);
            assert.equal(boxSource.entityResource?.sha256, source.resources.entities.sha256,
                `${patch} neutral hull entity source must match source.json`);
            assert.equal(boxSource.gridnavSha256, source.resources.navigation.available
                ? source.resources.navigation.sha256 : null,
            `${patch} neutral hull navigation provenance must match its archive`);
            assert.equal(box.modelResource, boxSource.model?.path,
                `${patch} neutral hull must identify its source physics model`);
            assert.match(boxSource.model?.sha256 || '', /^[a-f0-9]{64}$/u,
                `${patch} neutral hull physics model must have a checksum`);
            assert.ok(Array.isArray(box.points) && box.points.length >= 3,
                `${patch} neutral hull must have a 2D footprint`);
            assert.ok(Array.isArray(box.vertices) && box.vertices.length >= 4,
                `${patch} neutral hull must retain source 3D vertices`);
            assert.ok(box.localBounds?.min?.length === 3 && box.localBounds?.max?.length === 3
                && [...box.localBounds.min, ...box.localBounds.max].every(Number.isFinite),
            `${patch} neutral hull must retain finite local bounds`);
        }
        assert.equal(campsById.size, map.data.trigger_multiple.length,
            `${patch} every neutral camp must have exactly one archive-derived hull`);
        assert.equal(source.resources.fowBlockers.count, blockers.points.length,
            `${patch} FOW blocker provenance must match its dataset`);
        assert.equal(blockers.source.file, source.resources.entities.path,
            `${patch} FOW blockers must identify the source entity resource`);
        assert.equal(blockers.source.sha256, source.resources.entities.sha256,
            `${patch} FOW blockers must use the map's exact entity resource`);

        assert.ok(Number.isFinite(world.worldMinX) && Number.isFinite(world.worldMaxX)
            && world.worldMinX < world.worldMaxX && Number.isFinite(world.worldMinY)
            && Number.isFinite(world.worldMaxY) && world.worldMinY < world.worldMaxY,
        `${patch} needs valid version-specific world bounds`);
        assert.equal(overview.source.sha256, sha256(fs.readFileSync(path.join(directory, 'overview.txt'))),
            `${patch} overview metadata must match its exact text source`);
        for (const filename of ['npc_dota_spawner.json', 'path_corner.json']) {
            const geojson = readJson(filename);
            assert.equal(geojson.features.length, 6, `${patch} ${filename} must cover all six lanes`);
        }

        const gridnavPath = path.join(directory, 'gridnav.gnv');
        assert.equal(source.resources.navigation.available, fs.existsSync(gridnavPath),
            `${patch} navigation availability must match the archive`);
        if (fs.existsSync(gridnavPath)) {
            assert.equal(source.resources.navigation.sha256, sha256(fs.readFileSync(gridnavPath)),
                `${patch} navigation grid must match its source archive`);
        }
    }
});

test('each extracted archive has patch-matched terrain, tree IDs, and every navigation-derived layer', () => {
    for (const patch of patches) {
        const directory = path.join(assets, 'data', patch);
        const read = filename => JSON.parse(fs.readFileSync(path.join(directory, filename), 'utf8'));
        const source = read('source.json');
        const map = read('mapdata.json');
        const terrainBytes = fs.readFileSync(path.join(directory, 'terrain_grid.json'));
        const terrain = JSON.parse(terrainBytes);
        const treeIndexBytes = fs.readFileSync(path.join(directory, 'live_tree_index.json'));
        const treeIndex = JSON.parse(treeIndexBytes);
        const capture = source.runtimeCapture;

        assert.ok(capture, `${patch} runtime capture provenance is missing`);
        assert.equal(capture.mapArchiveSha256, source.archiveSha256, `${patch} terrain capture archive`);
        assert.equal(capture.mapResource, source.resources.map.path, `${patch} terrain capture map resource`);
        assert.equal(capture.mapEntitiesSha256, source.resources.entities.sha256, `${patch} terrain capture entities`);
        assert.equal(capture.navigationSha256, source.resources.navigation.available
            ? source.resources.navigation.sha256 : null, `${patch} terrain capture navigation`);
        assert.equal(capture.terrainSha256, sha256(terrainBytes), `${patch} terrain capture checksum`);
        assert.equal(capture.treeIndexSha256, sha256(treeIndexBytes), `${patch} tree-index checksum`);
        assert.equal(capture.treePositionValidation.matches, true, `${patch} tree positions must match the source map`);
        assert.equal(terrain.source.patch, patch, `${patch} terrain patch identity`);
        assert.equal(terrain.source.mapArchiveSha256, source.archiveSha256, `${patch} terrain archive provenance`);
        assert.equal(terrain.source.mapResource, source.resources.map.path, `${patch} terrain map-resource provenance`);
        assert.equal(terrain.source.mapEntitiesSha256, source.resources.entities.sha256, `${patch} terrain entity provenance`);
        assert.equal(terrain.source.navigationSha256, capture.navigationSha256, `${patch} terrain navigation provenance`);
        assert.equal(terrain.heights.length, terrain.height, `${patch} terrain height rows`);
        assert.ok(terrain.heights.every(row => row.length === terrain.width && row.every(Number.isFinite)),
            `${patch} terrain heights must cover the complete grid`);
        assert.equal(terrain.trees.length, map.data.ent_dota_tree.length, `${patch} runtime tree count`);
        assert.equal(treeIndex.mapIndices.filter(Number.isInteger).length, terrain.trees.length,
            `${patch} every runtime tree must have one native ID`);
        assert.equal(new Set(treeIndex.mapIndices.filter(Number.isInteger)).size, terrain.trees.length,
            `${patch} native tree IDs must map uniquely`);
        assert.equal(sha256(fs.readFileSync(path.join(directory, 'elevation.json'))).length, 64);
        assert.equal(sha256(fs.readFileSync(path.join(directory, 'ent_fow_blocker_node.json'))).length, 64);

        const hasNavigation = source.resources.navigation.available === true;
        assert.equal(fs.existsSync(path.join(directory, 'gridnav.gnv')), hasNavigation,
            `${patch} navigation file availability must match source.json`);
        if (hasNavigation) {
            assert.equal(sha256(fs.readFileSync(path.join(directory, 'gridnav.gnv'))), source.resources.navigation.sha256,
                `${patch} navigation checksum`);
            const wardGrid = read('ward_grid.json');
            const wardStructures = read('ward_structures.json');
            const wardRestrictions = read('no_wards.json');
            assert.equal(wardGrid.source.sha256, source.resources.navigation.sha256, `${patch} ward-grid navigation`);
            assert.equal(wardStructures.source.navigationSha256, source.resources.navigation.sha256,
                `${patch} structure navigation`);
            assert.equal(wardStructures.source.terrainSha256, sha256(terrainBytes), `${patch} structure terrain`);
            assert.equal(wardRestrictions.type, 'FeatureCollection', `${patch} ward restrictions must be GeoJSON`);
            const image = PNG.sync.read(fs.readFileSync(path.join(assets, 'img', patch, 'map_data.png')));
            assert.deepEqual([image.width, image.height], [terrain.width * 5, terrain.height],
                `${patch} five-panel raster must use the exact navigation grid`);
        }
        else {
            assert.equal(source.resources.navigation.available, false, `${patch} missing navigation must be explicit`);
            assert.match(source.dataCoverage.wardRestrictions, /unavailable.*GNV/iu,
                `${patch} must record that exact ward restrictions are unavailable`);
            assert.equal(fs.existsSync(path.join(directory, 'ward_grid.json')), false,
                `${patch} must not borrow a neighboring navigation grid`);
        }
    }
});

test('every map version selectable by dota-interactive-map ships its own map data and five-panel raster', () => {
    for (const patch of applicationMapPatches) {
        const directory = path.join(assets, 'data', patch);
        const map = JSON.parse(fs.readFileSync(path.join(directory, 'mapdata.json'), 'utf8'));
        const world = JSON.parse(fs.readFileSync(path.join(directory, 'worlddata.json'), 'utf8'));
        const image = PNG.sync.read(fs.readFileSync(path.join(assets, 'img', patch, 'map_data.png')));
        const cellWidth = (world.worldMaxX - world.worldMinX) / 64 + 1;
        const cellHeight = (world.worldMaxY - world.worldMinY) / 64 + 1;
        const packageData = manifest.patches.find(item => item.id === patch);

        assert.ok(map.data && Object.keys(map.data).length > 0, `${patch} map entity data is missing`);
        for (const classname of ['ent_dota_tree', 'npc_dota_neutral_spawner', 'trigger_multiple',
            'npc_dota_tower', 'npc_dota_barracks', 'npc_dota_fort', 'ent_dota_fountain']) {
            assert.ok(Array.isArray(map.data[classname]) && map.data[classname].length > 0,
                `${patch} map layer ${classname} is missing`);
        }
        const boxes = map.data.trigger_multiple;
        const campNames = new Set(boxes.map(box => box.campId || box.triggerName || box.name || box.targetname));
        assert.equal(map.data.npc_dota_neutral_spawner.filter(camp =>
            campNames.has(camp.triggerName || camp.name)).length, map.data.npc_dota_neutral_spawner.length,
        `${patch} every neutral camp needs a matching spawn-box footprint`);
        for (const box of boxes) {
            assert.ok(Array.isArray(box.points) && box.points.length >= 3
                && box.points.every(point => Number.isFinite(point.x) && Number.isFinite(point.y)),
            `${patch} neutral camp footprint is invalid`);
        }
        assert.deepEqual([image.width, image.height], [cellWidth * 5, cellHeight],
            `${patch} raster must have five 64-unit panels aligned to its world bounds`);
        assert.ok(packageData, `${patch} must have a version-specific npm data package`);
        for (const filename of ['mapdata.json', 'worlddata.json']) {
            assert.ok(packageData.files.some(file => file.path === `data/${patch}/${filename}`),
                `${patch} package must contain ${filename}`);
        }
        for (const filename of applicationMapGeoJsonLayers) {
            const filepath = path.join(directory, filename);
            const layer = JSON.parse(fs.readFileSync(filepath, 'utf8'));
            assert.ok(['Feature', 'FeatureCollection'].includes(layer.type),
                `${patch} ${filename} must be valid GeoJSON`);
            if (layer.type === 'FeatureCollection') assert.ok(Array.isArray(layer.features), `${patch} ${filename} features are missing`);
            else assert.ok(layer.geometry && typeof layer.geometry.type === 'string', `${patch} ${filename} geometry is missing`);
            assert.ok(packageData.files.some(file => file.path === `data/${patch}/${filename}`),
                `${patch} package must contain application layer ${filename}`);
        }
        for (const skin of manifest.skinPackages.filter(item => item.patchId === patch)) {
            assert.ok(fs.existsSync(path.join(assets, skin.file.path)),
                `${patch} registered terrain skin ${skin.file.path} is missing`);
        }
    }
});

test('every map version listed in the export matrix has the map data layers its viewer supports', () => {
    for (const patch of matrixMapPatches) {
        const directory = path.join(assets, 'data', patch);
        const map = JSON.parse(fs.readFileSync(path.join(directory, 'mapdata.json'), 'utf8'));
        const world = JSON.parse(fs.readFileSync(path.join(directory, 'worlddata.json'), 'utf8'));
        const packageData = manifest.patches.find(item => item.id === patch);

        assert.ok(packageData, `${patch} must have an installable map-data package`);
        for (const filename of ['mapdata.json', 'worlddata.json', 'elevation.json', 'path_corner.json',
            'npc_dota_spawner.json', 'ent_fow_blocker_node.json']) {
            assert.ok(packageData.files.some(file => file.path === `data/${patch}/${filename}`),
                `${patch} map-data package must include ${filename}`);
        }

        for (const classname of ['ent_dota_tree', 'npc_dota_neutral_spawner', 'trigger_multiple',
            'npc_dota_tower', 'npc_dota_barracks', 'npc_dota_fort', 'ent_dota_fountain']) {
            assert.ok(Array.isArray(map.data[classname]) && map.data[classname].length > 0,
                `${patch} matrix map must contain ${classname}`);
        }
        for (const filename of ['elevation.json', 'path_corner.json', 'npc_dota_spawner.json', 'ent_fow_blocker_node.json']) {
            const layer = JSON.parse(fs.readFileSync(path.join(directory, filename), 'utf8'));
            assert.ok(['Feature', 'FeatureCollection'].includes(layer.type), `${patch} ${filename} must be valid GeoJSON`);
        }

        if (patch === '728') {
            const source = JSON.parse(fs.readFileSync(path.join(directory, 'source.json'), 'utf8'));
            assert.equal(source.resources.navigation.available, false, '728 has no source GNV');
            assert.equal(fs.existsSync(path.join(directory, 'no_wards.json')), false,
                '728 must not claim ward restrictions without native navigation data');
            assert.equal(packageData.files.some(file => file.path === `data/${patch}/no_wards.json`), false,
                '728 package must not claim ward restrictions without native navigation data');
            assert.equal(fs.existsSync(path.join(assets, 'img', patch, 'map_data.png')), false,
                '728 must not claim the five-panel movement and ward raster without native navigation data');
            assert.equal(manifest.images.some(image => image.path === `img/${patch}/map_data.png`), false,
                '728 package must not publish a five-panel raster without native navigation data');
            continue;
        }

        const noWards = JSON.parse(fs.readFileSync(path.join(directory, 'no_wards.json'), 'utf8'));
        assert.ok(['Feature', 'FeatureCollection'].includes(noWards.type), `${patch} no_wards.json must be valid GeoJSON`);
        assert.ok(packageData.files.some(file => file.path === `data/${patch}/no_wards.json`),
            `${patch} map-data package must include ward restrictions`);
        assert.ok(manifest.images.some(image => image.path === `img/${patch}/map_data.png`),
            `${patch} map-data package must publish the aligned five-panel raster`);
        const image = PNG.sync.read(fs.readFileSync(path.join(assets, 'img', patch, 'map_data.png')));
        const cellWidth = (world.worldMaxX - world.worldMinX) / 64 + 1;
        const cellHeight = (world.worldMaxY - world.worldMinY) / 64 + 1;
        assert.deepEqual([image.width, image.height], [cellWidth * 5, cellHeight],
            `${patch} map raster must have all five application data panels aligned with its world bounds`);
    }
});

test('the latest patch includes all live-data files used by the map application', () => {
    const patch = manifest.currentPatch;
    const directory = path.join(assets, 'data', patch);
    const read = filename => JSON.parse(fs.readFileSync(path.join(directory, filename), 'utf8'));
    const source = read('source.json');
    const map = read('mapdata.json');
    const treeIndex = read('live_tree_index.json');
    const wardGrid = read('ward_grid.json');
    const wardStructures = read('ward_structures.json');
    const watchers = read('watchers.json');
    const buildings = read('building_vision.json');
    const skins = read('skins.json');
    const treeCount = map.data.ent_dota_tree.length;

    for (const filename of ['terrain_grid.json', 'gridnav.gnv', 'fow_blockers.json', 'elevation.json',
        'ent_fow_blocker_node.json', 'no_wards.json', 'eyes_vision.json', 'watchers.json',
        'building_vision.json', 'screenshot.json', 'screenshot-controls.json', 'overview.json', 'skins.json']) {
        assert.ok(fs.existsSync(path.join(directory, filename)), `${patch} live map data is missing ${filename}`);
    }
    assert.equal(sha256(fs.readFileSync(path.join(directory, 'gridnav.gnv'))), source.resources.navigation.sha256,
        `${patch} navigation grid must match its exact source`);
    assert.equal(treeIndex.mapIndices.length, treeCount, `${patch} needs one live tree ID for every map tree`);
    assert.equal(new Set(treeIndex.mapIndices).size, treeCount, `${patch} live tree IDs must be complete and unique`);
    assert.equal(wardGrid.source.sha256, source.resources.navigation.sha256, `${patch} ward grid must match its GNV`);
    assert.equal(wardStructures.source.navigationSha256, source.resources.navigation.sha256,
        `${patch} structure footprints must match its GNV`);
    assert.equal(wardStructures.source.terrainSha256,
        sha256(fs.readFileSync(path.join(directory, 'terrain_grid.json'))), `${patch} structure footprints must match its terrain capture`);
    assert.equal(watchers.positions.length, map.data.npc_dota_lantern.length,
        `${patch} Watcher data must match map entities`);
    assert.ok(Array.isArray(buildings.buildings) && buildings.buildings.length > 0,
        `${patch} building vision rules must be present`);
    assert.ok(skins.some(skin => skin.source?.map === 'dota' && fs.existsSync(path.join(assets, skin.image))),
        `${patch} default terrain image must resolve`);
    for (const filename of ['img/map_data.png', 'img/default.jpg', 'img/minimaps/simple.png', 'img/minimaps/detailed.png']) {
        assert.ok(fs.existsSync(path.join(assets, 'img', patch, filename.slice('img/'.length))),
            `${patch} package image is missing ${filename}`);
    }
});
