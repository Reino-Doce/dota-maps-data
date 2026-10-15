// These are native FOW cells, not a mathematical radius or the terrain-ward
// simulation. In particular, trees on Roshan's boundary can see only one side.
export function createEyesVisionLookup(data) {
    const entries = new Map(data.trees.map(([x, y, pattern]) => [`${x},${y}`, pattern]));
    const areas = data.patterns.map(({ rows }) => rows.reduce((area, row) => area
        + row.reduce((sum, value, i) => sum + (i % 2 ? value : -value), 0), 0));
    return ([x, y]) => {
        const index = entries.get(`${x},${y}`);
        if (index === undefined) return null;
        return {
            polygons: data.patterns[index].polygons.map(polygon => polygon.map(ring => ring.map(([dx, dy]) => [x + dx, y + dy]))),
            lightArea: areas[index],
        };
    };
}
