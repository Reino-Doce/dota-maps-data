import test from 'node:test';
import assert from 'node:assert/strict';
import { gridKeysToFeature } from '../scripts/generate-legacy-geojson.mjs';

const vision = {
    gridWidth: 3,
    gridHeight: 2,
    worldMinX: 0,
    worldMinY: 0,
    key2pt: key => {
        const [x, y] = key.split(',').map(Number);
        return { x, y };
    },
};

function polygonArea(ring) {
    return Math.abs(ring.slice(0, -1).reduce((sum, point, index) => {
        const next = ring[index + 1];
        return sum + point[0] * next[1] - next[0] * point[1];
    }, 0) / 2);
}

test('legacy raster cells contour to exact world-space cell boundaries', () => {
    const feature = gridKeysToFeature(vision, ['0,0', '1,0', '1,1'], { elevation: '20' });
    assert.equal(feature.type, 'Feature');
    assert.deepEqual(feature.properties, { elevation: '20' });
    assert.equal(feature.geometry.type, 'MultiPolygon');
    assert.equal(feature.geometry.coordinates.length, 1);
    assert.equal(polygonArea(feature.geometry.coordinates[0][0]), 3 * 64 * 64);
});

test('legacy raster contours retain disconnected islands and return null for empty masks', () => {
    const feature = gridKeysToFeature(vision, ['0,0', '2,1']);
    assert.equal(feature.geometry.coordinates.length, 2);
    assert.equal(gridKeysToFeature(vision, []), null);
});
