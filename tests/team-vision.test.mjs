import assert from 'node:assert/strict';
import { test } from 'node:test';
import { actionTeam, TeamVisionIndex, normalizeTeam } from '../src/teamVision.mjs';

const circle = (center, radius) => ({ intersectsCoordinate: ([x, y]) => Math.hypot(x - center[0], y - center[1]) <= radius });
const inRing = ([x, y], ring) => {
    let inside = false;
    for (let current = 0, previous = ring.length - 1; current < ring.length; previous = current++) {
        const [x1, y1] = ring[current], [x2, y2] = ring[previous];
        if ((y1 > y) !== (y2 > y) && x < (x2 - x1) * (y - y1) / (y2 - y1) + x1) inside = !inside;
    }
    return inside;
};
const polygon = rings => ({ intersectsCoordinate: point => inRing(point, rings[0])
    && !rings.slice(1).some(ring => inRing(point, ring)) });

test('enemy wards require allied normal vision and detection at the same position', () => {
    const index = new TeamVisionIndex();
    const ground = { team: 'radiant', geometry: circle([0, 0], 800) };
    const sentry = { team: 'radiant', geometry: circle([400, 0], 1000), trueSight: true };
    assert.ok(index.canSeeWard('dire', 'dire', [4000, 0]), 'own wards remain visible in fog');
    index.replace([sentry]);
    assert.equal(index.hasVision('radiant', [100, 0]), false);
    assert.equal(index.canSeeWard('radiant', 'dire', [100, 0]), false);
    index.replace([ground]);
    assert.equal(index.canSeeWard('radiant', 'dire', [100, 0]), false);
    index.replace([ground, sentry]);
    assert.ok(index.canSeeWard('radiant', 'dire', [100, 0]));
    assert.equal(index.canSeeWard('radiant', 'dire', [1000, 0]), false, 'detection beyond allied sight stays hidden');
    assert.equal(index.hasVision('dire', [100, 0]), false, 'opponents never share normal vision');
    assert.equal(index.hasTrueSight('dire', [100, 0]), false);
    index.replace([ground, { ...sentry, active: false }]);
    assert.equal(index.canSeeWard('radiant', 'dire', [100, 0]), false, 'destroyed detection sources stop revealing wards');
});

test('terrain shadows and holes remain fogged and overlapping sources survive destruction', () => {
    const index = new TeamVisionIndex();
    const blocked = polygon([[[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]],
        [[40, 40], [60, 40], [60, 60], [40, 60], [40, 40]]]);
    const tower = { team: 'radiant', geometry: blocked };
    const ward = { team: 'radiant', geometry: circle([30, 50], 25) };
    const detection = { team: 'radiant', geometry: circle([50, 50], 100), trueSight: true };
    index.replace([tower, detection]);
    assert.ok(index.hasVision('radiant', [20, 50]));
    assert.equal(index.canSeeWard('radiant', 'dire', [50, 50]), false);
    index.replace([tower, ward, detection]);
    assert.ok(index.canSeeWard('radiant', 'dire', [50, 50]), 'another viewer can reveal a terrain shadow');
    index.replace([{ ...tower, active: false }, ward, detection]);
    assert.ok(index.hasVision('radiant', [20, 50]));
    assert.equal(index.hasVision('radiant', [90, 90]), false);
    index.replace([{ team: 'neutral', geometry: blocked }]);
    assert.equal(index.hasVision('radiant', [20, 50]), false);
    assert.equal(index.hasVision('dire', [20, 50]), false);
    assert.equal(normalizeTeam('dire'), 'dire');
    assert.equal(normalizeTeam('both'), 'both');
    assert.equal(normalizeTeam('invalid'), 'radiant');
    assert.equal(actionTeam({ team: 'both', placementTeam: 'dire' }), 'dire');
    assert.equal(actionTeam({ team: 'both', placementTeam: 'invalid' }), 'radiant');
});

test('Both combines both teams vision and reveals both teams wards without changing source ownership', () => {
    const index = new TeamVisionIndex();
    const radiantSight = { team: 'radiant', geometry: circle([0, 0], 800) };
    const direSight = { team: 'dire', geometry: circle([2000, 0], 800) };
    const radiantDetection = { team: 'radiant', geometry: circle([0, 0], 1000), trueSight: true };
    const direDetection = { team: 'dire', geometry: circle([2000, 0], 1000), trueSight: true };
    index.replace([radiantSight, direSight, radiantDetection, direDetection]);
    assert.ok(index.hasVision('both', [0, 0]));
    assert.ok(index.hasVision('both', [2000, 0]));
    assert.ok(index.hasTrueSight('both', [0, 0]));
    assert.ok(index.hasTrueSight('both', [2000, 0]));
    assert.ok(index.canSeeWard('both', 'radiant', [7000, 0]));
    assert.ok(index.canSeeWard('both', 'dire', [-7000, 0]));
    assert.equal(index.hasVision('radiant', [2000, 0]), false);
    assert.equal(index.hasVision('dire', [0, 0]), false);
});
