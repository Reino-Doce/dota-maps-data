// dota-vision-simulation reuses its FOV instance, but leaves this completion
// flag set after shadowcasting exits early. Clear it before every new source.
export function resetVisionSearchState(visionSimulation) {
    if (visionSimulation?.fov) visionSimulation.fov.done = false;
}
