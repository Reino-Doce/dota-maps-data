const destroyableIds = new Set(['npc_dota_tower', 'npc_dota_barracks', 'npc_dota_fort']);

const lanes = [
    { team: 'radiant', name: 'top', towers: [[-6336, 1856], [-6501, -872], [-6592, -3408]], barracks: [[-6336, -3758], [-6844, -3759]] },
    { team: 'radiant', name: 'middle', towers: [[-1544, -1408], [-3190, -2926], [-4640, -4144]], barracks: [[-4672, -4552], [-5060, -4199]] },
    { team: 'radiant', name: 'bottom', towers: [[4860, -6379], [-360, -6256], [-3952, -6112]], barracks: [[-4280, -6360], [-4279, -5853]] },
    { team: 'dire', name: 'top', towers: [[6269, -2240], [6400, 384], [6336, 3032]], barracks: [[6592, 3392], [6064, 3376]] },
    { team: 'dire', name: 'middle', towers: [[524, 652], [2496, 2112], [4272, 3759]], barracks: [[4702, 3824], [4336, 4183]] },
    { team: 'dire', name: 'bottom', towers: [[-5275, 6036], [-128, 6016], [3552, 5776]], barracks: [[3898, 5496], [3894, 6025]] },
];

const distance = (a, b) => Math.hypot(a.x - b[0], a.y - b[1]);

function find(records, id, position, team) {
    return records.find(record => record.id === id && record.team === team && distance(record, position) < 80)?.key;
}

export function buildStructureRules(records) {
    const rules = new Map(records.map(record => [record.key, {
        destroyable: destroyableIds.has(record.id),
        requirements: [],
    }]));
    const requireAll = (target, prerequisites) => {
        if (target && prerequisites.every(Boolean)) rules.get(target)?.requirements.push({ mode: 'all', keys: prerequisites });
    };
    const requireAny = (target, prerequisites) => {
        if (target && prerequisites.some(Boolean)) rules.get(target)?.requirements.push({ mode: 'any', keys: prerequisites.filter(Boolean) });
    };
    const towerFour = { radiant: [], dire: [] };
    const barracksByTeam = { radiant: [], dire: [] };

    for (const lane of lanes) {
        const tiers = lane.towers.map(point => find(records, 'npc_dota_tower', point, lane.team));
        const barracks = lane.barracks.map(point => find(records, 'npc_dota_barracks', point, lane.team));
        requireAll(tiers[1], [tiers[0]]);
        requireAll(tiers[2], [tiers[1]]);
        for (const structure of barracks) requireAll(structure, [tiers[2]]);
        for (const tower of records.filter(record => record.id === 'npc_dota_tower'
            && record.team === lane.team && record.subType === 'tower4')) {
            if (!towerFour[lane.team].includes(tower.key)) towerFour[lane.team].push(tower.key);
        }
        barracksByTeam[lane.team].push(...barracks.filter(Boolean));
    }

    for (const team of ['radiant', 'dire']) {
        const ancient = records.find(record => record.id === 'npc_dota_fort' && record.team === team)?.key;
        requireAny(towerFour[team][0], barracksByTeam[team]);
        requireAny(towerFour[team][1], barracksByTeam[team]);
        requireAll(ancient, towerFour[team]);
    }
    return rules;
}
