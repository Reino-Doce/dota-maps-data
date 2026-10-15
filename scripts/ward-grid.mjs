import { gridToPolygons } from '../src/gridContours.mjs';

// Source format and flag definitions:
// https://github.com/ValveResourceFormat/ValveResourceFormat/blob/master/ValveResourceFormat/MapFormats/GridNavFile.cs
export const WARD_BLOCKING = 0x10;

export function readGridNav(bytes) {
    if (bytes.length < 32) throw new Error('Truncated GNV header.');
    const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (header.getUint32(0, true) !== 0xFADEBEAD) throw new Error('Invalid GNV magic.');
    const cellSize = header.getFloat32(4, true);
    const offsetX = header.getFloat32(8, true);
    const offsetY = header.getFloat32(12, true);
    const width = header.getInt32(16, true);
    const height = header.getInt32(20, true);
    const minX = header.getInt32(24, true);
    const minY = header.getInt32(28, true);
    if (cellSize !== 64 || offsetX !== 32 || offsetY !== 32
        || width <= 0 || height <= 0 || bytes.length !== 32 + width * height) {
        throw new Error('Unsupported or truncated GNV grid.');
    }
    return {
        cellSize, width, height,
        origin: [minX * cellSize, minY * cellSize],
        flags: bytes.subarray(32),
    };
}

export function encodeWardGrid(nav, source, hulls, structures) {
    const { cellSize, width, height, origin, flags } = nav;
    const blockedRows = [];
    for (let y = 0; y < height; y++) {
        const spans = [];
        let start = -1;
        for (let x = 0; x <= width; x++) {
            const blocked = x < width && (flags[y * width + x] & WARD_BLOCKING) !== 0;
            if (blocked && start === -1) start = x;
            if (!blocked && start !== -1) {
                spans.push(start, x);
                start = -1;
            }
        }
        blockedRows.push(spans);
    }
    return { source, cellSize, width, height, origin, blockedRows, ...(hulls ? { hulls } : {}), ...(structures ? { structures } : {}) };
}

export function runtimeWardHulls(terrain) {
    if (!Array.isArray(terrain.entities)) throw new Error('Recapture terrain with runtime entities before importing ward restrictions.');
    return terrain.entities.filter(entity => ['npc_dota_lotus_pool', 'npc_dota_unit_twin_gate', 'npc_dota_watch_tower'].includes(entity.classname)).map(entity => {
        if (entity.origin?.length !== 3 || !entity.origin.every(Number.isFinite)
            || !Number.isFinite(entity.hullRadius) || entity.hullRadius <= 0) {
            throw new Error('Invalid runtime collision hull.');
        }
        return { classname: entity.classname, center: entity.origin.slice(0, 2), radius: entity.hullRadius };
    });
}

export function wardGridToGeoJSON(grid) {
    const coordinates = gridToPolygons(grid);
    const features = coordinates.length ? [{
        type: 'Feature',
        properties: { source: 'dota.gnv', flag: WARD_BLOCKING },
        geometry: { type: 'MultiPolygon', coordinates: coordinates },
    }] : [];
    for (const { center, radius, classname } of grid.hulls || []) {
        const ring = Array.from({ length: 128 }, (_, i) => {
            const angle = 2 * Math.PI * i / 128;
            return [center[0] + radius * Math.cos(angle), center[1] + radius * Math.sin(angle)];
        });
        ring.push(ring[0]);
        features.push({
            type: 'Feature',
            properties: { source: 'runtime collision', classname, center, radius },
            geometry: { type: 'Polygon', coordinates: [ring] },
        });
    }
    return {
        type: 'FeatureCollection',
        features: [...features, ...(grid.structures || [])],
    };
}
