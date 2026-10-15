import { featureCollection } from '@turf/helpers';
import { union } from '@turf/union';

export function unionFeatures(first, second) {
    if (first == null) return second;
    if (second == null) return first;
    return union(featureCollection([first, second]));
}
