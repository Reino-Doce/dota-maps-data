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

// Animate a zoomed camera in a snake-like sweep and export one 4K frame per
// second. This follows the continuous camera pan used by the Source Filmmaker
// map-image method; hard cuts between shots stop SFM's sequence exporter after
// the first frame. The article is at
// https://devilesk.com/blog/creating-a-dota-map-image.
export function createSfmSweepSession({
    map,
    worldExtent,
    width = 3840,
    height = 2160,
    columns = 5,
    rows = 9,
    overlap = 1.1,
    outputPrefix,
}) {
    if (!/^dota[a-z0-9_]*$/.test(map) || worldExtent?.length !== 4 || !worldExtent.every(Number.isFinite)) {
        throw new Error('Invalid SFM terrain or extent.');
    }
    const [worldMinX, worldMinY, worldMaxX, worldMaxY] = worldExtent;
    const span = Math.max(worldMaxX - worldMinX, worldMaxY - worldMinY);
    const centerX = (worldMinX + worldMaxX) / 2;
    const centerY = (worldMinY + worldMaxY) / 2;
    const minX = centerX - span / 2;
    const minY = centerY - span / 2;
    const maxX = centerX + span / 2;
    const maxY = centerY + span / 2;
    const spanX = span;
    const spanY = span;
    if (!(spanX > 0) || !(spanY > 0) || !Number.isInteger(width) || width < 1024 || width > 8192
        || !Number.isInteger(height) || height < 576 || height > 8192
        || !Number.isInteger(columns) || columns < 1 || columns > 20
        || !Number.isInteger(rows) || rows < 1 || rows > 20
        || !Number.isFinite(overlap) || overlap < 1 || overlap > 2) {
        throw new Error('Invalid SFM sweep dimensions.');
    }
    const fieldOfView = 1;
    const viewHeight = spanY / rows * overlap;
    const viewWidth = viewHeight * width / height;
    const cameraHeight = viewWidth / (2 * Math.tan(fieldOfView * Math.PI / 360));
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
    const time = value => attr('time', `${value.toFixed(4)}`);
    const root = element('DmElement', 'session');
    const tiles = [];
    for (let row = 0; row < rows; row += 1) {
        const columnOrder = Array.from({ length: columns }, (_, offset) => row % 2 === 0
            ? offset
            : columns - offset - 1);
        for (const column of columnOrder) {
            const index = tiles.length;
            const center = [
                minX + (column + 0.5) * spanX / columns,
                maxY - (row + 0.5) * spanY / rows,
            ];
            tiles.push({ index, row, column, center, cameraHeight, viewHeight, viewWidth });
        }
    }
    const firstPosition = [...tiles[0].center, cameraHeight];
    const orientation = '-0.5 0.5 0.5 0.5';
    const cameraTransform = element('DmeTransform', 'map_camera_transform', {
        position: attr('vector3', firstPosition.join(' ')),
        orientation: attr('quaternion', orientation),
    });
    const camera = element('DmeCamera', 'map_camera', {
        transform: ref(cameraTransform), fieldOfView: number(fieldOfView),
        znear: number(cameraHeight - 32768), zfar: number(cameraHeight + 32768),
        focalDistance: number(cameraHeight), aperture: number(0),
        toneMapScale: number(1), mapLightScale: number(1), timeOfDayAmount: number(1),
        visible: flag(true), children: refs([]),
    });
    const cameraBinTransform = element('DmeTransform', 'camera_bin_transform', {
        position: attr('vector3', '0 0 0'), orientation: attr('quaternion', '0 0 0 1'),
    });
    const cameraBin = element('DmeDag', 'Cameras', {
        transform: ref(cameraBinTransform), visible: flag(true), children: refs([camera]),
    });
    const sceneTransform = element('DmeTransform', 'scene_transform', {
        position: attr('vector3', '0 0 0'), orientation: attr('quaternion', '0 0 0 1'),
    });
    const scene = element('DmeDag', 'scene', {
        transform: ref(sceneTransform), visible: flag(true), children: refs([cameraBin]),
    });

    const transformControl = element('DmeTransformControl', 'camera_transform_control', {
        valuePosition: attr('vector3', firstPosition.join(' ')),
        valueOrientation: attr('quaternion', orientation),
    });
    const positionLogLayer = element('DmeVector3LogLayer', 'transform_position_keys', {
        times: attr('time_array', tiles.map(({ index }) => time(index).value)),
        curvetypes: attr('int_array', []),
        values: attr('vector3_array', tiles.map(({ center }) => [...center, cameraHeight].join(' '))),
        compressed: attr('binary', ''),
    });
    const positionLog = element('DmeVector3Log', 'transform_position_log', {
        layers: refs([positionLogLayer]), curveinfo: attr('element', ''),
        usedefaultvalue: flag(false), defaultvalue: attr('vector3', firstPosition.join(' ')),
        bookmarks: attr('time_array', []),
    });
    const positionChannel = element('DmeChannel', 'transform_pos', {
        fromElement: ref(transformControl), fromAttribute: string('valuePosition'), fromIndex: integer(0),
        toElement: ref(cameraTransform), toAttribute: string('position'), toIndex: integer(0),
        mode: integer(3), log: ref(positionLog),
    });
    const orientationLogLayer = element('DmeQuaternionLogLayer', 'transform_orientation_keys', {
        times: attr('time_array', [time(0).value, time(tiles.length - 1).value]),
        curvetypes: attr('int_array', []),
        values: attr('quaternion_array', [orientation, orientation]),
        compressed: attr('binary', ''),
    });
    const orientationLog = element('DmeQuaternionLog', 'transform_orientation_log', {
        layers: refs([orientationLogLayer]), curveinfo: attr('element', ''),
        usedefaultvalue: flag(false), defaultvalue: attr('quaternion', orientation),
        bookmarks: attr('time_array', []),
    });
    const orientationChannel = element('DmeChannel', 'transform_rot', {
        fromElement: ref(transformControl), fromAttribute: string('valueOrientation'), fromIndex: integer(0),
        toElement: ref(cameraTransform), toAttribute: string('orientation'), toIndex: integer(0),
        mode: integer(3), log: ref(orientationLog),
    });
    transformControl.attributes.positionChannel = ref(positionChannel);
    transformControl.attributes.orientationChannel = ref(orientationChannel);

    const allControls = element('DmeControlGroup', 'all', {
        children: refs([]), controls: refs([transformControl]),
        groupColor: attr('color', '200 200 200 255'), controlColor: attr('color', '200 200 200 255'),
        visible: flag(true), selectable: flag(true), snappable: flag(true),
    });
    const rootControls = element('DmeControlGroup', 'root_controls', {
        children: refs([allControls]), controls: refs([]),
        groupColor: attr('color', '200 200 200 255'), controlColor: attr('color', '200 200 200 255'),
        visible: flag(true), selectable: flag(true), snappable: flag(true),
    });
    const animationSet = element('DmeAnimationSet', 'map_camera_animation', {
        controls: refs([transformControl]), presetGroups: refs([]), phonememap: refs([]), operators: refs([]),
        rootControlGroup: ref(rootControls), camera: ref(camera),
    });
    const channelClipTimeFrame = element('DmeTimeFrame', 'camera_channels_timeFrame', {
        start: time(0), duration: time(tiles.length), offset: time(0), scale: number(1),
    });
    const channelsClip = element('DmeChannelsClip', 'map_camera_animation', {
        timeFrame: ref(channelClipTimeFrame), color: attr('color', '0 0 0 0'), text: string(''), mute: flag(false),
        trackGroups: refs([]), displayScale: number(1), channels: refs([positionChannel, orientationChannel]),
    });
    const channelsTrack = element('DmeTrack', 'animSetEditorChannels', {
        children: refs([channelsClip]), collapsed: flag(false), mute: flag(false), synched: flag(true),
        clipType: integer(0), volume: number(1), displayScale: number(1),
    });
    const channelsTrackGroup = element('DmeTrackGroup', 'channelTrackGroup', {
        tracks: refs([channelsTrack]), visible: flag(true), mute: flag(false), displayScale: number(1),
    });
    const shotTimeFrame = element('DmeTimeFrame', 'capture_shot_timeFrame', {
        start: time(0), duration: time(tiles.length), offset: time(0), scale: number(1),
    });
    const shot = element('DmeFilmClip', 'map_capture', {
        timeFrame: ref(shotTimeFrame), camera: ref(camera), scene: ref(scene), mapname: string(''),
        trackGroups: refs([channelsTrackGroup]), animationSets: refs([animationSet]), operators: refs([]),
    });
    const filmTrack = element('DmeTrack', 'Film', { children: refs([shot]), clipType: integer(3), mute: flag(false) });
    const filmGroup = element('DmeTrackGroup', 'Film', { tracks: refs([filmTrack]), visible: flag(true) });
    const clipTimeFrame = element('DmeTimeFrame', 'terrain_timeFrame', {
        start: time(0), duration: time(tiles.length), offset: time(0), scale: number(1),
    });
    const clip = element('DmeFilmClip', 'terrain', {
        timeFrame: ref(clipTimeFrame), mapname: string(`maps/${map}.vmap`), subClipTrackGroup: ref(filmGroup),
        trackGroups: refs([]), concommands: attr('string_array', []),
    });
    const refinement = element('DmElement', 'ProgressiveRefinementSettings', {
        on: flag(true), useDepthOfField: flag(false), useMotionBlur: flag(false), useAntialiasing: flag(true),
    });
    const render = element('DmElement', 'renderSettings', {
        width: integer(width), height: integer(height), frameRate: number(1),
        engineCameraEffects: flag(false), modelLod: integer(0), showAmbientOcclusion: integer(0),
        drawGameRenderablesMask: integer(drawMapProps ? 31 : 23), drawToolRenderablesMask: integer(29),
        toneMapScale: number(1), globalLightShadowEnabled: flag(true),
        ProgressiveRefinement: ref(refinement), showShotIDOverlay: flag(false), drawGrid: flag(false),
    });
    const poster = element('DmElement', 'posterSettings', {
        width: integer(width), height: integer(height), format: string('PNG'), filename: string(outputPrefix),
        constrainAspect: flag(false), heightInPixels: flag(true), widthInPixels: flag(true), writeAlpha: flag(false),
    });
    const movie = element('DmElement', 'movieSettings', {
        width: integer(width), height: integer(height), videoTarget: integer(4), audioTarget: integer(2),
        filename: string(outputPrefix), TimeRangeStartTime: number(0), TimeRangeEndTime: number(tiles.length),
        IsOverridingFrameRate: flag(true), OverridingFrameRate: number(1),
        UseMoviePostRenderCommand: flag(false), UseMovieAfterRenderCommand: flag(false),
    });
    const settings = element('DmElement', 'sessionSettings', {
        renderSettings: ref(render), posterSettings: ref(poster), movieSettings: ref(movie),
    });
    root.attributes = { activeClip: ref(clip), clipBin: refs([clip]), cameraBin: refs([camera]), miscBin: refs([]), settings: ref(settings) };
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
        text, cameraHeight, fieldOfView, rendering: { drawMapProps }, tiles,
        nominalWorldExtent: [minX, minY, maxX, maxY],
        sequenceDuration: tiles.length,
    };
}
