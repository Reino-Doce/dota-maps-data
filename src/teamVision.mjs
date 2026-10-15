export const teams = ['radiant', 'dire'];
export const viewingTeams = [...teams, 'both'];
export const normalizeTeam = value => viewingTeams.includes(value) ? value : 'radiant';
export const actionTeam = map => map.team === 'both' ? (teams.includes(map.placementTeam) ? map.placementTeam : 'radiant') : map.team;

const viewedTeams = team => team === 'both' ? teams : teams.includes(team) ? [team] : [];

// Ordinary sight and detection are deliberately separate. A Sentry can detect
// through terrain but cannot expose an invisible unit in otherwise unseen fog.
export class TeamVisionIndex {
    constructor() {
        this.replace([]);
    }

    replace(sources) {
        this.vision = { radiant: [], dire: [] };
        this.trueSight = { radiant: [], dire: [] };
        for (const source of sources) {
            if (!source.geometry || source.active === false) continue;
            for (const team of source.team === 'both' ? teams : [source.team]) {
                if (!teams.includes(team)) continue;
                (source.trueSight ? this.trueSight : this.vision)[team].push(source.geometry);
            }
        }
    }

    hasVision(team, coordinate) {
        return viewedTeams(team).some(view => this.vision[view].some(geometry => geometry.intersectsCoordinate(coordinate)));
    }

    hasTrueSight(team, coordinate) {
        return viewedTeams(team).some(view => this.trueSight[view].some(geometry => geometry.intersectsCoordinate(coordinate)));
    }

    getVision(team) {
        return viewedTeams(team).flatMap(view => this.vision[view]);
    }

    canSeeWard(viewingTeam, owner, coordinate) {
        return viewingTeam === 'both' || viewingTeam === owner
            || (this.hasVision(viewingTeam, coordinate) && this.hasTrueSight(viewingTeam, coordinate));
    }
}
