import assert from 'node:assert/strict';
import { test } from 'node:test';
import { unionFeatures } from '../scripts/geojson-union.mjs';

function rectangle(minX, minY, maxX, maxY) {
    return {
        type: 'Feature',
        properties: {},
        geometry: {
            type: 'Polygon',
            coordinates: [[
                [minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY], [minX, minY],
            ]],
        },
    };
}

function bounds(feature) {
    const points = [];
    function collectCoordinates(value) {
        if (typeof value[0] === 'number') {
            points.push(value);
            return;
        }
        value.forEach(collectCoordinates);
    }
    collectCoordinates(feature.geometry.coordinates);
    return [
        Math.min(...points.map(point => point[0])),
        Math.min(...points.map(point => point[1])),
        Math.max(...points.map(point => point[0])),
        Math.max(...points.map(point => point[1])),
    ];
}

test('overlapping ward polygons merge to their combined area', () => {
    const merged = unionFeatures(rectangle(0, 0, 2, 2), rectangle(1, 0, 3, 2));

    assert.equal(merged.geometry.type, 'Polygon');
    assert.deepEqual(bounds(merged), [0, 0, 3, 2]);
    assert.deepEqual(merged.properties, {});
});

test('disconnected ward polygons remain two polygons', () => {
    const merged = unionFeatures(rectangle(0, 0, 1, 1), rectangle(4, 1, 5, 2));

    assert.equal(merged.geometry.type, 'MultiPolygon');
    assert.equal(merged.geometry.coordinates.length, 2);
    assert.deepEqual(bounds(merged), [0, 0, 5, 2]);
});

test('one polygon bypasses union and an empty pair returns null', () => {
    const polygon = rectangle(0, 0, 1, 1);

    assert.equal(unionFeatures(null, polygon), polygon);
    assert.equal(unionFeatures(polygon, null), polygon);
    assert.equal(unionFeatures(null, null), null);
});
