// Rows contain pairs of [start column, end column), ordered from south to north.
// Bounds are cell edges, not the centers used by the vision simulation.
function ringPosition(x, y, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        const cross = (x - xi) * (yj - yi) - (y - yi) * (xj - xi);
        if (Math.abs(cross) < 1e-8 && x >= Math.min(xi, xj) && x <= Math.max(xi, xj)
            && y >= Math.min(yi, yj) && y <= Math.max(yi, yj)) return 0;
        if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside ? 1 : -1;
}

function structureContains({ geometry }, x, y) {
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    return polygons.some(([outer, ...holes]) => ringPosition(x, y, outer) >= 0
        && !holes.some(hole => ringPosition(x, y, hole) > 0));
}

export function isWardBlocked(grid, x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return true;
    // Runtime NPC collision is separate from the terrain's 64-unit cells.
    // Test the actual position so a pool does not invalidate adjacent ground.
    if (grid.hulls?.some(({ center, radius }) => (x - center[0]) ** 2 + (y - center[1]) ** 2 <= radius ** 2)) return true;
    if (grid.structures?.some(feature => structureContains(feature, x, y))) return true;
    const column = Math.floor((x - grid.origin[0]) / grid.cellSize);
    const row = Math.floor((y - grid.origin[1]) / grid.cellSize);
    if (column < 0 || row < 0 || column >= grid.width || row >= grid.height) return true;
    const spans = grid.blockedRows[row];
    for (let i = 0; i < spans.length; i += 2) {
        if (column < spans[i]) return false;
        if (column < spans[i + 1]) return true;
    }
    return false;
}
