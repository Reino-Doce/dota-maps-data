// Near-orthographic captures need their own world calibration, independent of
// resource/overviews/dota.txt (which describes the illustrated minimap).
// Method: https://devilesk.com/blog/creating-a-dota-map-image
export function calibrateScreenshot({ width, height, anchors, checks, maxErrorWorld }) {
    if (![width, height, maxErrorWorld].every(value => Number.isFinite(value) && value > 0)
        || anchors.length < 4 || !checks?.length) throw new Error('Missing screenshot calibration controls.');
    const points = [...anchors, ...checks];
    for (const point of points) {
        if (point.world?.length !== 2 || point.pixel?.length !== 2
            || ![...point.world, ...point.pixel].every(Number.isFinite)
            || point.pixel[0] < 0 || point.pixel[0] >= width || point.pixel[1] < 0 || point.pixel[1] >= height) {
            throw new Error('Invalid screenshot control point.');
        }
    }
    const axes = [0, 1].map(axis => {
        const meanWorld = anchors.reduce((sum, point) => sum + point.world[axis], 0) / anchors.length;
        const meanPixel = anchors.reduce((sum, point) => sum + point.pixel[axis], 0) / anchors.length;
        const spread = anchors.reduce((sum, point) => sum + (point.world[axis] - meanWorld) ** 2, 0);
        if (spread === 0) throw new Error('Calibration controls must span both world axes.');
        const scale = anchors.reduce((sum, point) => sum
            + (point.world[axis] - meanWorld) * (point.pixel[axis] - meanPixel), 0) / spread;
        return { scale, offset: meanPixel - scale * meanWorld };
    });
    if (axes[0].scale <= 0 || axes[1].scale >= 0) throw new Error('Unsupported screenshot orientation.');
    const errors = points.map(point => ({
        name: point.name,
        worldUnits: Math.hypot(...axes.map(({ scale, offset }, axis) => (
            (point.pixel[axis] - offset) / scale - point.world[axis]
        ))),
    }));
    if (errors.some(error => error.worldUnits > maxErrorWorld)) {
        throw new Error(`Screenshot registration exceeds ${maxErrorWorld} world units: ${JSON.stringify(errors)}`);
    }
    const [x, y] = axes;
    return {
        worldExtent: [-x.offset / x.scale, (height - y.offset) / y.scale,
            (width - x.offset) / x.scale, -y.offset / y.scale],
        errors,
    };
}

export function screenshotPixel(world, { worldExtent: [minX, minY, maxX, maxY], width, height }) {
    return [(world[0] - minX) / (maxX - minX) * width, (maxY - world[1]) / (maxY - minY) * height];
}
