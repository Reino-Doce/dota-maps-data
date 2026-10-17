import { PNG } from 'pngjs';
import { encodeWardGrid, wardGridToGeoJSON, WARD_BLOCKING } from './ward-grid.mjs';

// Match the existing simulator's 128-unit cliff levels and ramp threshold.
export function encodeHeight(height) {
    const z = height / 128;
    const fraction = z - Math.trunc(z);
    const level = fraction >= 0 && fraction <= 0.75 ? Math.trunc(z)
        : fraction < -0.75 ? Math.floor(z) : Math.ceil(z);
    return level <= -128 ? 255 : Math.max(0, Math.min(255, (level + 1) * 20));
}

function validateTerrain(terrain) {
    const { width, height, cellSize, origin } = terrain || {};
    if (!terrain || typeof terrain !== 'object' || !Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1
        || !Number.isFinite(cellSize) || cellSize <= 0 || !Array.isArray(origin) || origin.length !== 2
        || !origin.every(Number.isFinite) || !Array.isArray(terrain.heights) || terrain.heights.length !== height
        || terrain.heights.some(row => !Array.isArray(row) || row.length !== width || row.some(z => !Number.isFinite(z)))) {
        throw new Error('Terrain capture must contain finite heights over a valid aligned grid.');
    }
    return { width, height, cellSize, origin };
}

function terrainOverlays(terrain, blockerPoints) {
    const { width, height, cellSize, origin } = validateTerrain(terrain);
    const world = {
        worldMinX: origin[0] + cellSize / 2,
        worldMaxX: origin[0] + (width - 0.5) * cellSize,
        worldMinY: origin[1] + cellSize / 2,
        worldMaxY: origin[1] + (height - 0.5) * cellSize,
    };
    const elevations = new Map();
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const index = y * width + x;
            const elevation = encodeHeight(terrain.heights[y][x]);
            if (!elevations.has(elevation)) elevations.set(elevation, new Uint8Array(width * height));
            elevations.get(elevation)[index] = WARD_BLOCKING;
        }
    }
    const visitPoints = (points, callback) => {
        if (!Array.isArray(points)) throw new Error('Terrain blocker points must be an array.');
        for (const point of points) {
            if (!Array.isArray(point) || point.length < 2 || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) {
                throw new Error('Terrain blocker point has invalid coordinates.');
            }
            const x = Math.floor((point[0] - origin[0]) / cellSize);
            const y = Math.floor((point[1] - origin[1]) / cellSize);
            if (x >= 0 && y >= 0 && x < width && y < height) callback(x, y, point);
        }
    };
    const blockerMask = new Uint8Array(width * height);
    visitPoints(blockerPoints, (x, y) => {
        blockerMask[y * width + x] = WARD_BLOCKING;
    });
    const contours = (mask, properties) => {
        const grid = encodeWardGrid({ width, height, cellSize, origin, flags: mask },
            { file: 'terrain_grid.json', sha256: '', flag: WARD_BLOCKING });
        const collection = wardGridToGeoJSON(grid);
        for (const feature of collection.features) feature.properties = properties;
        return collection;
    };
    return {
        world,
        elevation: {
            type: 'FeatureCollection',
            features: [...elevations].sort(([a], [b]) => a - b).flatMap(([z, mask]) => (
                contours(mask, { elevation: z }).features
            )),
        },
        blockers: contours(blockerMask, { source: 'ent_fow_blocker_node' }),
        blockerMask,
    };
}

// Height and FOW contours can be exported even for archives without a native GNV.
// This deliberately does not invent passability or ward-placement data.
export function buildTerrainOverlays(terrain, blockerPoints) {
    const { world, elevation, blockers } = terrainOverlays(terrain, blockerPoints);
    return { world, elevation, blockers };
}

export function buildVisionGrid(nav, terrain, blockerPoints) {
    const { width, height, cellSize, origin } = nav;
    const capture = validateTerrain(terrain);
    if (capture.width !== width || capture.height !== height || capture.cellSize !== cellSize
        || capture.origin.some((value, index) => value !== origin[index])
        || !(Array.isArray(nav.flags) || nav.flags instanceof Uint8Array) || nav.flags.length !== width * height) {
        throw new Error('Terrain and navigation grids must cover exactly the same cells.');
    }
    const { world, elevation, blockers, blockerMask } = terrainOverlays(terrain, blockerPoints);
    const image = new PNG({ width: width * 5, height });
    image.data.fill(255);
    const setPixel = (panel, x, y, r, g = r, b = r) => {
        const index = ((height - 1 - y) * image.width + panel * width + x) * 4;
        image.data[index] = r;
        image.data[index + 1] = g;
        image.data[index + 2] = b;
    };
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const index = y * width + x;
            setPixel(0, x, y, encodeHeight(terrain.heights[y][x]));
            setPixel(2, x, y, nav.flags[index] & 1 ? 255 : 0);
            setPixel(4, x, y, nav.flags[index] & WARD_BLOCKING ? 0 : 255);
        }
    }
    for (const point of terrain.trees || []) {
        if (!Array.isArray(point) || point.length < 3 || !point.slice(0, 3).every(Number.isFinite)) {
            throw new Error('Terrain tree point has invalid coordinates.');
        }
        const x = Math.floor((point[0] - origin[0]) / cellSize);
        const y = Math.floor((point[1] - origin[1]) / cellSize);
        if (x >= 0 && y >= 0 && x < width && y < height) {
            setPixel(1, x, y, Math.max(0, Math.min(255, (Math.trunc(point[2] / 128) + 1) * 20)), 0, 0);
        }
    }
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (blockerMask[y * width + x]) setPixel(3, x, y, 0);
        }
    }
    return {
        world,
        image,
        elevation,
        blockers,
    };
}
