import assert from 'node:assert/strict';
import { test } from 'node:test';
import getLightUnion from '../src/getLightUnion.mjs';

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
const ringArea = ring => Math.abs(ring.reduce((sum, point, index) => {
    const next = ring[(index + 1) % ring.length];
    return sum + point[0] * next[1] - next[0] * point[1];
}, 0) / 2);

test('ground sight preserves dark holes, disconnected islands and diagonal contacts cell for cell', () => {
    const grid = Array.from({ length: 9 }, (_, x) => Array.from({ length: 9 }, (_, y) => ({ x, y, key: `${x},${y}` })));
    const lights = {};
    for (let y = 0; y < 5; y++) {
        for (let x = 0; x < 5; x++) {
            if (x !== 2 || y !== 2) lights[`${x},${y}`] = 255;
        }
    }
    lights['7,7'] = 255;
    lights['8,8'] = 255;
    const polygons = getLightUnion(grid, lights);
    for (let y = 0; y < 9; y++) {
        for (let x = 0; x < 9; x++) {
            assert.equal(contains(polygons, [x, y]), !!lights[`${x},${y}`], `visibility at ${x},${y}`);
        }
    }
    assert.equal(polygons.reduce((sum, rings) => sum + ringArea(rings[0])
        - rings.slice(1).reduce((holes, ring) => holes + ringArea(ring), 0), 0), Object.keys(lights).length);
    assert.equal(polygons.length, 3);
    assert.deepEqual(getLightUnion(grid, {}), []);
});
