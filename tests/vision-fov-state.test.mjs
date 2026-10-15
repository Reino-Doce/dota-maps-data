import test from 'node:test';
import assert from 'node:assert/strict';
import VisionSimulation, { resetVisionSearchState } from '../dist/vision.node.mjs';

test('each shadowcast starts clean after a previous blocked calculation', () => {
    const simulation = new VisionSimulation({ worldMinX: 0, worldMinY: 0, worldMaxX: 0, worldMaxY: 0 });
    const { fov } = simulation;
    const countVisible = () => {
        let count = 0;
        const area = fov.compute(10, 10, 12, () => {
            count += 1;
        });
        return { count, area };
    };
    fov.walls = { '9,10': [['tree', 9, 10, Math.SQRT2]] };
    fov._lightPasses = (x, y) => x !== 9 || y !== 10;

    fov.done = true;
    const staleState = countVisible();
    assert.ok(staleState.count < 30, 'the stale flag reproduces the tiny-vision failure');

    resetVisionSearchState(simulation);
    const recovered = countVisible();
    assert.ok(recovered.count > 400, 'clearing the flag restores the full visible radius');
    assert.equal(recovered.area, 437);
});
