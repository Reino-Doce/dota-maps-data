import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { PNG } from 'pngjs';
import { readGridNav, encodeWardGrid, wardGridToGeoJSON, runtimeWardHulls } from '../scripts/ward-grid.mjs';
import { isWardBlocked } from '../src/wardGrid.mjs';

const read = name => fs.readFileSync(new URL(`../assets/${name}`, import.meta.url));
const source = read('data/741/gridnav.gnv');
const grid = JSON.parse(read('data/741/ward_grid.json'));
const overlay = JSON.parse(read('data/741/no_wards.json'));
const nav = readGridNav(source);
const terrain = JSON.parse(read('data/741/terrain_grid.json'));
const structures = JSON.parse(read('data/741/ward_structures.json'));
const staticGrid = { ...grid, hulls: [], structures: [] };

test('rejects wards on both Twin Gate structures', () => {
    const controls = JSON.parse(read('data/741/screenshot-controls.json'));
    for (const gate of controls.anchors.filter(anchor => anchor.name.includes('Twin Gate'))) {
        assert.equal(isWardBlocked(grid, ...gate.world), true, gate.name);
    }
});

test('blocks complete Lotus structures, both Outposts and both Tormentor holes', () => {
    for (const entity of terrain.entities) assert.equal(isWardBlocked(grid, ...entity.origin), true, entity.name);
    for (const pit of terrain.pits) assert.equal(isWardBlocked(grid, ...pit.center), true, pit.name);
    // Centers of the three outer bowls in model space, independently of the
    // NPC's 96-unit hull. Each pool has a different authored rotation.
    for (const pool of terrain.entities.filter(e => e.classname === 'npc_dota_lotus_pool')) {
        const angle = pool.angles[1] * Math.PI / 180;
        for (const [x, y] of [[300, 0], [-150, 260], [-150, -260]]) {
            const world = [pool.origin[0] + pool.modelScale * (x * Math.cos(angle) - y * Math.sin(angle)),
                pool.origin[1] + pool.modelScale * (x * Math.sin(angle) + y * Math.cos(angle))];
            assert.equal(isWardBlocked(grid, ...world), true, pool.name + ': outer bowl');
        }
        assert.equal(isWardBlocked(grid, pool.origin[0] + 150 * pool.modelScale * Math.cos(angle),
            pool.origin[1] + 150 * pool.modelScale * Math.sin(angle)), false, 'open ground between the central pillar and a bowl');
    }
});

// Independent scan-line rasterization verifies polygon holes and islands,
// rather than comparing the contour algorithm with itself.
function rasterize(collection, definition, offset = 0) {
    const { width, height, origin, cellSize } = definition;
    const result = new Uint8Array(width * height);
    const polygons = collection.features.flatMap(feature => feature.geometry.type === 'Polygon'
        ? [feature.geometry.coordinates] : feature.geometry.coordinates);
    for (let y = 0; y < height; y++) {
        const worldY = origin[1] + (y + 0.5) * cellSize + offset;
        for (const rings of polygons) {
            const crossings = [];
            for (const ring of rings) {
                for (let i = 0; i < ring.length - 1; i++) {
                    const [x1, y1] = ring[i];
                    const [x2, y2] = ring[i + 1];
                    if ((y1 > worldY) !== (y2 > worldY)) {
                        crossings.push(x1 + (worldY - y1) * (x2 - x1) / (y2 - y1));
                    }
                }
            }
            crossings.sort((a, b) => a - b);
            assert.equal(crossings.length % 2, 0);
            for (let i = 0; i < crossings.length; i += 2) {
                for (let x = 0; x < width; x++) {
                    const worldX = origin[0] + (x + 0.5) * cellSize + offset;
                    if (worldX > crossings[i] && worldX < crossings[i + 1]) result[y * width + x] = 1;
                }
            }
        }
    }
    return result;
}

test('imports the full installed game grid with its original bounds and provenance', () => {
    assert.equal(source.length, 104992);
    assert.deepEqual([nav.width, nav.height, nav.cellSize], [320, 328, 64]);
    assert.deepEqual(nav.origin, [-10240, -10752]);
    assert.equal(grid.source.sha256, createHash('sha256').update(source).digest('hex'));
    assert.equal(structures.source.terrainSha256, createHash('sha256').update(read('data/741/terrain_grid.json')).digest('hex'));
    assert.equal(structures.source.navigationSha256, grid.source.sha256);
    assert.equal(structures.features.length, 8);
    assert.deepEqual(encodeWardGrid(nav, grid.source, runtimeWardHulls(terrain), structures.features), grid);
    assert.deepEqual(wardGridToGeoJSON(grid), overlay);
});

test('the static overlay preserves every game WardBlocking cell', () => {
    const raster = rasterize({ features: overlay.features.filter(feature => feature.properties.source === 'dota.gnv') }, grid);
    let blockedCount = 0;
    for (let y = 0; y < grid.height; y++) {
        for (let x = 0; x < grid.width; x++) {
            const index = y * grid.width + x;
            // Read the raw source byte directly, independently of the importer.
            const blocked = (source[32 + index] & 0x10) !== 0;
            assert.equal(raster[index], Number(blocked), `overlay mismatch at ${x},${y}`);
            for (const inset of [0.001, 32, 63.999]) {
                assert.equal(isWardBlocked(staticGrid,
                    grid.origin[0] + x * 64 + inset,
                    grid.origin[1] + y * 64 + inset), blocked, `placement mismatch at ${x},${y}`);
            }
            if (blocked) blockedCount += 1;
        }
    }
    assert.equal(blockedCount, 45527);
});

test('runtime structures agree with markers, overlay and placement', () => {
    const entities = terrain.entities.filter(entity => entity.classname === 'npc_dota_lotus_pool');
    const map = JSON.parse(read('data/741/mapdata.json'));
    assert.equal(entities.length, 2, 'export both pools omitted by the old entity allowlist');
    assert.equal(map.data.npc_dota_lotus_pool.length, 2);
    for (const entity of entities) {
        const [x, y] = entity.origin;
        assert.equal(entity.hullRadius, 96);
        assert.deepEqual(entity.bounds, [[-96, -96, 0], [96, 96, 72]]);
        assert.ok(map.data.npc_dota_lotus_pool.some(point => point.x === x && point.y === y && point.hullRadius === 96));
        assert.equal(isWardBlocked(staticGrid, x, y), false, 'the static GNV alone misses the pool');
        assert.equal(isWardBlocked(grid, x, y), true, 'pool centers must reject wards');
        assert.equal(isWardBlocked(grid, x + 600, y), isWardBlocked(staticGrid, x + 600, y), 'do not extend the structure onto adjacent ground');
        const polygon = overlay.features.find(feature => feature.properties.classname === entity.classname
            && Math.abs(feature.geometry.coordinates[0][0][0] - x - 96) < 1e-8);
        assert.ok(polygon, 'Invalid Wards must include this pool');
        for (const point of polygon.geometry.coordinates[0]) assert.ok(Math.abs(Math.hypot(point[0] - x, point[1] - y) - 96) < 1e-8);
    }
    // Avoid sampling precisely on the 8-unit contour edges. Boundary inclusion
    // is tested separately; scan-line filling tests the polygon interiors.
    const raster = rasterize(overlay, grid, 0.25);
    const structureRaster = rasterize(structures, grid, 0.25);
    for (let row = 0; row < nav.height; row++) {
        for (let column = 0; column < nav.width; column++) {
            const x = nav.origin[0] + (column + 0.5) * 64 + 0.25;
            const y = nav.origin[1] + (row + 0.5) * 64 + 0.25;
            const index = row * nav.width + column;
            const blocked = !!(source[32 + index] & 16)
                || terrain.entities.some(entity => Math.hypot(entity.origin[0] - x, entity.origin[1] - y) <= entity.hullRadius)
                || !!structureRaster[index];
            assert.equal(raster[index], Number(blocked), `combined overlay at ${x},${y}`);
            assert.equal(isWardBlocked(grid, x, y), blocked);
        }
    }
    assert.throws(() => runtimeWardHulls({}), /Recapture/);
});

test('the vision raster uses the same ward flag, without movement-based restrictions', () => {
    const image = PNG.sync.read(read('img/741/map_data.png'));
    assert.deepEqual([image.width, image.height], [1600, 328]);
    for (let y = 0; y < nav.height; y++) {
        for (let x = 0; x < nav.width; x++) {
            const sourceBlocked = (source[32 + y * nav.width + x] & 0x10) !== 0;
            const pixel = ((nav.height - 1 - y) * image.width + 4 * nav.width + x) * 4;
            assert.equal(image.data[pixel] === 0, sourceBlocked, `raster mismatch at ${x},${y}`);
        }
    }
});

test('preserves terrain restrictions, both pits, fountains, cliffs and the outer map', () => {
    const samples = [
        { name: 'upper Roshan interior', point: [-3072, 2240], blocked: true },
        { name: 'lower Roshan interior', point: [2816, -2816], blocked: true },
        { name: 'old displaced upper patch', point: [-2496, 2304], blocked: false },
        { name: 'old displaced lower patch', point: [3520, -3648], blocked: false },
        { name: 'river terrain restriction', point: [-1683, 1869], blocked: true },
        { name: 'radiant fountain', point: [-6464, -6400], blocked: true },
        { name: 'dire fountain', point: [7232, 6400], blocked: true },
        { name: 'non-traversable wardable cell', point: [32, -416], blocked: false },
        { name: 'hero-blocking wardable cell', point: [4064, 7072], blocked: false },
        { name: 'creature-blocking wardable cell', point: [-6880, 6880], blocked: false },
        { name: 'wardable outer edge', point: [8544, -32], blocked: false },
        { name: 'southeast restriction', point: [7392, -7328], blocked: true },
    ];
    for (const sample of samples) assert.equal(isWardBlocked(grid, ...sample.point), sample.blocked, sample.name);
    for (const point of [[NaN, 0], [Infinity, 0], [-10241, 0], [10240, 0], [0, -10753], [0, 10240]]) {
        assert.equal(isWardBlocked(grid, ...point), true, `outside grid: ${point}`);
    }
});

test('terrain and blocker contours occupy the same full-map cells as the vision raster', () => {
    const image = PNG.sync.read(read('img/741/map_data.png'));
    const elevation = JSON.parse(read('data/741/elevation.json'));
    const blockers = JSON.parse(read('data/741/ent_fow_blocker_node.json'));
    const actualBlockers = rasterize(blockers, grid);
    const actualHeights = new Int16Array(nav.width * nav.height).fill(-1);
    for (const feature of elevation.features) {
        const cells = rasterize({ features: [feature] }, grid);
        for (let index = 0; index < cells.length; index++) {
            if (!cells[index]) continue;
            assert.equal(actualHeights[index], -1, 'elevation regions must not overlap');
            actualHeights[index] = feature.properties.elevation;
        }
    }
    for (let y = 0; y < nav.height; y++) {
        for (let x = 0; x < nav.width; x++) {
            const index = y * nav.width + x;
            const pixel = ((nav.height - 1 - y) * image.width + x) * 4;
            assert.equal(actualHeights[index], image.data[pixel], `terrain contour at ${x},${y}`);
            assert.equal(actualBlockers[index], Number(image.data[pixel + 3 * nav.width * 4] === 0), `blocker contour at ${x},${y}`);
        }
    }
});

test('contours preserve holes, islands and diagonal contacts on a rectangular grid', () => {
    const rows = ['1111101', '1000100', '1010100', '1000100', '1111101', '0000010'];
    const flags = Uint8Array.from(rows.join(''), value => Number(value) * 16);
    const definition = encodeWardGrid({ width: 7, height: 6, cellSize: 64, origin: [-128, -64], flags });
    assert.deepEqual(rasterize(wardGridToGeoJSON(definition), definition), flags.map(value => value ? 1 : 0));
});

test('rejects truncated or unsupported game data instead of generating a partial layer', () => {
    assert.throws(() => readGridNav(source.subarray(0, 20)), /Truncated/);
    assert.throws(() => readGridNav(source.subarray(0, -1)), /truncated/);
    const wrongMagic = Buffer.from(source);
    wrongMagic[0] = 0;
    assert.throws(() => readGridNav(wrongMagic), /magic/);
    const wrongSize = Buffer.from(source);
    wrongSize.writeFloatLE(128, 4);
    assert.throws(() => readGridNav(wrongSize), /Unsupported/);
});
