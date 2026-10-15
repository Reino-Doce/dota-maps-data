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

export function buildVisionGrid(nav, terrain, blockerPoints) {
    const { width, height, cellSize, origin } = nav;
    if (terrain.width !== width || terrain.height !== height || terrain.cellSize !== cellSize
        || terrain.origin.some((value, index) => value !== origin[index])
        || terrain.heights.length !== height
        || terrain.heights.some(row => row.length !== width || row.some(z => !Number.isFinite(z)))) {
        throw new Error('Terrain and navigation grids must cover exactly the same cells.');
    }
    const world = {
        worldMinX: origin[0] + cellSize / 2,
        worldMaxX: origin[0] + (width - 0.5) * cellSize,
        worldMinY: origin[1] + cellSize / 2,
        worldMaxY: origin[1] + (height - 0.5) * cellSize,
    };
    const image = new PNG({ width: width * 5, height });
    image.data.fill(255);
    const setPixel = (panel, x, y, r, g = r, b = r) => {
        const index = ((height - 1 - y) * image.width + panel * width + x) * 4;
        image.data[index] = r;
        image.data[index + 1] = g;
        image.data[index + 2] = b;
    };
    const elevations = new Map();
    const blockerMask = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const index = y * width + x;
            const elevation = encodeHeight(terrain.heights[y][x]);
            if (!elevations.has(elevation)) elevations.set(elevation, new Uint8Array(width * height));
            elevations.get(elevation)[index] = WARD_BLOCKING;
            setPixel(0, x, y, elevation);
            setPixel(2, x, y, nav.flags[index] & 1 ? 255 : 0);
            setPixel(4, x, y, nav.flags[index] & WARD_BLOCKING ? 0 : 255);
        }
    }
    const visitPoints = (points, callback) => {
        for (const point of points) {
            const x = Math.floor((point[0] - origin[0]) / cellSize);
            const y = Math.floor((point[1] - origin[1]) / cellSize);
            if (x >= 0 && y >= 0 && x < width && y < height) callback(x, y, point);
        }
    };
    visitPoints(terrain.trees, (x, y, point) => setPixel(1, x, y,
        Math.max(0, Math.min(255, (Math.trunc(point[2] / 128) + 1) * 20)), 0, 0));
    visitPoints(blockerPoints, (x, y) => {
        blockerMask[y * width + x] = WARD_BLOCKING;
        setPixel(3, x, y, 0);
    });
    const contours = (mask, properties) => {
        const collection = wardGridToGeoJSON(encodeWardGrid({ ...nav, flags: mask }));
        for (const feature of collection.features) feature.properties = properties;
        return collection;
    };
    return {
        world,
        image,
        elevation: {
            type: 'FeatureCollection',
            features: [...elevations].sort(([a], [b]) => a - b).flatMap(([z, mask]) => (
                contours(mask, { elevation: z }).features
            )),
        },
        blockers: contours(blockerMask, { source: 'ent_fow_blocker_node' }),
    };
}
