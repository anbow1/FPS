import { buildBoulevard } from './boulevard.ts';
import { buildCity } from './city.ts';
import { buildForest } from './forest.ts';
import { buildRange } from './range.ts';
import type { MapData, MapId } from './types.ts';

// Map generators are deterministic: the same id always builds the same map.

export function buildMap(id: MapId): MapData {
  switch (id) {
    case 'range':
      return buildRange();
    case 'city':
      return buildCity();
    case 'forest':
      return buildForest();
    case 'boulevard':
      return buildBoulevard();
  }
}

export const MAP_LABELS: Record<MapId, string> = {
  range: 'Range',
  city: 'City block',
  forest: 'Forest ridge',
  boulevard: 'Boulevard',
};
