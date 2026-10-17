import { parseEntityBoolean, parseEntityVector, parseSource2EntityDump } from './source2-entities.mjs';
import { featureCollection, polygon } from '@turf/helpers';
import { union } from '@turf/union';
const campTypes = ['small', 'medium', 'large', 'ancient'];
const targetPrefix = '[PR#]neutralcamp_';
const hashPattern = /^[a-f0-9]{64}$/i;
const campIdPattern = /^neutralcamp_(?:good|evil)_\d+$/;
const modelPathPattern = /^maps\/dota(?:_[a-z0-9]+)?\/entities\/neutralcamp_[a-z0-9_]+\.vmdl$/i;

function matchingDelimiter(text, start, open, close) {
    if (text[start] !== open) throw new Error('Expected a balanced source delimiter.');
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
        const character = text[index];
        if (quoted) {
            if (escaped) escaped = false;
            else if (character === '\\') escaped = true;
            else if (character === '"') quoted = false;
            continue;
        }
        if (character === '"') quoted = true;
        else if (character === open) depth += 1;
        else if (character === close) {
            depth -= 1;
            if (depth === 0) return index;
        }
    }
    throw new Error('Unclosed source structure.');
}

function escapeRegExp(value) {
    return value.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
}

function propertyMatches(block, name, expression) {
    const pattern = new RegExp('(?:^|\\r?\\n)\\s*' + escapeRegExp(name) + '\\s*=\\s*' + expression, 'gm');
    return [...block.matchAll(pattern)];
}

function readString(block, name) {
    const matches = propertyMatches(block, name, '"((?:\\\\.|[^"\\\\])*)"');
    if (matches.length > 1) throw new Error('Duplicate Source 2 entity field: ' + name);
    if (!matches.length) return null;
    try {
        return JSON.parse('"' + matches[0][1] + '"');
    }
    catch {
        throw new Error('Invalid quoted Source 2 entity field: ' + name);
    }
}

function readResourceName(block, name) {
    const matches = propertyMatches(block, name, 'resource_name:"((?:\\\\.|[^"\\\\])*)"');
    if (matches.length > 1) throw new Error('Duplicate Source 2 entity resource field: ' + name);
    if (!matches.length) return null;
    try {
        return JSON.parse('"' + matches[0][1] + '"');
    }
    catch {
        throw new Error('Invalid Source 2 entity resource field: ' + name);
    }
}

function readBoolean(block, name) {
    const matches = propertyMatches(block, name, '(true|false)');
    if (matches.length > 1) throw new Error('Duplicate Source 2 entity boolean field: ' + name);
    if (!matches.length) return null;
    return matches[0][1] === 'true';
}

function readVector(block, name) {
    const matches = propertyMatches(block, name, '\\[([^\\]]*)\\]');
    if (matches.length > 1) throw new Error('Duplicate Source 2 entity vector field: ' + name);
    if (!matches.length) return null;
    const values = matches[0][1].split(',').map(value => value.trim()).filter(Boolean).map(Number);
    if (values.length !== 3 || !values.every(Number.isFinite)) {
        throw new Error('Invalid Source 2 entity vector field: ' + name);
    }
    return values;
}

function readEntityValues(text, start) {
    const end = matchingDelimiter(text, start, '{', '}');
    const object = text.slice(start + 1, end);
    const valuesMatch = /\bvalues\s*=\s*\{/m.exec(object);
    if (!valuesMatch) throw new Error('Source 2 entity has no key-value data.');
    const valuesStart = start + 1 + valuesMatch.index + valuesMatch[0].lastIndexOf('{');
    const valuesEnd = matchingDelimiter(text, valuesStart, '{', '}');
    const block = text.slice(valuesStart + 1, valuesEnd);
    const classname = readString(block, 'classname');
    if (classname !== 'trigger_multiple' && classname !== 'npc_dota_neutral_spawner') return null;
    return {
        classname,
        targetname: readString(block, 'targetname'),
        parentname: readString(block, 'parentname'),
        useLocalOffset: readBoolean(block, 'useLocalOffset'),
        volumeName: readString(block, 'VolumeName'),
        origin: readVector(block, 'origin'),
        angles: readVector(block, 'angles'),
        scales: readVector(block, 'scales'),
        model: readResourceName(block, 'model'),
    };
}

export function parseNeutralSpawnEntities(text) {
    if (typeof text !== 'string' || !text.length) throw new Error('Empty Source 2 entity data.');
    if (!/\bkeyValues3Data\s*=\s*\{/u.test(text)) {
        const entities = parseSource2EntityDump(text).filter(entity => entity.classname === 'trigger_multiple'
            || entity.classname === 'npc_dota_neutral_spawner');
        if (!entities.length) throw new Error('No neutral spawn entities were found in the Source 2 dump.');
        return entities.map(entity => ({
            classname: entity.classname,
            targetname: entity.targetname ?? '',
            parentname: entity.parentname ?? '',
            useLocalOffset: parseEntityBoolean(entity.uselocaloffset, false),
            volumeName: entity.volumename ?? '',
            origin: parseEntityVector(entity.origin, 'origin'),
            angles: entity.angles === undefined ? [0, 0, 0] : parseEntityVector(entity.angles, 'angles'),
            scales: entity.scales === undefined ? [1, 1, 1] : parseEntityVector(entity.scales, 'scales'),
            model: typeof entity.model === 'string' ? entity.model.split(String.fromCharCode(92)).join('/') : null,
        }));
    }
    const entities = [];
    const starts = /\bkeyValues3Data\s*=\s*\{/g;
    for (const match of text.matchAll(starts)) {
        const open = match.index + match[0].lastIndexOf('{');
        const entity = readEntityValues(text, open);
        if (entity) entities.push(entity);
    }
    if (!entities.length) throw new Error('No neutral spawn entities were found in the Source 2 dump.');
    return entities;
}

function readArray(block, name) {
    const expression = new RegExp('\\b' + escapeRegExp(name) + '\\s*=\\s*\\[([^\\]]*)\\]');
    const match = expression.exec(block);
    if (!match) throw new Error('Unsupported PHYS shape; missing ' + name + ' array.');
    return match[1].trim();
}

function vectorInBlock(block, name) {
    const expression = new RegExp('\\b' + escapeRegExp(name) + '\\s*=\\s*\\[([^\\]]*)\\]');
    const match = expression.exec(block);
    if (!match) throw new Error('PHYS hull is missing ' + name + '.');
    const vector = match[1].split(',').map(value => Number(value.trim()));
    if (vector.length !== 3 || !vector.every(Number.isFinite)) {
        throw new Error('PHYS hull contains an invalid ' + name + ' vector.');
    }
    return vector;
}

function vectorBounds(points) {
    return {
        min: [0, 1, 2].map(axis => Math.min(...points.map(point => point[axis]))),
        max: [0, 1, 2].map(axis => Math.max(...points.map(point => point[axis]))),
    };
}

function parsePhysicsHullBlock(hull) {
    const min = vectorInBlock(hull, 'm_vMinBounds');
    const max = vectorInBlock(hull, 'm_vMaxBounds');
    if (min.some((value, axis) => value >= max[axis])) throw new Error('PHYS hull bounds have no volume.');

    let vertices;
    const encoded = hull.match(/\bm_VertexPositions\s*=\s*#\[\s*([\s\S]*?)\]/)
        || hull.match(/\bm_Vertices\s*=\s*#\[\s*([\s\S]*?)\]/);
    if (encoded) {
        const hex = encoded[1].replace(/\s+/g, '');
        if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) throw new Error('PHYS hull vertex bytes are malformed.');
        const bytes = Buffer.from(hex, 'hex');
        if (bytes.length < 48 || bytes.length % 12 !== 0) {
            throw new Error('PHYS hull must provide at least four complete 3D vertices.');
        }
        vertices = [];
        for (let offset = 0; offset < bytes.length; offset += 12) {
            const point = [0, 4, 8].map(axis => bytes.readFloatLE(offset + axis));
            if (!point.every(Number.isFinite)) throw new Error('PHYS hull contains a non-finite vertex.');
            vertices.push(point);
        }
    }
    else {
        const vertexField = /\bm_Vertices\s*=\s*/.exec(hull);
        if (!vertexField) throw new Error('PHYS hull is missing m_VertexPositions or m_Vertices.');
        const arrayStart = hull.indexOf('[', vertexField.index + vertexField[0].length);
        const arrayEnd = matchingDelimiter(hull, arrayStart, '[', ']');
        const arrayText = hull.slice(arrayStart + 1, arrayEnd);
        const number = '[-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?';
        const vectorPattern = new RegExp('\\[\\s*(' + number + ')\\s*,\\s*(' + number
            + ')\\s*,\\s*(' + number + ')\\s*\\]', 'gu');
        vertices = [...arrayText.matchAll(vectorPattern)].map(match => match.slice(1).map(Number));
        if (vertices.length < 4 || vertices.some(point => !point.every(Number.isFinite))) {
            throw new Error('PHYS hull must provide at least four complete 3D vertices.');
        }
    }
    if (new Set(vertices.map(point => point.join(','))).size !== vertices.length) {
        throw new Error('PHYS hull contains duplicate vertices.');
    }
    const actualBounds = vectorBounds(vertices);
    for (let axis = 0; axis < 3; axis += 1) {
        if (Math.abs(actualBounds.min[axis] - min[axis]) > 0.02
            || Math.abs(actualBounds.max[axis] - max[axis]) > 0.02) {
            throw new Error('PHYS hull vertices disagree with its recorded bounds.');
        }
    }
    return { vertices, localBounds: { min, max } };
}

export function parseSource2PhysicsHull(text) {
    if (typeof text !== 'string' || !text.length) throw new Error('Empty Source 2 PHYS data.');
    const physStart = text.indexOf('--- Data for block "PHYS" ---');
    const phys = physStart < 0 ? text : text.slice(physStart);
    const hullArrayMatches = [...phys.matchAll(/\bm_hulls\s*=\s*/g)];
    if (hullArrayMatches.length !== 1) throw new Error('Spawn box models must contain one PHYS hull array.');
    for (const field of ['m_spheres', 'm_capsules', 'm_meshes']) {
        if (readArray(phys, field) !== '') throw new Error('Unsupported non-hull PHYS primitive: ' + field);
    }
    const hullArrayStart = phys.indexOf('[', hullArrayMatches[0].index + hullArrayMatches[0][0].length);
    const hullArrayEnd = matchingDelimiter(phys, hullArrayStart, '[', ']');
    const hullArray = phys.slice(hullArrayStart + 1, hullArrayEnd);
    const hullEntries = [...hullArray.matchAll(/\bm_Hull\s*=\s*/g)];
    if (hullEntries.length === 0) throw new Error('Spawn box models must contain at least one convex PHYS hull.');
    const hulls = hullEntries.map(entry => {
        const open = hullArray.indexOf('{', entry.index + entry[0].length);
        const close = matchingDelimiter(hullArray, open, '{', '}');
        return parsePhysicsHullBlock(hullArray.slice(open + 1, close));
    });
    const vertices = hulls.flatMap(hull => hull.vertices);
    return { vertices, hulls, localBounds: vectorBounds(vertices) };
}

function vector(value, name) {
    if (!Array.isArray(value) || value.length !== 3 || !value.every(Number.isFinite)) {
        throw new Error('Invalid spawn box ' + name + ' vector.');
    }
    return value;
}

export function transformSpawnBoxPoint(point, transform) {
    const [x0, y0, z0] = vector(point, 'vertex');
    const [originX, originY, originZ] = vector(transform.origin, 'origin');
    const [pitch, yaw, roll] = vector(transform.angles, 'angles').map(value => value * Math.PI / 180);
    const [scaleX, scaleY, scaleZ] = vector(transform.scales, 'scale');
    if ([scaleX, scaleY, scaleZ].some(value => value <= 0)) throw new Error('Spawn box scales must be positive.');
    const x = x0 * scaleX;
    const y = y0 * scaleY;
    const z = z0 * scaleZ;
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const cr = Math.cos(roll), sr = Math.sin(roll);
    return [
        originX + cp * cy * x + (sr * sp * cy - cr * sy) * y + (cr * sp * cy + sr * sy) * z,
        originY + cp * sy * x + (sr * sp * sy + cr * cy) * y + (cr * sp * sy - sr * cy) * z,
        originZ - sp * x + sr * cp * y + cr * cp * z,
    ];
}

function convexHull(points) {
    const unique = new Map(points.map(point => [point.map(value => value.toFixed(6)).join(','), point]));
    const sorted = [...unique.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (sorted.length < 3) throw new Error('Spawn box has fewer than three unique projected vertices.');
    const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const lower = [];
    for (const point of sorted) {
        while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), point) <= 1e-8) lower.pop();
        lower.push(point);
    }
    const upper = [];
    for (const point of sorted.toReversed()) {
        while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), point) <= 1e-8) upper.pop();
        upper.push(point);
    }
    const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
    const area = hull.reduce((sum, point, index) => {
        const next = hull[(index + 1) % hull.length];
        return sum + point[0] * next[1] - next[0] * point[1];
    }, 0) / 2;
    if (hull.length < 3 || !Number.isFinite(area) || area <= 1e-6) {
        throw new Error('Spawn box has an empty or degenerate 2D footprint.');
    }
    return hull;
}

function mergeHullFootprints(rings) {
    if (rings.length === 1) return rings[0];
    const merged = union(featureCollection(rings.map(ring => polygon([[...ring, ring[0]]]))));
    if (merged?.geometry.type !== 'Polygon' || merged.geometry.coordinates.length !== 1) {
        throw new Error('Neutral camp compound hull must form one polygon without holes.');
    }
    const ring = merged.geometry.coordinates[0].slice(0, -1);
    if (ring.length < 3) throw new Error('Neutral camp compound hull has a degenerate footprint.');
    return ring;
}

function validHash(value) {
    return typeof value === 'string' && hashPattern.test(value);
}

function campIdFromName(value, name) {
    if (typeof value !== 'string' || !value.startsWith(targetPrefix)) {
        throw new Error('Neutral spawn ' + name + ' must use a [PR#]neutralcamp_* identifier.');
    }
    const campId = value.slice('[PR#]'.length);
    if (!campIdPattern.test(campId)) throw new Error('Invalid neutral spawn camp identifier.');
    return campId;
}

function validateSource(source) {
    if (!source || typeof source.patch !== 'string' || !/^[a-z0-9]+$/i.test(source.patch)) {
        throw new Error('Unsupported or invalid neutral spawn patch.');
    }
    if (source.gameClientVersion !== null && source.gameClientVersion !== undefined
        && (typeof source.gameClientVersion !== 'string' || !/^\d+$/.test(source.gameClientVersion))) {
        throw new Error('Invalid Dota client version in neutral spawn source metadata.');
    }
    if (!(source.gridnavSha256 === null || validHash(source.gridnavSha256)) || !source.entityResource
        || !/^maps\/dota(?:_[a-z0-9]+)?\/entities\/default_ents\.vents_c$/i.test(source.entityResource.path || '')
        || !validHash(source.entityResource.sha256)) {
        throw new Error('Neutral spawn source metadata is incomplete.');
    }
}

export function buildNeutralSpawnBoxes({ camps, entities, models, source }) {
    validateSource(source);
    if (!Array.isArray(camps) || !camps.length || !Array.isArray(entities) || !(models instanceof Map)) {
        throw new Error('Neutral camp, entity, or model source data is incomplete.');
    }
    const campById = new Map();
    for (const camp of camps) {
        if (!campIdPattern.test(camp?.triggerName || '') || campById.has(camp.triggerName)) {
            throw new Error('Invalid or duplicate neutral camp identity.');
        }
        campById.set(camp.triggerName, camp);
    }

    const triggers = entities.filter(entity => entity.classname === 'trigger_multiple'
        && typeof entity.targetname === 'string' && entity.targetname.startsWith(targetPrefix));
    const spawners = entities.filter(entity => entity.classname === 'npc_dota_neutral_spawner');
    if (triggers.length !== camps.length || spawners.length !== camps.length) {
        throw new Error('Neutral camp trigger_multiple and spawner counts do not match mapdata.');
    }
    const triggerById = new Map();
    for (const trigger of triggers) {
        const campId = campIdFromName(trigger.targetname, 'trigger targetname');
        if (triggerById.has(campId)) throw new Error('Duplicate trigger_multiple association for ' + campId + '.');
        if (trigger.parentname !== '' || trigger.useLocalOffset !== false) {
            throw new Error('Neutral camp trigger transform must be unparented and absolute: ' + campId + '.');
        }
        vector(trigger.origin, 'origin');
        vector(trigger.angles, 'angles');
        vector(trigger.scales, 'scale');
        if (!trigger.model || !modelPathPattern.test(trigger.model) || trigger.model.includes('..')) {
            throw new Error('Neutral camp trigger has an invalid hull model resource.');
        }
        triggerById.set(campId, trigger);
    }
    const spawnerById = new Map();
    for (const spawner of spawners) {
        const campId = campIdFromName(spawner.volumeName, 'VolumeName');
        if (spawnerById.has(campId)) throw new Error('Duplicate spawner VolumeName association for ' + campId + '.');
        spawnerById.set(campId, spawner);
    }
    if (triggerById.size !== campById.size || spawnerById.size !== campById.size
        || [...campById.keys()].some(id => !triggerById.has(id) || !spawnerById.has(id))) {
        throw new Error('Neutral camp triggerName, targetname, and VolumeName associations are ambiguous or incomplete.');
    }

    return [...campById].map(([campId, camp]) => {
        const trigger = triggerById.get(campId);
        const model = models.get(trigger.model);
        if (!model || !validHash(model.sha256) || !Array.isArray(model.vertices)
            || !model.localBounds?.min || !model.localBounds?.max) {
            throw new Error('Neutral camp hull model is unresolved or incomplete: ' + trigger.model);
        }
        const neutralType = Number(camp.neutralType);
        if (!Number.isInteger(neutralType) || neutralType < 0 || neutralType >= campTypes.length) {
            throw new Error('Neutral camp type is unsupported for ' + campId + '.');
        }
        const transform = { origin: trigger.origin, angles: trigger.angles, scales: trigger.scales };
        const hulls = Array.isArray(model.hulls) && model.hulls.length ? model.hulls : [{ vertices: model.vertices }];
        if (hulls.some(hull => !Array.isArray(hull?.vertices) || hull.vertices.length < 4)) {
            throw new Error('Neutral camp hull model has an incomplete convex component: ' + trigger.model);
        }
        const vertices = hulls.flatMap(hull => hull.vertices.map(point => transformSpawnBoxPoint(point, transform)));
        const rings = hulls.map(hull => convexHull(hull.vertices.map(point => {
            const [x, y] = transformSpawnBoxPoint(point, transform);
            return [x, y];
        })));
        const points = mergeHullFootprints(rings);
        const worldBounds = vectorBounds(vertices);
        return {
            campId,
            campType: campTypes[neutralType],
            neutralType,
            triggerName: camp.triggerName,
            targetname: trigger.targetname,
            modelResource: trigger.model,
            points: points.map(([x, y]) => ({ x, y })),
            vertices,
            localBounds: model.localBounds,
            worldBounds,
            transform,
            source: {
                ...source,
                entityResource: { ...source.entityResource },
                model: { path: trigger.model, ...(model.sourcePath ? { sourcePath: model.sourcePath } : {}),
                    sha256: model.sha256 },
            },
        };
    }).sort((a, b) => a.campId.localeCompare(b.campId));
}

export function mergeNeutralSpawnBoxes(mapdata, boxes) {
    if (!mapdata || !mapdata.data || !Array.isArray(mapdata.data.trigger_multiple)
        || !Array.isArray(mapdata.data.npc_dota_neutral_spawner) || !Array.isArray(boxes)) {
        throw new Error('Mapdata does not contain the neutral camp and polygon collections.');
    }
    const campIds = new Set(mapdata.data.npc_dota_neutral_spawner.map(camp => camp?.triggerName));
    const boxIds = new Set();
    for (const box of boxes) {
        if (typeof box?.campId !== 'string' || !campIds.has(box.campId) || boxIds.has(box.campId)) {
            throw new Error('Neutral spawn boxes contain an unknown or duplicate camp identity.');
        }
        boxIds.add(box.campId);
    }
    if (boxIds.size !== campIds.size || [...campIds].some(campId => !boxIds.has(campId))) {
        throw new Error('Neutral spawn boxes do not cover every mapdata camp.');
    }
    const retained = mapdata.data.trigger_multiple.filter(polygon =>
        !boxIds.has(polygon?.campId) && !boxIds.has(polygon?.triggerName));
    return { ...mapdata, data: { ...mapdata.data, trigger_multiple: [...retained, ...boxes] } };
}

function finiteVector(value) {
    return Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
}

function vectorsMatch(actual, expected, tolerance) {
    return finiteVector(actual) && finiteVector(expected)
        && actual.every((value, index) => Math.abs(value - expected[index]) <= tolerance);
}

/**
 * Verifies the named neutral-camp trigger hulls observed in a managed local match against the
 * versioned Source 2 import. Unnamed native triggers are reported as unassociated and never
 * assigned to a camp by proximity.
 */
export function verifyNativeNeutralSpawnGeometry({ spawnVolumes, mapdata, gameClientVersion, tolerance = 0.05 } = {}) {
    const unavailable = (status, reason, extras = {}) => ({ status, geometryVerified: false,
        association: 'not-inferred', source: null, tolerance, expectedCampCount: 0, matchedCampCount: 0,
        missingCampIds: [], incompleteCampIds: [], mismatchedCampIds: [], duplicateCampIds: [],
        unassociatedNativeTriggerCount: 0,
        spawnerAssociationVerified: false, matchedSpawnerCount: 0, missingSpawnerCampIds: [],
        duplicateSpawnerCampIds: [], ambiguousSpawnerCampIds: [], unassociatedNativeSpawnerCount: 0,
        mismatchedNativeSpawnerCount: 0, spawnerAssociations: [], reason, ...extras });

    if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 1) {
        return unavailable('unavailable', 'invalid-tolerance');
    }
    const boxes = mapdata?.data?.trigger_multiple;
    const camps = mapdata?.data?.npc_dota_neutral_spawner;
    if (!Array.isArray(boxes) || !Array.isArray(camps) || !boxes.length || boxes.length !== camps.length) {
        return unavailable('unavailable', 'mapdata-incomplete');
    }

    const campBoxes = boxes.filter(box => campIdPattern.test(box?.campId || ''));
    const sourceValues = new Set(campBoxes.map(box => `${box?.source?.patch}:${box?.source?.gameClientVersion}`));
    if (campBoxes.length !== camps.length || sourceValues.size !== 1) {
        return unavailable('unavailable', 'mapdata-source-incomplete');
    }
    const [sourceValue] = sourceValues;
    const [patch, sourceClientVersion] = sourceValue.split(':');
    const source = { patch, gameClientVersion: sourceClientVersion };
    if (typeof gameClientVersion !== 'string' && typeof gameClientVersion !== 'number') {
        return unavailable('unavailable', 'client-version-unavailable', { source, expectedCampCount: campBoxes.length });
    }
    if (String(gameClientVersion) !== sourceClientVersion) {
        return unavailable('unsupported-version', 'client-version-mismatch', { source, expectedCampCount: campBoxes.length });
    }

    const candidates = spawnVolumes?.candidates;
    const triggerClass = spawnVolumes?.classes?.trigger_multiple;
    const spawnerClass = spawnVolumes?.classes?.npc_dota_neutral_spawner;
    if (!Array.isArray(candidates) || !triggerClass?.available || triggerClass.truncated
        || !spawnerClass?.available || spawnerClass.truncated || spawnVolumes.truncated
        || candidates.filter(candidate => candidate?.classname === 'trigger_multiple').length !== triggerClass.count
        || candidates.filter(candidate => candidate?.classname === 'npc_dota_neutral_spawner').length !== spawnerClass.count) {
        return unavailable('partial', 'native-census-incomplete', { source, expectedCampCount: campBoxes.length });
    }

    const expectedById = new Map(campBoxes.map(box => [box.campId, box]));
    const spawnerById = new Map();
    for (const spawner of camps) {
        if (!campIdPattern.test(spawner?.triggerName || '') || !Number.isFinite(spawner.x) || !Number.isFinite(spawner.y)
            || spawnerById.has(spawner.triggerName)) {
            return unavailable('unavailable', 'mapdata-spawner-association-incomplete', { source,
                expectedCampCount: campBoxes.length });
        }
        spawnerById.set(spawner.triggerName, spawner);
    }
    if (spawnerById.size !== expectedById.size || [...expectedById.keys()].some(campId => !spawnerById.has(campId))) {
        return unavailable('unavailable', 'mapdata-spawner-association-incomplete', { source,
            expectedCampCount: campBoxes.length });
    }

    const candidatesById = new Map();
    let unassociatedNativeTriggerCount = 0;
    for (const candidate of candidates) {
        if (candidate?.classname !== 'trigger_multiple') continue;
        if (!campIdPattern.test(candidate.name || '') || !expectedById.has(candidate.name)) {
            unassociatedNativeTriggerCount += 1;
            continue;
        }
        const matches = candidatesById.get(candidate.name) || [];
        matches.push(candidate);
        candidatesById.set(candidate.name, matches);
    }

    const missingCampIds = [];
    const incompleteCampIds = [];
    const mismatchedCampIds = [];
    const duplicateCampIds = [];
    let matchedCampCount = 0;
    for (const [campId, box] of expectedById) {
        const nativeCandidates = candidatesById.get(campId) || [];
        if (nativeCandidates.length === 0) {
            missingCampIds.push(campId);
            continue;
        }
        if (nativeCandidates.length !== 1) {
            duplicateCampIds.push(campId);
            continue;
        }

        const [native] = nativeCandidates;
        const transform = box.transform;
        const localBounds = box.localBounds;
        if (!finiteVector(transform?.origin) || !finiteVector(transform?.angles)
            || !finiteVector(localBounds?.min) || !finiteVector(localBounds?.max)
            || !finiteVector(native.origin) || !finiteVector(native.angles)
            || !finiteVector(native.boundingMins) || !finiteVector(native.boundingMaxs)) {
            incompleteCampIds.push(campId);
            continue;
        }
        if (!vectorsMatch(native.origin, transform.origin, tolerance)
            || !vectorsMatch(native.angles, transform.angles, tolerance)
            || !vectorsMatch(native.boundingMins, localBounds.min, tolerance)
            || !vectorsMatch(native.boundingMaxs, localBounds.max, tolerance)) {
            mismatchedCampIds.push(campId);
            continue;
        }
        matchedCampCount += 1;
    }

    const geometryVerified = matchedCampCount === campBoxes.length && missingCampIds.length === 0
        && incompleteCampIds.length === 0 && mismatchedCampIds.length === 0 && duplicateCampIds.length === 0;
    const nativeSpawners = candidates.filter(candidate => candidate?.classname === 'npc_dota_neutral_spawner');
    const nativeSpawnersByCampId = new Map();
    const ambiguousSpawnerCampIds = new Set();
    let unassociatedNativeSpawnerCount = 0;
    let mismatchedNativeSpawnerCount = 0;
    for (const native of nativeSpawners) {
        if (!finiteVector(native.origin)) {
            unassociatedNativeSpawnerCount += 1;
            continue;
        }
        const matches = [...spawnerById].filter(([, spawner]) =>
            Math.abs(native.origin[0] - spawner.x) <= tolerance && Math.abs(native.origin[1] - spawner.y) <= tolerance);
        if (matches.length !== 1) {
            unassociatedNativeSpawnerCount += 1;
            mismatchedNativeSpawnerCount += 1;
            for (const [campId] of matches) ambiguousSpawnerCampIds.add(campId);
            continue;
        }
        const [campId] = matches[0];
        const associated = nativeSpawnersByCampId.get(campId) || [];
        associated.push(native);
        nativeSpawnersByCampId.set(campId, associated);
    }

    const missingSpawnerCampIds = [];
    const duplicateSpawnerCampIds = [];
    const spawnerAssociations = [];
    let matchedSpawnerCount = 0;
    for (const [campId, spawner] of spawnerById) {
        const nativeMatches = nativeSpawnersByCampId.get(campId) || [];
        if (nativeMatches.length === 0) {
            missingSpawnerCampIds.push(campId);
            continue;
        }
        if (nativeMatches.length !== 1) {
            duplicateSpawnerCampIds.push(campId);
            continue;
        }
        const [native] = nativeMatches;
        matchedSpawnerCount += 1;
        spawnerAssociations.push({ campId, entityIndex: native.entityIndex, origin: native.origin,
            mapdataOrigin: [spawner.x, spawner.y] });
    }
    const spawnerAssociationVerified = matchedSpawnerCount === spawnerById.size && missingSpawnerCampIds.length === 0
        && duplicateSpawnerCampIds.length === 0 && ambiguousSpawnerCampIds.size === 0 && unassociatedNativeSpawnerCount === 0;
    const triggerMismatch = mismatchedCampIds.length > 0 || duplicateCampIds.length > 0;
    const spawnerMismatch = duplicateSpawnerCampIds.length > 0 || ambiguousSpawnerCampIds.size > 0
        || mismatchedNativeSpawnerCount > 0;
    const mismatch = triggerMismatch || spawnerMismatch;
    const fullyVerified = geometryVerified && spawnerAssociationVerified;
    const reason = fullyVerified ? null : triggerMismatch ? 'native-trigger-geometry-mismatch'
        : spawnerMismatch ? 'native-spawner-association-mismatch'
            : geometryVerified ? 'native-spawner-association-incomplete'
                : incompleteCampIds.length ? 'native-trigger-observation-incomplete' : 'native-camp-coverage-incomplete';
    return {
        status: fullyVerified ? 'verified' : mismatch ? 'mismatch' : 'partial',
        geometryVerified,
        association: matchedCampCount ? 'exact-native-trigger-name-to-camp-id' : 'not-inferred',
        source,
        tolerance,
        expectedCampCount: campBoxes.length,
        matchedCampCount,
        missingCampIds,
        incompleteCampIds,
        mismatchedCampIds,
        duplicateCampIds,
        unassociatedNativeTriggerCount,
        spawnerAssociationVerified,
        matchedSpawnerCount,
        missingSpawnerCampIds,
        duplicateSpawnerCampIds,
        ambiguousSpawnerCampIds: [...ambiguousSpawnerCampIds],
        unassociatedNativeSpawnerCount,
        mismatchedNativeSpawnerCount,
        spawnerAssociations,
        reason,
    };
}
