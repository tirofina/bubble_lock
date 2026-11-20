import { approvalHash } from './integration-utils.mjs';

/**
 * Deterministic routine model for the resident's evening walk.
 * The profile is learned from several normal walk days (oneM2M location history); the detector scores the
 * live evening against it. No LLM is involved: every threshold, weight and feature is fixed and listed here,
 * so the alert decision can be replayed from the same samples.
 */
export const ROUTINE_MODEL_VERSION = 'pb-routine-model.v1';
export const ROUTINE_DEFAULTS = Object.freeze({
  stopRadiusM: 35, // a stop episode stays within this radius of its first sample
  corridorTolM: 35, // farther than this from every usual segment = off the usual corridor
  minCorridorDays: 2, // a segment belongs to the corridor when it was visited on at least this many days
  minDwellSec: 120, // dwell reference floor for segments without a learned stop
  minGapSec: 120, // signal-gap reference floor
  gapFactor: 1.5, // gap reference = max(minGapSec, gapFactor x learned p95 gap of the segment)
  nominalIntervalSec: 20,
  minLegM: 8, // heading legs shorter than this are position noise
  reversalDeg: 135, // a heading change above this between legs is a reversal (back-and-forth)
  separationM: 150, // keyring at home while the relay UE is farther than this from home
  separationSec: 120,
  deviceFreshSec: 900,
  weights: Object.freeze({ dwell: 0.40, pacing: 0.20, offCorridor: 0.15, dusk: 0.15, distance: 0.10 }),
  alertScore: 0.45,
  dwellRamp: 1.5, // dwell component reaches 1 at (1 + dwellRamp) x reference
  pacingFull: 3, // reversals for a full pacing component
  offCorridorRampSec: 180,
  duskLeadMin: 15, // dusk component starts this many minutes before sunset
  duskRampMin: 30,
  lateRampMin: 15,
  distanceScaleM: 800,
});

const EARTH_R = 6371000;
const rad = (value) => value * Math.PI / 180;
const clamp01 = (value) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
const round = (value, digits = 0) => (Number.isFinite(value) ? Math.round(value * 10 ** digits) / 10 ** digits : null);

export function haversineM(a, b) {
  const x = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(Math.min(1, x)));
}
export function bearingDeg(a, b) {
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
/** Coordinate-wise median of a stop episode: the place where the time was spent (the anchor is only the entry point). */
export const episodeCenter = (samples) => ({ lat: quantileSorted(samples.map((sample) => sample.lat)), lon: quantileSorted(samples.map((sample) => sample.lon)) });
const quantileSorted = (values) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor((sorted.length - 1) / 2)]; };
const angleDiff = (left, right) => { const value = Math.abs(left - right) % 360; return value > 180 ? 360 - value : value; };

/** Nearest-rank quantile; with n samples p95 is the ceil(0.95 n)-th smallest value. */
export function quantile(values, q) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}
const median = (values) => quantile(values, 0.5);

/** NOAA solar position approximation; returns local minutes after midnight for sunrise and sunset. */
export function solarTimes({ date, lat, lon, tzOffsetMin = 0 }) {
  const [year, month, day] = date.split('-').map(Number);
  const dayOfYear = Math.round((Date.UTC(year, month - 1, day) - Date.UTC(year, 0, 0)) / 86400000);
  const gamma = 2 * Math.PI / 365 * (dayOfYear - 1);
  const eqTime = 229.18 * (0.000075 + 0.001868 * Math.cos(gamma) - 0.032077 * Math.sin(gamma) - 0.014615 * Math.cos(2 * gamma) - 0.040849 * Math.sin(2 * gamma));
  const decl = 0.006918 - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma) - 0.006758 * Math.cos(2 * gamma) + 0.000907 * Math.sin(2 * gamma) - 0.002697 * Math.cos(3 * gamma) + 0.00148 * Math.sin(3 * gamma);
  const cosHa = Math.cos(rad(90.833)) / (Math.cos(rad(lat)) * Math.cos(decl)) - Math.tan(rad(lat)) * Math.tan(decl);
  const ha = Math.acos(Math.max(-1, Math.min(1, cosHa))) * 180 / Math.PI;
  const sunriseUtc = 720 - 4 * (lon + ha) - eqTime; const sunsetUtc = 720 - 4 * (lon - ha) - eqTime;
  return { sunriseLocalMin: round(sunriseUtc + tzOffsetMin, 1), sunsetLocalMin: round(sunsetUtc + tzOffsetMin, 1), sunsetIso: new Date(Date.UTC(year, month - 1, day) + sunsetUtc * 60000).toISOString() };
}

/** Walk map: home, named nodes and straight segments between nodes. */
export class RoutineMap {
  constructor({ mapId, home, homeRadiusM = 40, tzOffsetMin = 0, nodes, segments }) {
    if (!home || !Number.isFinite(home.lat) || !Number.isFinite(home.lon)) throw new Error('Routine map home point required');
    if (!nodes || !Array.isArray(segments) || !segments.length) throw new Error('Routine map nodes and segments required');
    this.mapId = mapId ?? 'routine-map'; this.home = { lat: home.lat, lon: home.lon }; this.homeRadiusM = homeRadiusM; this.tzOffsetMin = tzOffsetMin;
    this.nodes = Object.fromEntries(Object.entries(nodes).map(([name, point]) => [name, { lat: point.lat, lon: point.lon }]));
    this.kx = 111320 * Math.cos(rad(this.home.lat)); this.ky = 110540;
    this.segments = segments.map((segment) => {
      const from = this.nodes[segment.from]; const to = this.nodes[segment.to];
      if (!from || !to) throw new Error(`Routine map segment ${segment.id} nodes required`);
      return { id: segment.id, name: segment.name ?? segment.id, kind: segment.kind ?? 'path', from: segment.from, to: segment.to, a: this.xy(from), b: this.xy(to), lengthM: haversineM(from, to) };
    });
    this.byId = new Map(this.segments.map((segment) => [segment.id, segment]));
  }
  xy(point) { return { x: (point.lon - this.home.lon) * this.kx, y: (point.lat - this.home.lat) * this.ky }; }
  segmentDistance(point, segment) {
    const p = this.xy(point); const { a, b } = segment; const dx = b.x - a.x; const dy = b.y - a.y; const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }
  match(point, ids = null) {
    let best = null;
    for (const segment of this.segments) {
      if (ids && !ids.has(segment.id)) continue;
      const distanceM = this.segmentDistance(point, segment);
      if (!best || distanceM < best.distanceM) best = { segmentId: segment.id, name: segment.name, kind: segment.kind, distanceM };
    }
    return best;
  }
  distanceHomeM(point) { return haversineM(point, this.home); }
  localMinutes(ms) { const value = new Date(ms + this.tzOffsetMin * 60000); return value.getUTCHours() * 60 + value.getUTCMinutes() + value.getUTCSeconds() / 60; }
  localTime(ms, seconds = false) { const value = new Date(ms + this.tzOffsetMin * 60000).toISOString(); return seconds ? value.slice(11, 19) : value.slice(11, 16); }
  localDate(ms) { return new Date(ms + this.tzOffsetMin * 60000).toISOString().slice(0, 10); }
  sunset(ms) { return solarTimes({ date: this.localDate(ms), lat: this.home.lat, lon: this.home.lon, tzOffsetMin: this.tzOffsetMin }); }
  describe() { return { mapId: this.mapId, homeRadiusM: this.homeRadiusM, tzOffsetMin: this.tzOffsetMin, segments: this.segments.map(({ id, name, kind, from, to, lengthM }) => ({ id, name, kind, from, to, lengthM: round(lengthM) })) }; }
}

const normalize = (samples) => samples.map((sample) => ({ t: typeof sample.t === 'number' ? sample.t : Date.parse(sample.t), lat: sample.lat, lon: sample.lon })).filter((sample) => Number.isFinite(sample.t) && Number.isFinite(sample.lat) && Number.isFinite(sample.lon)).sort((a, b) => a.t - b.t);

/** Anchor-based stop episodes; a sample gap longer than two nominal intervals closes the episode. */
export function stopEpisodes(samples, { stopRadiusM, nominalIntervalSec }) {
  const episodes = []; let current = null;
  for (const sample of samples) {
    const broken = current && (sample.t - current.lastMs > 2 * nominalIntervalSec * 1000 || haversineM(current.anchor, sample) > stopRadiusM);
    if (!current || broken) { if (current) episodes.push(current); current = { anchor: sample, startMs: sample.t, lastMs: sample.t, samples: [sample] }; continue; }
    current.lastMs = sample.t; current.samples.push(sample);
  }
  if (current) episodes.push(current);
  return episodes.map((episode) => ({ ...episode, dwellSec: (episode.lastMs - episode.startMs) / 1000 }));
}

/** Heading reversals between legs of at least minLegM (position noise below that length is ignored). */
export function countReversals(samples, { minLegM, reversalDeg }) {
  let pivot = samples[0]; let previous = null; let reversals = 0;
  for (const sample of samples.slice(1)) {
    if (haversineM(pivot, sample) < minLegM) continue;
    const heading = bearingDeg(pivot, sample);
    if (previous !== null && angleDiff(previous, heading) > reversalDeg) reversals += 1;
    previous = heading; pivot = sample;
  }
  return reversals;
}

/** Stop episodes of at least minSec inside [fromMs, toMs], named by the map segment at the episode median (server side). */
export function recentStops(samples, map, { fromMs, toMs, minSec = 60, params = {} } = {}) {
  const p = { ...ROUTINE_DEFAULTS, ...params };
  const window = samples.filter((sample) => sample.t >= fromMs && sample.t <= toMs);
  return stopEpisodes(window, p).filter((episode) => episode.dwellSec >= minSec && map.distanceHomeM(episodeCenter(episode.samples)) > map.homeRadiusM).map((episode) => {
    const match = map.match(episodeCenter(episode.samples));
    return { place: match.distanceM <= p.corridorTolM ? match.name : 'unmapped area', fromMs: episode.startMs, toMs: episode.lastMs, reversals: countReversals(episode.samples, p), withinM: p.stopRadiusM };
  });
}

function walkBounds(samples, map) {
  const departIndex = samples.findIndex((sample) => map.distanceHomeM(sample) > map.homeRadiusM);
  if (departIndex < 0) return { departMs: null, returnMs: null };
  const back = samples.slice(departIndex).find((sample) => map.distanceHomeM(sample) <= map.homeRadiusM);
  return { departMs: samples[departIndex].t, returnMs: back?.t ?? null };
}

/** Learn the routine profile from normal walk days. */
export function trainRoutineProfile({ map, days, params = {} }) {
  const p = { ...ROUTINE_DEFAULTS, ...params };
  if (!(map instanceof RoutineMap) || !Array.isArray(days) || days.length < 3) throw new Error('Routine profile needs a map and at least three normal days');
  const visits = {}; const dwell = {}; const gaps = {}; const departs = []; const returns = []; const speeds = []; const dayIds = [];
  for (const day of days) {
    const samples = normalize(day.samples); dayIds.push(day.dayId);
    const visited = new Set();
    for (const sample of samples) { const match = map.match(sample); if (match.distanceM <= p.corridorTolM) visited.add(match.segmentId); }
    for (const id of visited) visits[id] = (visits[id] ?? 0) + 1;
    const dayMax = {};
    for (const episode of stopEpisodes(samples, p)) {
      if (map.distanceHomeM(episodeCenter(episode.samples)) <= map.homeRadiusM) continue;
      const id = map.match(episodeCenter(episode.samples)).segmentId; dayMax[id] = Math.max(dayMax[id] ?? 0, episode.dwellSec);
    }
    for (const [id, value] of Object.entries(dayMax)) (dwell[id] ??= []).push(value);
    for (let index = 1; index < samples.length; index += 1) {
      const gapSec = (samples[index].t - samples[index - 1].t) / 1000;
      if (gapSec > 2 * p.nominalIntervalSec) (gaps[map.match(samples[index - 1]).segmentId] ??= []).push(gapSec);
      const moved = haversineM(samples[index - 1], samples[index]);
      if (gapSec > 0 && gapSec <= 2 * p.nominalIntervalSec && moved / gapSec > 0.3) speeds.push(moved / gapSec);
    }
    const bounds = walkBounds(samples, map);
    if (bounds.departMs) departs.push(map.localMinutes(bounds.departMs));
    if (bounds.returnMs) returns.push(map.localMinutes(bounds.returnMs));
  }
  const corridor = Object.fromEntries(Object.entries(visits).filter(([, count]) => count >= p.minCorridorDays).sort().map(([id, count]) => [id, { days: count, fraction: round(count / days.length, 2) }]));
  const stat = (values) => ({ n: values.length, p50: round(median(values)), p95: round(quantile(values, 0.95)), max: round(Math.max(...values)) });
  const profile = {
    modelVersion: ROUTINE_MODEL_VERSION, mapId: map.mapId, days: days.length, dayIds, synthetic: days.every((day) => day.synthetic === true),
    params: Object.fromEntries(Object.entries(p).filter(([key]) => key !== 'weights')), weights: { ...p.weights },
    corridor,
    dwell: Object.fromEntries(Object.entries(dwell).sort().map(([id, values]) => [id, stat(values)])),
    gaps: Object.fromEntries(Object.entries(gaps).sort().map(([id, values]) => [id, stat(values)])),
    departure: { p50Min: round(median(departs), 1), p95Min: round(quantile(departs, 0.95), 1) },
    return: { p50Min: round(median(returns), 1), p95Min: round(quantile(returns, 0.95), 1), n: returns.length },
    speed: { p50Mps: round(median(speeds), 2) },
  };
  return { ...profile, profileHash: approvalHash(profile) };
}

const minutesLabel = (minutes) => (Number.isFinite(minutes) ? `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(Math.floor(minutes % 60)).padStart(2, '0')}` : null);

/** Guardian- and agent-facing profile summary (segment names, times; no coordinates). */
export function summarizeProfile(profile, map) {
  const name = (id) => map.byId.get(id)?.name ?? id;
  return {
    modelVersion: profile.modelVersion, days: profile.days, synthetic: profile.synthetic, profileHash: profile.profileHash,
    usualDeparture: minutesLabel(profile.departure.p50Min), usualReturn: minutesLabel(profile.return.p50Min), latestUsualReturn: minutesLabel(profile.return.p95Min),
    corridor: Object.entries(profile.corridor).map(([id, entry]) => ({ segment: name(id), kind: map.byId.get(id)?.kind ?? 'path', days: entry.days })),
    usualStops: Object.entries(profile.dwell).filter(([, entry]) => entry.p95 >= profile.params.minDwellSec).map(([id, entry]) => ({ segment: name(id), p50Sec: entry.p50, p95Sec: entry.p95, days: entry.n })),
    usualSignalGaps: Object.entries(profile.gaps).map(([id, entry]) => ({ segment: name(id), p95Sec: entry.p95, days: entry.n })),
    walkingSpeedMps: profile.speed.p50Mps,
  };
}

/**
 * Online detector for one evening. observe() takes location samples (precise, inside the trusted server boundary),
 * observeDevice() takes keyring state, evaluate(now) returns the feature vector and newly raised alerts.
 * Alert kinds: WANDERING (dwell/pacing/off-corridor in context), SIGNAL_GAP (missing samples beyond the usual gap),
 * DEVICE_SEPARATION (keyring seen at home while the relay UE walks away).
 */
export class RoutineDetector {
  /**
   * memory (optional, PlaceMemory): familiarity replaces the segment corridor, place dwell replaces segment dwell, a
   * novelty rule (solo, unfamiliar and far) joins WANDERING and cold start raises the thresholds. Without memory the
   * detector behaves exactly as the segment profile v1.
   */
  constructor({ map, profile = null, params = {}, memory = null }) {
    if (!(map instanceof RoutineMap) || (!profile?.profileHash && !memory)) throw new Error('Routine detector needs a map and a trained profile or a place memory');
    profile ??= { params: {}, weights: {}, corridor: {}, dwell: {}, gaps: {}, return: { p50Min: null, p95Min: 24 * 60 }, profileHash: 'place-memory-only' };
    this.map = map; this.profile = profile; this.memory = memory; this.p = { ...ROUTINE_DEFAULTS, ...profile.params, ...params, weights: { ...ROUTINE_DEFAULTS.weights, ...profile.weights, ...(params.weights ?? {}) } };
    this.corridor = new Set(Object.keys(profile.corridor));
    this.samples = []; this.episode = null; this.offSinceMs = null; this.departMs = null; this.returned = false;
    this.device = null; this.separationSinceMs = null; this.raised = new Set(); this.alerts = []; this.companion = { accompanied: false };
  }
  /** Companion status from CompanionTracker: while accompanied, novelty and distance alerts stay off (PANIC is separate). */
  observeCompanion(status) { this.companion = { ...status }; }
  unfamiliar(point) { return this.memory ? this.memory.score(point, point.t).familiarity < this.memory.p.familiarAt : this.map.match(point, this.corridor)?.distanceM > this.p.corridorTolM; }
  observe(sample) {
    const point = { t: typeof sample.t === 'number' ? sample.t : Date.parse(sample.t), lat: sample.lat, lon: sample.lon };
    const last = this.samples.at(-1);
    if (last && point.t <= last.t) return;
    this.samples.push(point);
    const home = this.map.distanceHomeM(point) <= this.map.homeRadiusM;
    if (!home && this.departMs === null) this.departMs = point.t;
    if (home && this.departMs !== null) this.returned = true; else if (!home) this.returned = false;
    const broken = this.episode && (point.t - this.episode.lastMs > 2 * this.p.nominalIntervalSec * 1000 || haversineM(this.episode.anchor, point) > this.p.stopRadiusM);
    if (!this.episode || broken) this.episode = { anchor: point, startMs: point.t, lastMs: point.t, samples: [point] };
    else { this.episode.lastMs = point.t; this.episode.samples.push(point); }
    const off = !home && this.unfamiliar(point);
    this.offSinceMs = off ? (this.offSinceMs ?? point.t) : null;
  }
  observeDevice(state) { this.device = { ...state, t: typeof state.t === 'number' ? state.t : Date.parse(state.t) }; }
  features(nowMs) {
    const last = this.samples.at(-1); const p = this.p;
    if (!last) return null;
    const anchorMatch = this.map.match(episodeCenter(this.episode.samples)); const lastMatch = this.map.match(last);
    const segment = anchorMatch.distanceM <= p.corridorTolM ? anchorMatch : { segmentId: 'off-map', name: 'unmapped area', kind: 'unknown', distanceM: anchorMatch.distanceM };
    const place = this.memory ? this.memory.score(episodeCenter(this.episode.samples), nowMs) : null;
    const coldStart = Boolean(place?.coldStart);
    const corridorDistanceM = this.memory ? (this.unfamiliar(last) ? p.corridorTolM + 1 : 0) : this.map.match(last, this.corridor)?.distanceM ?? Infinity;
    const offCorridorSec = this.offSinceMs === null ? 0 : (last.t - this.offSinceMs) / 1000;
    const dwellSec = (this.episode.lastMs - this.episode.startMs) / 1000;
    const dwellFloor = coldStart ? Math.max(p.minDwellSec, this.memory.p.coldStartDwellFloorSec) : p.minDwellSec;
    const dwellRefSec = Math.max(place ? place.dwellRefSec ?? 0 : this.profile.dwell[segment.segmentId]?.p95 ?? 0, dwellFloor);
    const recent = this.samples.filter((sample) => sample.t >= last.t - 120000);
    const speeds = recent.slice(1).map((sample, index) => haversineM(recent[index], sample) / Math.max(1, (sample.t - recent[index].t) / 1000));
    const sun = this.map.sunset(nowMs); const localMin = this.map.localMinutes(nowMs);
    const gapSec = (nowMs - last.t) / 1000;
    const gapRefSec = Math.max(p.minGapSec, p.gapFactor * (this.profile.gaps[lastMatch.segmentId]?.p95 ?? 0));
    const distanceHomeM = this.map.distanceHomeM(last);
    const walkActive = this.departMs !== null && !this.returned;
    const components = {
      dwell: clamp01((dwellSec / dwellRefSec - 1) / p.dwellRamp),
      pacing: clamp01(countReversals(this.episode.samples, p) / p.pacingFull),
      offCorridor: corridorDistanceM > p.corridorTolM && !coldStart ? clamp01(offCorridorSec / p.offCorridorRampSec) : 0,
      dusk: Math.max(clamp01((localMin - sun.sunsetLocalMin + p.duskLeadMin) / p.duskRampMin), clamp01((localMin - this.profile.return.p95Min) / p.lateRampMin)),
      distance: clamp01(distanceHomeM / p.distanceScaleM),
    };
    const score = Object.entries(p.weights).reduce((sum, [key, weight]) => sum + weight * components[key], 0);
    return {
      at: nowMs, localTime: this.map.localTime(nowMs), walkActive, segment: { id: segment.segmentId, name: segment.name, kind: segment.kind },
      dwellSec: round(dwellSec), dwellRefSec: round(dwellRefSec), dwellRatio: round(dwellSec / dwellRefSec, 2), reversals: countReversals(this.episode.samples, p),
      speedMps: round(median(speeds) ?? 0, 2), corridorDistanceM: round(Math.min(corridorDistanceM, 9999)), offCorridorSec: round(offCorridorSec),
      offCorridorSince: this.offSinceMs ? this.map.localTime(this.offSinceMs) : null, stopSince: this.map.localTime(this.episode.startMs),
      minutesAfterSunset: round(localMin - sun.sunsetLocalMin, 1), sunsetLocal: minutesLabel(sun.sunsetLocalMin), minutesPastUsualReturn: round(localMin - this.profile.return.p95Min, 1),
      distanceHomeM: round(distanceHomeM), gapSec: round(gapSec), gapRefSec: round(gapRefSec), lastSampleAt: this.map.localTime(last.t, true),
      components: Object.fromEntries(Object.entries(components).map(([key, value]) => [key, round(value, 3)])), score: round(score, 3),
      ...(place ? { place: { label: place.label, familiarity: place.familiarity, distanceBand: place.distanceBand, coldStart } } : {}),
      ...(this.companion.accompanied ? { accompanied: true } : {}),
    };
  }
  raise(kind, key, nowMs, features, { score, startedMs, severityHint }) {
    if (this.raised.has(kind === 'SIGNAL_GAP' ? key : kind)) return null;
    this.raised.add(kind === 'SIGNAL_GAP' ? key : kind);
    const alert = { kind, score: round(score, 3), severityHint, detectedAt: new Date(nowMs).toISOString(), detectedLocal: this.map.localTime(nowMs, true), startedAt: new Date(startedMs).toISOString(), startedLocal: this.map.localTime(startedMs), segment: features.segment, features, modelVersion: ROUTINE_MODEL_VERSION, profileHash: this.profile.profileHash };
    this.alerts.push(alert); return alert;
  }
  evaluate(nowMs) {
    const features = this.features(nowMs); const raised = [];
    if (!features || !features.walkActive) { if (this.returned) this.separationSinceMs = null; return { features, alerts: raised }; }
    const p = this.p; const last = this.samples.at(-1);
    if (features.gapSec > features.gapRefSec) {
      const alert = this.raise('SIGNAL_GAP', `gap:${last.t}`, nowMs, features, { score: clamp01(features.gapSec / (2 * features.gapRefSec)), startedMs: last.t, severityHint: 'check' });
      if (alert) raised.push(alert);
    } else if (!this.companion.accompanied) {
      const threshold = features.place?.coldStart ? this.memory.p.coldStartAlertScore : p.alertScore;
      const behaviour = (features.dwellRatio >= 1 || features.offCorridorSec >= 120) && features.score >= threshold;
      const novelty = Boolean(this.memory) && !features.place?.coldStart && features.offCorridorSec >= this.memory.p.noveltySec && features.distanceHomeM >= this.memory.p.noveltyFarM;
      if (behaviour || novelty) {
        const starts = [features.dwellRatio >= 1 ? this.episode.startMs : Infinity, this.offSinceMs ?? Infinity];
        const alert = this.raise('WANDERING', 'walk', nowMs, { ...features, trigger: behaviour ? 'behaviour' : 'novelty' }, { score: features.score, startedMs: Math.min(...starts), severityHint: features.score >= 0.6 ? 'urgent' : 'watch' });
        if (alert) raised.push(alert);
      }
    }
    const device = this.device;
    const separated = device && device.bleSeenBy === 'home-gateway' && nowMs - device.t <= p.deviceFreshSec * 1000 && features.distanceHomeM > p.separationM;
    this.separationSinceMs = separated ? (this.separationSinceMs ?? nowMs) : null;
    if (separated && nowMs - this.separationSinceMs >= p.separationSec * 1000) {
      const alert = this.raise('DEVICE_SEPARATION', 'walk', nowMs, { ...features, keyring: { bleSeenBy: device.bleSeenBy, battery: device.battery ?? null, seenAt: this.map.localTime(device.t) } },
        { score: 0.5 + 0.5 * clamp01(features.distanceHomeM / p.distanceScaleM), startedMs: this.departMs, severityHint: 'watch' });
      if (alert) raised.push(alert);
    }
    return { features, alerts: raised };
  }
}

/**
 * Rule-only baseline: one dwell threshold on the last known position, home zone excluded, no other context.
 * The clock keeps running while no new sample arrives (a frozen last position counts as dwell); the rule re-arms
 * after the position moves beyond radiusM, so every long stop raises its own alert.
 */
export class DwellThresholdBaseline {
  constructor({ map, thresholdSec = 300, radiusM = ROUTINE_DEFAULTS.stopRadiusM }) { Object.assign(this, { map, thresholdSec, radiusM }); this.anchor = null; this.armed = false; this.alerts = []; }
  observe(sample) {
    const point = { t: typeof sample.t === 'number' ? sample.t : Date.parse(sample.t), lat: sample.lat, lon: sample.lon };
    if (!this.anchor || haversineM(this.anchor, point) > this.radiusM) { this.anchor = point; this.armed = true; }
  }
  evaluate(nowMs) {
    if (!this.anchor || !this.armed || this.map.distanceHomeM(this.anchor) <= this.map.homeRadiusM) return null;
    const dwellSec = (nowMs - this.anchor.t) / 1000;
    if (dwellSec <= this.thresholdSec) return null;
    this.armed = false;
    const alert = { kind: 'DWELL_THRESHOLD', thresholdSec: this.thresholdSec, dwellSec: round(dwellSec), detectedAt: new Date(nowMs).toISOString(), detectedLocal: this.map.localTime(nowMs, true), startedLocal: this.map.localTime(this.anchor.t) };
    this.alerts.push(alert); return alert;
  }
}
