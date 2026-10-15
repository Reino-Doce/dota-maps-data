import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildNeutralSpawnBoxes, parseNeutralSpawnEntities, parseSource2PhysicsHull,
    transformSpawnBoxPoint, mergeNeutralSpawnBoxes, verifyNativeNeutralSpawnGeometry } from '../scripts/neutral-spawn-boxes.mjs';

const modelPath = 'maps/dota/entities/neutralcamp_good_1_2699_9829.vmdl';
const hash = value => value.repeat(64);
const corners = [
    [-10, -20, -5], [10, -20, -5], [10, 20, -5], [-10, 20, -5],
    [-10, -20, 5], [10, -20, 5], [10, 20, 5], [-10, 20, 5],
];

function physicsDump(points = corners, bounds = { min: [-10, -20, -5], max: [10, 20, 5] }) {
    const bytes = Buffer.alloc(points.length * 12);
    points.flat().forEach((value, index) => bytes.writeFloatLE(value, index * 4));
    const hex = bytes.toString('hex').match(/.{2}/gu).join(' ');
    return [
        '--- Data for block "PHYS" ---',
        '{',
        '    m_parts =',
        '    [',
        '        {',
        '            m_rnShape =',
        '            {',
        '                m_spheres = [ ]',
        '                m_capsules = [ ]',
        '                m_hulls =',
        '                [',
        '                    {',
        '                        m_Hull =',
        '                        {',
        '                            m_Bounds =',
        '                            {',
        '                                m_vMinBounds = [ ' + bounds.min.join(', ') + ' ]',
        '                                m_vMaxBounds = [ ' + bounds.max.join(', ') + ' ]',
        '                            }',
        '                            m_VertexPositions =',
        '                            #[',
        '                                ' + hex,
        '                            ]',
        '                        }',
        '                    }',
        '                ]',
        '                m_meshes = [ ]',
        '            }',
        '        }',
        '    ]',
        '}',
    ].join('\n');
}

function entityText({ targetname = '[PR#]neutralcamp_good_1', volumeName = '[PR#]neutralcamp_good_1',
    origin = [100, 200, 300], angles = [0, 0, 0], scales = [1, 1, 1], includeTrigger = true,
    includeSpawner = true, parentname = '', useLocalOffset = false } = {}) {
    const entities = [];
    if (includeTrigger) entities.push([
        '{',
        '    keyValues3Data =',
        '    {',
        '        version = 1',
        '        values =',
        '        {',
        '            local.origin = [ 0, 0, 0 ]',
        '            targetname = "' + targetname + '"',
        '            parentname = "' + parentname + '"',
        '            useLocalOffset = ' + useLocalOffset,
        '            classname = "trigger_multiple"',
        '            origin = [ ' + origin.join(', ') + ' ]',
        '            angles = [ ' + angles.join(', ') + ' ]',
        '            scales = [ ' + scales.join(', ') + ' ]',
        '            model = resource_name:"' + modelPath + '"',
        '        }',
        '    }',
        '}',
    ].join('\n'));
    if (includeSpawner) entities.push([
        '{',
        '    keyValues3Data =',
        '    {',
        '        version = 1',
        '        values =',
        '        {',
        '            VolumeName = "' + volumeName + '"',
        '            classname = "npc_dota_neutral_spawner"',
        '            origin = [ 102, 203, 305 ]',
        '        }',
        '    }',
        '}',
    ].join('\n'));
    return entities.join('\n');
}

function parsedCapture(options) {
    const entities = parseNeutralSpawnEntities(entityText(options));
    const hull = parseSource2PhysicsHull(physicsDump());
    const models = new Map([[modelPath, { ...hull, sha256: hash('a') }]]);
    const source = {
        patch: '741f',
        gameClientVersion: '6955',
        gridnavSha256: hash('b'),
        entityResource: { path: 'maps/dota/entities/default_ents.vents_c', sha256: hash('c') },
        source2ViewerCli: '20.0.6980',
    };
    return { entities, models, source };
}

test('parses the exact Source 2 entity transform fields, not local.origin', () => {
    const entities = parseNeutralSpawnEntities(entityText({ origin: [100, 200, 300] }));
    const trigger = entities.find(entity => entity.classname === 'trigger_multiple');
    assert.deepEqual(trigger.origin, [100, 200, 300]);
    assert.deepEqual(trigger.angles, [0, 0, 0]);
    assert.deepEqual(trigger.scales, [1, 1, 1]);
    assert.equal(trigger.parentname, '');
    assert.equal(trigger.useLocalOffset, false);
    assert.equal(trigger.model, modelPath);
    assert.equal(trigger.targetname, '[PR#]neutralcamp_good_1');
});

test('decodes one PHYS convex hull and verifies its explicit vertex cloud against local bounds', () => {
    const hull = parseSource2PhysicsHull(physicsDump());
    assert.deepEqual(hull.vertices, corners);
    assert.deepEqual(hull.localBounds, { min: [-10, -20, -5], max: [10, 20, 5] });
});

test('projects the complete rotated 3D hull and retains stable camp identity and provenance', () => {
    const capture = parsedCapture({ angles: [0, 90, 0], scales: [2, 1, 1] });
    const boxes = buildNeutralSpawnBoxes({
        camps: [{ triggerName: 'neutralcamp_good_1', neutralType: '2' }],
        ...capture,
    });
    const [box] = boxes;
    assert.equal(box.campId, 'neutralcamp_good_1');
    assert.equal(box.campType, 'large');
    assert.equal(box.neutralType, 2);
    assert.equal(box.points.length, 4, 'the projected hull uses its convex footprint, not an AABB');
    assert.equal(box.vertices.length, 8, 'all original 3D hull vertices remain available');
    assert.deepEqual(box.transform, { origin: [100, 200, 300], angles: [0, 90, 0], scales: [2, 1, 1] });
    assert.deepEqual(box.worldBounds, { min: [80, 180, 295], max: [120, 220, 305] });
    assert.equal(box.source.model.path, modelPath);
    assert.equal(box.source.model.sha256, hash('a'));
    assert.equal(box.source.gridnavSha256, hash('b'));
});

test('applies Source QAngle rotation to all three axes', () => {
    const point = transformSpawnBoxPoint([2, 3, 4], {
        origin: [10, 20, 30], angles: [30, 90, 45], scales: [1, 1, 1],
    });
    assert.ok(point.every(Number.isFinite));
    assert.ok(Math.abs(point[0] - 10.707107) < 0.00001);
    assert.ok(Math.abs(point[1] - 24.206925) < 0.00001);
    assert.ok(Math.abs(point[2] - 33.286607) < 0.00001);
});

test('rejects missing, duplicate, and ambiguous camp-volume associations', () => {
    const camp = { triggerName: 'neutralcamp_good_1', neutralType: '2' };
    const missingTrigger = parsedCapture({ includeTrigger: false });
    assert.throws(() => buildNeutralSpawnBoxes({ camps: [camp], ...missingTrigger }), /trigger_multiple/);

    const duplicateCamp = parsedCapture();
    assert.throws(() => buildNeutralSpawnBoxes({ camps: [camp, camp], ...duplicateCamp }), /duplicate.*camp/i);

    const ambiguousVolume = parsedCapture({ volumeName: '[PR#]neutralcamp_good_2' });
    assert.throws(() => buildNeutralSpawnBoxes({ camps: [camp], ...ambiguousVolume }), /VolumeName|association/i);
});

test('rejects parented and local-offset triggers instead of guessing their world transform', () => {
    const source = parsedCapture();
    const camp = { triggerName: 'neutralcamp_good_1', neutralType: '2' };
    assert.throws(() => buildNeutralSpawnBoxes({ camps: [camp], entities: parseNeutralSpawnEntities(
        entityText({ parentname: 'moving_parent' })), models: source.models, source: source.source }), /unparented and absolute/);
    assert.throws(() => buildNeutralSpawnBoxes({ camps: [camp], entities: parseNeutralSpawnEntities(
        entityText({ useLocalOffset: true })), models: source.models, source: source.source }), /unparented and absolute/);
});

test('rejects malformed hull bytes, unsupported multi-hull models, and inconsistent bounds', () => {
    assert.throws(() => parseSource2PhysicsHull(physicsDump(corners.slice(0, 2))), /at least four|vertex/i);
    assert.throws(() => parseSource2PhysicsHull(physicsDump(corners,
        { min: [-9, -20, -5], max: [10, 20, 5] })), /bounds/i);
    assert.throws(() => parseSource2PhysicsHull(physicsDump().replace('m_hulls =', 'm_hulls =\n []\n m_hulls =')),
        /one.*hull|multiple.*hull/i);
});

test('rejects unsupported patch provenance and unresolved models', () => {
    const capture = parsedCapture();
    assert.throws(() => buildNeutralSpawnBoxes({
        camps: [{ triggerName: 'neutralcamp_good_1', neutralType: '2' }],
        ...capture,
        source: { ...capture.source, patch: '../741f' },
    }), /patch/i);
    assert.throws(() => buildNeutralSpawnBoxes({
        camps: [{ triggerName: 'neutralcamp_good_1', neutralType: '2' }],
        ...capture,
        models: new Map(),
    }), /model/i);
});

test('merges complete camp geometry while preserving unrelated trigger polygons', () => {
    const capture = parsedCapture();
    const [box] = buildNeutralSpawnBoxes({ camps: [{ triggerName: 'neutralcamp_good_1', neutralType: '2' }], ...capture });
    const mapdata = { data: { npc_dota_neutral_spawner: [{ triggerName: box.campId }],
        trigger_multiple: [{ campId: box.campId, points: [] }, { id: 'other-trigger', points: [] }] }, stats: { version: '741f' } };
    const merged = mergeNeutralSpawnBoxes(mapdata, [box]);
    assert.deepEqual(merged.data.trigger_multiple, [{ id: 'other-trigger', points: [] }, box]);
    assert.deepEqual(mapdata.data.trigger_multiple[0], { campId: box.campId, points: [] },
        'the merge leaves the source object untouched until its caller writes');
    assert.throws(() => mergeNeutralSpawnBoxes(mapdata, []), /cover every/);
    assert.throws(() => mergeNeutralSpawnBoxes(mapdata, [box, box]), /duplicate/);
});

test('741f map data contains complete, source-qualified spawn boxes for every neutral camp', () => {
    const mapdata = JSON.parse(readFileSync(new URL('../assets/data/741f/mapdata.json', import.meta.url), 'utf8'));
    const camps = mapdata.data.npc_dota_neutral_spawner;
    const boxes = mapdata.data.trigger_multiple;
    const byCamp = new Map(boxes.map(box => [box.campId, box]));

    assert.equal(boxes.length, camps.length);
    assert.equal(byCamp.size, camps.length, 'each camp has exactly one box');
    for (const camp of camps) assert.ok(byCamp.has(camp.triggerName), `missing box for ${camp.triggerName}`);
    for (const box of boxes) {
        assert.equal(box.source.patch, '741f');
        assert.equal(box.source.gameClientVersion, '6955');
        assert.equal(box.source.entityResource.path, 'maps/dota/entities/default_ents.vents_c');
        assert.match(box.source.entityResource.sha256, /^[a-f0-9]{64}$/);
        assert.match(box.source.model.sha256, /^[a-f0-9]{64}$/);
        assert.equal(box.source.model.path, box.modelResource);
        assert.equal(box.vertices.length, 8);
        assert.equal(box.points.length, 4);
        assert.ok(box.worldBounds.min.every((value, axis) => value < box.worldBounds.max[axis]));
        assert.ok(box.points.every(point => Number.isFinite(point.x) && Number.isFinite(point.y)));
    }
});

test('native camp trigger geometry verifies against exact versioned names, transforms and PHYS bounds', () => {
    const mapdata = JSON.parse(readFileSync(new URL('../assets/data/741f/mapdata.json', import.meta.url), 'utf8'));
    const campCandidates = mapdata.data.trigger_multiple.map((box, entityIndex) => ({
        classname: 'trigger_multiple', entityIndex: entityIndex + 1, name: box.campId,
        origin: box.transform.origin, angles: box.transform.angles,
        boundingMins: box.localBounds.min, boundingMaxs: box.localBounds.max,
    }));
    const unrelatedCandidates = Array.from({ length: 10 }, (_, index) => ({
        classname: 'trigger_multiple', entityIndex: campCandidates.length + index + 1,
        name: index < 8 ? `other_trigger_${index}` : null,
        origin: null, angles: null, boundingMins: null, boundingMaxs: null,
    }));
    const spawnerCandidates = mapdata.data.npc_dota_neutral_spawner.map((spawner, index) => ({
        classname: 'npc_dota_neutral_spawner', entityIndex: campCandidates.length + unrelatedCandidates.length + index + 1,
        name: null, origin: [spawner.x, spawner.y, 128], angles: null, boundingMins: null, boundingMaxs: null,
    }));
    const spawnVolumes = { status: 'partial', available: true, truncated: false,
        classes: {
            trigger_multiple: { available: true, count: 38, truncated: false, partial: true },
            npc_dota_neutral_spawner: { available: true, count: 28, truncated: false, partial: true },
        },
        candidates: [...campCandidates, ...unrelatedCandidates, ...spawnerCandidates] };

    const result = verifyNativeNeutralSpawnGeometry({ spawnVolumes, mapdata, gameClientVersion: 6955 });

    assert.equal(result.status, 'verified');
    assert.equal(result.geometryVerified, true);
    assert.equal(result.association, 'exact-native-trigger-name-to-camp-id');
    assert.equal(result.expectedCampCount, 28);
    assert.equal(result.matchedCampCount, 28);
    assert.equal(result.unassociatedNativeTriggerCount, 10);
    assert.equal(result.spawnerAssociationVerified, true);
    assert.equal(result.matchedSpawnerCount, 28);
    assert.equal(result.spawnerAssociations.length, 28);
    assert.deepEqual(result.missingCampIds, []);
    assert.deepEqual(result.mismatchedCampIds, []);
    assert.deepEqual(result.duplicateCampIds, []);
});

test('native camp geometry stays unverified on version, identity, transform or coverage uncertainty', () => {
    const mapdata = JSON.parse(readFileSync(new URL('../assets/data/741f/mapdata.json', import.meta.url), 'utf8'));
    const boxes = mapdata.data.trigger_multiple;
    const candidateFor = box => ({ classname: 'trigger_multiple', entityIndex: 1, name: box.campId,
        origin: box.transform.origin, angles: box.transform.angles,
        boundingMins: box.localBounds.min, boundingMaxs: box.localBounds.max });
    const spawnerCandidates = mapdata.data.npc_dota_neutral_spawner.map((spawner, index) => ({
        classname: 'npc_dota_neutral_spawner', entityIndex: 100 + index,
        origin: [spawner.x, spawner.y, 0],
    }));
    const spawnVolumes = (triggerCandidates, nativeSpawners = spawnerCandidates) => ({ status: 'partial', available: true, truncated: false,
        classes: {
            trigger_multiple: { available: true, count: triggerCandidates.length, truncated: false, partial: false },
            npc_dota_neutral_spawner: { available: true, count: nativeSpawners.length, truncated: false, partial: true },
        },
        candidates: [...triggerCandidates, ...nativeSpawners] });

    assert.equal(verifyNativeNeutralSpawnGeometry({ spawnVolumes: spawnVolumes(boxes.map(candidateFor)),
        mapdata, gameClientVersion: 6956 }).status, 'unsupported-version');

    const missing = verifyNativeNeutralSpawnGeometry({ spawnVolumes: spawnVolumes(boxes.slice(1).map(candidateFor)),
        mapdata, gameClientVersion: 6955 });
    assert.equal(missing.status, 'partial');
    assert.equal(missing.geometryVerified, false);
    assert.equal(missing.missingCampIds.length, 1);

    const unavailableVector = boxes.map(candidateFor);
    unavailableVector[0] = { ...unavailableVector[0], origin: null };
    const incomplete = verifyNativeNeutralSpawnGeometry({ spawnVolumes: spawnVolumes(unavailableVector), mapdata, gameClientVersion: 6955 });
    assert.equal(incomplete.status, 'partial');
    assert.deepEqual(incomplete.incompleteCampIds, [boxes[0].campId]);

    const changed = boxes.map(candidateFor);
    changed[0] = { ...changed[0], origin: [changed[0].origin[0] + 1, ...changed[0].origin.slice(1)] };
    const mismatch = verifyNativeNeutralSpawnGeometry({ spawnVolumes: spawnVolumes(changed), mapdata, gameClientVersion: 6955 });
    assert.equal(mismatch.status, 'mismatch');
    assert.equal(mismatch.geometryVerified, false);
    assert.deepEqual(mismatch.mismatchedCampIds, [boxes[0].campId]);

    const duplicate = verifyNativeNeutralSpawnGeometry({ spawnVolumes: spawnVolumes([
        ...boxes.map(candidateFor), candidateFor(boxes[0]),
    ]), mapdata, gameClientVersion: 6955 });
    assert.equal(duplicate.status, 'mismatch');
    assert.deepEqual(duplicate.duplicateCampIds, [boxes[0].campId]);

    const movedSpawners = spawnerCandidates.map(candidate => ({ ...candidate, origin: [...candidate.origin] }));
    movedSpawners[0].origin[0] += 2;
    const wrongSpawner = verifyNativeNeutralSpawnGeometry({ spawnVolumes: spawnVolumes(boxes.map(candidateFor), movedSpawners),
        mapdata, gameClientVersion: 6955 });
    assert.equal(wrongSpawner.status, 'mismatch');
    assert.equal(wrongSpawner.spawnerAssociationVerified, false);
    assert.equal(wrongSpawner.mismatchedNativeSpawnerCount, 1);
});
