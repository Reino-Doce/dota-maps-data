const wardKinds = new Set(['observer', 'sentry']);
const playerTeams = new Set(['radiant', 'dire']);
const geometryTolerance = 0.05;

function finiteVector(value, length) {
    return Array.isArray(value) && value.length === length && value.every(Number.isFinite);
}

function distanceFromSegment(point, start, end) {
    const dx = end[0] - start[0];
    const dy = end[1] - start[1];
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared === 0) return Math.hypot(point[0] - start[0], point[1] - start[1]);
    const fraction = Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / lengthSquared));
    return Math.hypot(point[0] - (start[0] + fraction * dx), point[1] - (start[1] + fraction * dy));
}

function pointInPolygon(point, points) {
    let inside = false;
    for (let index = 0, previous = points.length - 1; index < points.length; previous = index, index += 1) {
        const start = [points[previous].x, points[previous].y];
        const end = [points[index].x, points[index].y];
        if (distanceFromSegment(point, start, end) <= geometryTolerance) return 'boundary';
        if ((end[1] > point[1]) !== (start[1] > point[1])
            && point[0] < (start[0] - end[0]) * (point[1] - end[1]) / (start[1] - end[1]) + end[0]) {
            inside = !inside;
        }
    }
    return inside ? 'inside' : 'outside';
}

function validSpawnBox(box, patch) {
    return box && typeof box.campId === 'string' && box.campId.length > 0
        && box.source?.patch === patch
        && typeof box.source?.gameClientVersion === 'string' && box.source.gameClientVersion.length > 0
        && Array.isArray(box.points) && box.points.length >= 3
        && box.points.every(point => Number.isFinite(point?.x) && Number.isFinite(point?.y))
        && finiteVector(box.worldBounds?.min, 3) && finiteVector(box.worldBounds?.max, 3)
        && box.worldBounds.min.every((value, axis) => value < box.worldBounds.max[axis]);
}

function campName(box) {
    const match = /^neutralcamp_(good|evil)_(\d+)$/.exec(box.campId);
    const side = match ? match[1] === 'good' ? 'Radiant' : 'Dire' : null;
    const type = typeof box.campType === 'string' && box.campType.length > 0
        ? `${box.campType[0].toUpperCase()}${box.campType.slice(1)} ` : '';
    return side && match ? `${side} ${type}camp #${match[2]}` : `${type}camp (${box.campId})`;
}

const unknown = reason => ({ state: 'unknown', campIds: [], reason });

/** Classify a world position against complete, patch-matched native spawn boxes. */
export function classifySpawnBoxPosition(position, spawnBoxes, patch) {
    if (!finiteVector(position, 3)) return unknown('position-incomplete');
    if (typeof patch !== 'string' || patch.length === 0 || !Array.isArray(spawnBoxes) || spawnBoxes.length === 0) {
        return unknown('spawn-geometry-unavailable');
    }
    if (!spawnBoxes.every(box => validSpawnBox(box, patch))) {
        return unknown('spawn-geometry-incomplete-or-mismatched');
    }
    const clientVersions = new Set(spawnBoxes.map(box => box.source.gameClientVersion));
    const campIds = new Set(spawnBoxes.map(box => box.campId));
    if (clientVersions.size !== 1 || campIds.size !== spawnBoxes.length) return unknown('spawn-geometry-ambiguous');

    const [x, y, z] = position;
    const matchingCamps = [];
    let boundary = false;
    for (const box of spawnBoxes) {
        const horizontal = pointInPolygon([x, y], box.points);
        if (horizontal === 'boundary') {
            boundary = true;
            continue;
        }
        if (horizontal !== 'inside') continue;
        if (Math.abs(z - box.worldBounds.min[2]) <= geometryTolerance
            || Math.abs(z - box.worldBounds.max[2]) <= geometryTolerance) {
            boundary = true;
            continue;
        }
        if (z > box.worldBounds.min[2] && z < box.worldBounds.max[2]) matchingCamps.push(box);
    }
    if (matchingCamps.length) {
        matchingCamps.sort((first, second) => first.campId.localeCompare(second.campId));
        return {
            state: 'blocked',
            campIds: matchingCamps.map(box => box.campId),
            camps: matchingCamps.map(box => ({ id: box.campId, name: campName(box) })),
            reason: 'inside-verified-neutral-trigger',
        };
    }
    if (boundary) return unknown('trigger-boundary-ambiguous');
    return { state: 'clear', campIds: [], reason: 'outside-neutral-triggers' };
}
