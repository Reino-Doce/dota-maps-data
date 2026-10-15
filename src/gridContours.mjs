function signedArea(ring) {
    return ring.slice(0, -1).reduce((area, point, i) => (
        area + point[0] * ring[i + 1][1] - ring[i + 1][0] * point[1]
    ), 0) / 2;
}

function containsPoint([x, y], ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
        j = i;
    }
    return inside;
}

// Trace exposed cell edges. Keeping the blocked cell on the left preserves
// holes and separates islands which only touch at a corner.
export function gridToPolygons(grid) {
    const { width, height, cellSize, origin, blockedRows } = grid;
    const mask = new Uint8Array(width * height);
    blockedRows.forEach((spans, y) => {
        for (let i = 0; i < spans.length; i += 2) mask.fill(1, y * width + spans[i], y * width + spans[i + 1]);
    });
    const edges = [];
    const outgoing = new Map();
    const has = (x, y) => x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x];
    const add = (sx, sy, ex, ey, direction) => {
        const key = sy * (width + 1) + sx;
        if (!outgoing.has(key)) outgoing.set(key, []);
        outgoing.get(key).push(edges.length);
        edges.push({ sx, sy, ex, ey, direction, used: false });
    };
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (!has(x, y)) continue;
            if (!has(x, y - 1)) add(x, y, x + 1, y, 0);
            if (!has(x + 1, y)) add(x + 1, y, x + 1, y + 1, 1);
            if (!has(x, y + 1)) add(x + 1, y + 1, x, y + 1, 2);
            if (!has(x - 1, y)) add(x, y + 1, x, y, 3);
        }
    }
    const loops = [];
    const rank = [1, 0, 3, 2]; // left turn, straight, right turn, reverse
    for (const first of edges) {
        if (first.used) continue;
        const ring = [];
        let edge = first;
        while (true) {
            if (edge.used) throw new Error('Invalid grid contour.');
            edge.used = true;
            ring.push([origin[0] + edge.sx * cellSize, origin[1] + edge.sy * cellSize]);
            if (edge.ex === first.sx && edge.ey === first.sy) break;
            const candidates = outgoing.get(edge.ey * (width + 1) + edge.ex)
                .map(index => edges[index]).filter(candidate => !candidate.used);
            candidates.sort((a, b) => rank[(a.direction - edge.direction + 4) % 4]
                - rank[(b.direction - edge.direction + 4) % 4]);
            if (!candidates.length) throw new Error('Open grid contour.');
            [edge] = candidates;
        }
        // Remove collinear vertices without changing a single cell boundary.
        const corners = ring.filter((point, i) => {
            const previous = ring[(i + ring.length - 1) % ring.length];
            const next = ring[(i + 1) % ring.length];
            return (point[0] - previous[0]) * (next[1] - point[1])
                !== (point[1] - previous[1]) * (next[0] - point[0]);
        });
        corners.push(corners[0]);
        loops.push(corners);
    }
    const polygons = loops.filter(ring => signedArea(ring) > 0)
        .map(ring => ({ rings: [ring], area: signedArea(ring) })).sort((a, b) => a.area - b.area);
    for (const hole of loops.filter(ring => signedArea(ring) < 0)) {
        const [[x1, y1], [x2, y2]] = hole;
        const length = Math.hypot(x2 - x1, y2 - y1);
        const interior = [(x1 + x2) / 2 + (y2 - y1) / length * cellSize / 4, (y1 + y2) / 2 - (x2 - x1) / length * cellSize / 4];
        const owner = polygons.find(polygon => containsPoint(interior, polygon.rings[0]));
        if (!owner) throw new Error('Grid contour hole has no enclosing polygon.');
        owner.rings.push(hole);
    }
    return polygons.map(polygon => polygon.rings);
}
