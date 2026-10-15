import { createCoordinateTransform } from './mapGeometry.mjs';

// The published historical tiles and saved drawings use this calibration.
// Reproject those assets; do not apply their unequal axis scales to new maps.
export const legacyWorldExtent = [-8507.4, -8953.45782627, 9515, 8888.12001679];
export const legacyCoordinates = createCoordinateTransform(legacyWorldExtent);
export const legacyWorldCenter = legacyCoordinates.toWorld([8192, 8192]);
