export const OVERVIEW_REFERENCE_SIZE = 1024;

export function overviewWorldExtent(overview) {
    const side = overview.scale * OVERVIEW_REFERENCE_SIZE;
    return [overview.posX, overview.posY - side, overview.posX + side, overview.posY];
}

export function createCoordinateTransform(extent, size = 16384) {
    const [minX, minY, maxX, maxY] = extent;
    return {
        toMap: ([x, y]) => [(x - minX) / (maxX - minX) * size, (y - minY) / (maxY - minY) * size],
        toWorld: ([x, y]) => [minX + x / size * (maxX - minX), minY + y / size * (maxY - minY)],
    };
}

const stableCoordinate = value => Math.abs(value - Math.round(value)) < 1e-8 ? Math.round(value) : value;

/** Convert between raster pixels and a patch's world extent without app state. */
export function createPixelCoordinateTransform(extent, width = 16384, height = width) {
    const [minX, minY, maxX, maxY] = extent;
    if (![minX, minY, maxX, maxY, width, height].every(Number.isFinite)
        || maxX <= minX || maxY <= minY || width <= 0 || height <= 0) {
        throw new TypeError('A finite map extent and positive raster dimensions are required.');
    }
    return {
        toPixel: ([x, y]) => [(x - minX) / (maxX - minX) * width, (y - minY) / (maxY - minY) * height],
        toWorld: ([x, y]) => [stableCoordinate(minX + x / width * (maxX - minX)),
            stableCoordinate(minY + y / height * (maxY - minY))],
    };
}
