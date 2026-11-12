import { validCoordinates } from './location.ts';

export type MapStyle = 'light' | 'street';
export type MapGeofence = {
  readonly id: string;
  readonly label: string;
  readonly simulation: boolean;
  readonly shape: { readonly type: 'circle'; readonly lat: number; readonly lon: number; readonly radiusM: number }
    | { readonly type: 'bbox'; readonly minLat: number; readonly maxLat: number; readonly minLon: number; readonly maxLon: number };
};

export function validMapGeofence(fence: MapGeofence): boolean {
  const shape = fence.shape;
  if (shape.type === 'circle') return validCoordinates(shape) && Number.isFinite(shape.radiusM) && shape.radiusM > 0 && shape.radiusM <= 1_000_000;
  return validCoordinates({ lat: shape.minLat, lon: shape.minLon }) && validCoordinates({ lat: shape.maxLat, lon: shape.maxLon })
    && shape.minLat < shape.maxLat && shape.minLon < shape.maxLon;
}

const osmAttribution = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
export function mapTileStyle(style: MapStyle, settings: {
  readonly customUrl?: string;
  readonly customAttribution?: string;
  readonly stadiaKey?: string;
  readonly stadiaDomain?: string;
  readonly hostname?: string;
} = {}) {
  const street = { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: `${osmAttribution} contributors`, maxZoom: 19 };
  if (style === 'street') return street;
  if (settings.customUrl) return { url: settings.customUrl, attribution: settings.customAttribution || osmAttribution, maxZoom: 19 };
  const stadiaKey = settings.stadiaKey?.trim();
  const stadiaDomain = settings.stadiaDomain?.trim().toLowerCase();
  if (!stadiaKey && (!stadiaDomain || stadiaDomain !== settings.hostname?.toLowerCase())) return street;
  const key = stadiaKey ? `?api_key=${encodeURIComponent(stadiaKey)}` : '';
  return {
    url: `https://tiles.stadiamaps.com/tiles/alidade_smooth/{z}/{x}/{y}{r}.png${key}`,
    attribution: `&copy; <a href="https://stadiamaps.com/attribution/">Stadia Maps</a> &copy; <a href="https://openmaptiles.org/">OpenMapTiles</a> ${osmAttribution}`,
    maxZoom: 20,
  };
}
