import { gridToPolygons } from './gridContours.mjs';

// Trace every lit cell: separate islands are polygons, enclosed shadows holes.
const getLightUnion = (grid, lights) => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const key of Object.keys(lights)) {
        if (!lights[key]) continue;
        const [x, y] = key.split(',').map(Number);
        if (!grid[x]?.[y]) continue;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
    }
    if (!Number.isFinite(minX)) return [];
    const blockedRows = [];
    for (let y = minY; y <= maxY; y++) {
        const spans = [];
        let start = -1;
        for (let x = minX; x <= maxX + 1; x++) {
            const lit = x <= maxX && !!lights[`${x},${y}`];
            if (lit && start === -1) start = x - minX;
            if (!lit && start !== -1) {
                spans.push(start, x - minX);
                start = -1;
            }
        }
        blockedRows.push(spans);
    }
    return gridToPolygons({ width: maxX - minX + 1, height: maxY - minY + 1,
        cellSize: 1, origin: [minX - 0.5, minY - 0.5], blockedRows });
};

export default getLightUnion;
