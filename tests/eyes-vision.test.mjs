import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createEyesCollector } from '../scripts/eyes-scan.mjs';
import { createEyesVisionLookup } from '../src/eyesVision.mjs';

const directory = new URL('../assets/data/741/', import.meta.url);
const read = name => fs.readFileSync(new URL(name, directory));
const data = JSON.parse(read('eyes_vision.json'));
const inRing = ([x, y], ring) => {
    let inside = false;
    for (let current = 0, previous = ring.length - 1; current < ring.length; previous = current++) {
        const [x1, y1] = ring[current], [x2, y2] = ring[previous];
        if ((y1 > y) !== (y2 > y) && x < (x2 - x1) * (y - y1) / (y2 - y1) + x1) inside = !inside;
    }
    return inside;
};
const contains = (polygons, point) => polygons.some(rings => inRing(point, rings[0])
    && !rings.slice(1).some(ring => inRing(point, ring)));

test('native Eyes data covers every game tree and retains the scanned map provenance', () => {
    const trees = JSON.parse(read('mapdata.json')).data.ent_dota_tree;
    assert.equal(data.count, trees.length);
    assert.equal(new Set(data.trees.map(([x, y]) => `${x},${y}`)).size, trees.length);
    assert.equal(data.source.gridnavSha256, createHash('sha256').update(read('gridnav.gnv')).digest('hex'));
    const lookup = createEyesVisionLookup(data);
    for (const { x, y } of trees) assert.ok(lookup([x, y]), `missing tree ${x},${y}`);
    assert.equal(lookup([0, 0]), null);
    assert.ok(data.patterns.length > 1, 'Roshan restrictions must change the contours');
});

test('native Eyes contours preserve every sampled FOW cell including holes and disconnected areas', () => {
    for (const { rows, polygons } of data.patterns) {
        for (let y = 0; y < data.size; y++) {
            for (let x = 0; x < data.size; x++) {
                const lit = rows[y].some((start, index) => index % 2 === 0 && x >= start && x < rows[y][index + 1]);
                const point = [x, y].map(value => data.offset + (value + 0.5) * data.cellSize);
                assert.equal(contains(polygons, point), lit, `FOW cell ${x},${y}`);
                if (lit) assert.ok(Math.hypot(...point) <= data.radius + data.cellSize, 'no distant NPC reveals in the captured vision');
            }
        }
    }
});

test('Eyes on the two reported Roshan boundary trees match direct ability casts in the engine', () => {
    const lookup = createEyesVisionLookup(data);
    const cases = [
        { tree: [-3200, 1920], seen: [[-3072, 2240], [-3194, 2394], [-3200, 1792]],
            hidden: [[-3200, 1664], [-3776, 1920], [-2688, 1920]] },
        { tree: [-2816, 2560], seen: [[-2825, 2550], [-2560, 2560], [-2816, 3072]],
            hidden: [[-3072, 2240], [-3194, 2394], [-3008, 2496]] },
        { tree: [960, 3776], seen: [[1024, 3584]], hidden: [[0, 0]] },
    ];
    for (const { tree, seen, hidden } of cases) {
        const polygons = lookup(tree).polygons;
        for (const point of seen) assert.equal(contains(polygons, point), true, `${tree} sees ${point}`);
        for (const point of hidden) assert.equal(contains(polygons, point), false, `${tree} cannot see ${point}`);
    }
});

test('Eyes scan import rejects incomplete and duplicate samples, and deduplicates valid patterns', () => {
    const header = '[EYES_SCAN_BEGIN]{"map":"dota","count":2,"radius":800,"cellSize":64,"size":41,"offset":-1280}';
    const rows = Array.from({ length: 41 }, (_, y) => y === 20 ? [19, 22] : []);
    const sample = x => '[EYES_SCAN_TREE]' + JSON.stringify({ x, y: 64, rows });
    const incomplete = createEyesCollector();
    incomplete.accept(header);
    incomplete.accept(sample(64));
    assert.throws(() => incomplete.accept('[EYES_SCAN_DONE]'), /Incomplete/);
    assert.throws(() => incomplete.accept(sample(64)), /duplicate/);
    const clipped = createEyesCollector();
    clipped.accept(header);
    const clippedRows = rows.map(row => [...row]);
    clippedRows[0] = [19, 22];
    assert.throws(() => clipped.accept('[EYES_SCAN_TREE]' + JSON.stringify({ x: 64, y: 64, rows: clippedRows })), /scan boundary/);
    const distant = createEyesCollector();
    distant.accept(header);
    const distantRows = rows.map(row => [...row]);
    distantRows[20] = [19, 22, 35, 36];
    assert.throws(() => distant.accept('[EYES_SCAN_TREE]' + JSON.stringify({ x: 64, y: 64, rows: distantRows })), /Unrelated vision/);
    const collector = createEyesCollector();
    assert.equal(collector.accept('unrelated console output'), undefined);
    collector.accept(header);
    collector.accept(sample(64));
    collector.accept(sample(128));
    const result = collector.accept('[EYES_SCAN_DONE]');
    assert.equal(result.patterns.length, 1);
    assert.deepEqual(result.trees, [[64, 64, 0], [128, 64, 0]]);
});
