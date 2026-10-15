import { randomUUID } from 'node:crypto';

// Source Filmmaker camera coordinates: +X is forward, -Y is right, +Z is up.
// This quaternion looks down -Z with world +X right and world +Y up. A narrow
// field of view keeps height-dependent parallax small without stretching art.
export function createSfmSession({ map, worldExtent, size = 8192, outputPrefix }) {
    if (!/^dota[a-z0-9_]*$/.test(map) || worldExtent?.length !== 4 || !worldExtent.every(Number.isFinite)) {
        throw new Error('Invalid SFM terrain or extent.');
    }
    const [minX, minY, maxX, maxY] = worldExtent;
    const span = Math.max(maxX - minX, maxY - minY);
    if (!(span > 0) || minX >= maxX || minY >= maxY || !Number.isInteger(size) || size < 1024 || size > 16384) {
        throw new Error('Invalid SFM render dimensions.');
    }
    const center = [(minX + maxX) / 2, (minY + maxY) / 2];
    const fieldOfView = 1;
    const cameraHeight = span / (2 * Math.tan(fieldOfView * Math.PI / 360));
    // Cavern ceiling props obscure the ground from above. Keep the terrain,
    // trees and buildings, but omit the decorative prop category for this map.
    const drawMapProps = map !== 'dota_cavern';
    const elements = [];
    const element = (type, name, attributes = {}) => {
        const value = { type, id: randomUUID(), name, attributes };
        elements.push(value);
        return value;
    };
    const attr = (type, value) => ({ type, value });
    const ref = value => attr('element', value.id);
    const refs = values => attr('element_array', values.map(value => value.id));
    const number = value => attr('float', value);
    const integer = value => attr('int', value);
    const flag = value => attr('bool', value ? 1 : 0);
    const string = value => attr('string', value);
    const root = element('DmElement', 'session');
    const transform = element('DmeTransform', 'map_camera_transform', {
        position: attr('vector3', [...center, cameraHeight].join(' ')),
        orientation: attr('quaternion', '-0.5 0.5 0.5 0.5'),
    });
    const camera = element('DmeCamera', 'map_camera', {
        transform: ref(transform), fieldOfView: number(fieldOfView),
        znear: number(cameraHeight - 8192), zfar: number(cameraHeight + 8192),
        focalDistance: number(cameraHeight), aperture: number(0),
        toneMapScale: number(1), mapLightScale: number(1), timeOfDayAmount: number(1),
        visible: flag(true), children: refs([]),
    });
    const sceneTransform = element('DmeTransform', 'scene_transform', {
        position: attr('vector3', '0 0 0'), orientation: attr('quaternion', '0 0 0 1'),
    });
    const scene = element('DmeDag', 'scene', { transform: ref(sceneTransform), visible: flag(true), children: refs([camera]) });
    const timeframe = () => element('DmeTimeFrame', 'timeFrame', {
        start: attr('time', '0.0000'), duration: attr('time', '1.0000'), offset: attr('time', '0.0000'), scale: number(1),
    });
    const shot = element('DmeFilmClip', 'map_capture', {
        timeFrame: ref(timeframe()), camera: ref(camera), scene: ref(scene), mapname: string(''),
        trackGroups: refs([]), animationSets: refs([]), operators: refs([]),
    });
    const filmTrack = element('DmeTrack', 'Film', { children: refs([shot]), clipType: integer(3), mute: flag(false) });
    const filmGroup = element('DmeTrackGroup', 'Film', { tracks: refs([filmTrack]), visible: flag(true) });
    const clip = element('DmeFilmClip', 'terrain', {
        timeFrame: ref(timeframe()), mapname: string(`maps/${map}.vmap`), subClipTrackGroup: ref(filmGroup),
        trackGroups: refs([]), concommands: attr('string_array', []),
    });
    const refinement = element('DmElement', 'ProgressiveRefinementSettings', {
        on: flag(true), useDepthOfField: flag(false), useMotionBlur: flag(false), useAntialiasing: flag(true),
    });
    const render = element('DmElement', 'renderSettings', {
        width: integer(size), height: integer(size), frameRate: number(1),
        engineCameraEffects: flag(false), modelLod: integer(0), showAmbientOcclusion: integer(0),
        drawGameRenderablesMask: integer(drawMapProps ? 31 : 23), drawToolRenderablesMask: integer(29),
        toneMapScale: number(1), globalLightShadowEnabled: flag(true),
        ProgressiveRefinement: ref(refinement), showShotIDOverlay: flag(false), drawGrid: flag(false),
    });
    const poster = element('DmElement', 'posterSettings', {
        width: integer(size), height: integer(size), format: string('PNG'), filename: string(outputPrefix),
        constrainAspect: flag(false), heightInPixels: flag(true), widthInPixels: flag(true), writeAlpha: flag(false),
    });
    const movie = element('DmElement', 'movieSettings', {
        width: integer(size), height: integer(size), videoTarget: integer(4), audioTarget: integer(2),
        filename: string(outputPrefix), TimeRangeStartTime: number(0), TimeRangeEndTime: number(1),
        IsOverridingFrameRate: flag(true), OverridingFrameRate: number(1),
        UseMoviePostRenderCommand: flag(false), UseMovieAfterRenderCommand: flag(false),
    });
    const settings = element('DmElement', 'sessionSettings', {
        renderSettings: ref(render), posterSettings: ref(poster), movieSettings: ref(movie),
    });
    root.attributes = { activeClip: ref(clip), clipBin: refs([clip]), cameraBin: refs([]), miscBin: refs([]), settings: ref(settings) };
    const quote = value => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]/g, '')}"`;
    const text = '<!-- dmx encoding keyvalues2 4 format sfm_session 22 -->\n'
        + elements.map(item => `${quote(item.type)}\n{\n`
            + `    "id" "elementid" ${quote(item.id)}\n    "name" "string" ${quote(item.name)}\n`
            + Object.entries(item.attributes).map(([key, { type, value }]) => {
                const encoded = type.endsWith('_array')
                    ? `[ ${value.map(entry => `${type === 'element_array' ? '"element" ' : ''}${quote(entry)}`).join(', ')} ]`
                    : quote(value);
                return `    ${quote(key)} ${quote(type)} ${encoded}\n`;
            }).join('') + '}\n').join('\n');
    return {
        text, cameraHeight, fieldOfView, rendering: { drawMapProps },
        nominalWorldExtent: [center[0] - span / 2, center[1] - span / 2, center[0] + span / 2, center[1] + span / 2],
    };
}
