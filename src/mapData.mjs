const vision = (unit, isNight) => {
    if (!unit || typeof unit !== 'object') return null;
    const radius = isNight ? unit.nightVision : unit.dayVision;
    return Number.isFinite(radius) ? radius : null;
};

/** Compose the current patch's map entities with the imported viewer metadata. */
export function composeMapData(value, patch, { watchers, buildings }) {
    const data = structuredClone(value);
    if (!data?.data || typeof data.data !== 'object' || Array.isArray(data.data)
        || !data.stats || typeof data.stats !== 'object' || Array.isArray(data.stats)) {
        throw new Error('Map data has no entity and stats records.');
    }
    if (patch !== '741f') return data;
    if (!Array.isArray(watchers?.positions) || !Array.isArray(buildings?.buildings)) {
        throw new Error('Watcher and building metadata are incomplete.');
    }

    data.data.npc_dota_lantern = watchers.positions.map(([x, y, z]) => ({ x, y, z }));
    data.stats.npc_dota_lantern = {
        dayVision: watchers.dayVision,
        nightVision: watchers.nightVision,
    };
    for (const unitClass of new Set(buildings.buildings.map(building => building.unitClass))) {
        const previous = data.data[unitClass] || [];
        data.data[unitClass] = buildings.buildings.filter(building => building.unitClass === unitClass).map(building => {
            const [x, y, z] = building.position;
            const original = previous.find(point => Math.hypot(point.x - x, point.y - y) < 2);
            return {
                ...original,
                x,
                y,
                z,
                team: building.team,
                structureKey: building.id,
                vision: {
                    dayVision: vision(building, false) ?? 0,
                    nightVision: vision(building, true) ?? 0,
                    trueSight: Number.isFinite(building.trueSight) ? building.trueSight : 0,
                },
            };
        });
        data.stats[unitClass] ||= {};
    }

    if (!Array.isArray(data.data.ent_dota_shop)) throw new Error('Map data has no shop entity list.');
    data.data.ent_dota_shop.forEach(shop => {
        shop.team = 'neutral';
        shop.vision = { dayVision: 0, nightVision: 0, trueSight: 0 };
    });
    return data;
}
