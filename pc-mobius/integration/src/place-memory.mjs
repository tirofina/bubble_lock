import { approvalHash } from './integration-utils.mjs';
import { ROUTINE_DEFAULTS, bearingDeg, episodeCenter, haversineM, stopEpisodes } from './routine-model.mjs';

/**
 * Place memory for the routine model. Stops are clustered incrementally into places; the cells walked between them
 * form corridors. Each place keeps visit counts by time of day and day of week, a dwell distribution and transitions,
 * all with exponential forgetting. The memory lives in plaintext only inside the routine service; at rest it is an
 * AES-256-GCM ciphertext contentInstance, and agents see labels and coarse statistics only.
 */
export const PLACE_MEMORY_VERSION = 'pb-place-memory.v1';
export const PLACE_DEFAULTS = Object.freeze({
  placeRadiusM: 45, minStopSec: 120, cellM: 30, halfLifeDays: 21, familiarWeight: 2, familiarAt: 0.4,
  coldStartDays: 5, maxPlaces: 64, maxDwellSamples: 40, todBinHours: 4,
  noveltySec: 300, noveltyFarM: 400, coldStartAlertScore: 0.55, coldStartDwellFloorSec: 600,
});
const DAY = 86400000;
const round = (value, digits = 0) => Math.round(value * 10 ** digits) / 10 ** digits;
const emptyStore = () => ({ places: [], cells: {}, transitions: {}, trips: 0 });
export const distanceBand = (meters) => (meters < 150 ? 'near home' : meters < 400 ? 'neighbourhood' : meters < 800 ? 'park range' : 'far');

export class PlaceMemory {
  constructor({ home, tzOffsetMin = 0, params = {}, state = null, labeler = null }) {
    this.p = { ...PLACE_DEFAULTS, ...params };
    this.home = { lat: home.lat, lon: home.lon }; this.tzOffsetMin = tzOffsetMin; this.labeler = labeler;
    this.kx = 111320 * Math.cos(home.lat * Math.PI / 180); this.ky = 110540;
    this.state = state ? structuredClone(state) : { version: PLACE_MEMORY_VERSION, solo: emptyStore(), accompanied: emptyStore(), soloDays: 0, accompaniedDays: 0, lastUpdateMs: null, feedback: [], skipped: [] };
  }
  cell(point) { return `${Math.floor((point.lon - this.home.lon) * this.kx / this.p.cellM)}:${Math.floor((point.lat - this.home.lat) * this.ky / this.p.cellM)}`; }
  neighbours(key) { const [x, y] = key.split(':').map(Number); const keys = []; for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) keys.push(`${x + dx}:${y + dy}`); return keys; }
  factor(nowMs) { return this.state.lastUpdateMs === null ? 1 : 0.5 ** (Math.max(0, nowMs - this.state.lastUpdateMs) / (this.p.halfLifeDays * DAY)); }
  /** Exponential forgetting applied to every weight before an update. */
  decayTo(nowMs) {
    const f = this.factor(nowMs);
    for (const store of [this.state.solo, this.state.accompanied]) {
      for (const place of store.places) { place.weight *= f; for (const sample of place.dwell) sample.w *= f; place.tod = place.tod.map((v) => v * f); place.dow = place.dow.map((v) => v * f); }
      for (const key of Object.keys(store.cells)) store.cells[key] *= f;
      for (const key of Object.keys(store.transitions)) store.transitions[key] *= f;
    }
    this.state.lastUpdateMs = Math.max(this.state.lastUpdateMs ?? nowMs, nowMs);
  }
  bins(ms) { const local = new Date(ms + this.tzOffsetMin * 60000); return { tod: Math.floor(local.getUTCHours() / this.p.todBinHours), dow: local.getUTCDay() }; }
  nearestPlace(store, point) {
    let best = null;
    for (const place of store.places) { const d = haversineM(place, point); if (d <= this.p.placeRadiusM && (!best || d < best.d)) best = { place, d }; }
    return best?.place ?? null;
  }
  /** Learn one trip into the solo or the accompanied store. Only the caller's learning gate decides which (see learningDecision). */
  learnTrip({ samples, endedMs, mode }) {
    if (!['solo', 'accompanied'].includes(mode)) throw new Error('place memory learn mode solo or accompanied required');
    const points = samples.map((s) => ({ t: typeof s.t === 'number' ? s.t : Date.parse(s.t), lat: s.lat, lon: s.lon })).sort((a, b) => a.t - b.t);
    this.decayTo(endedMs ?? points.at(-1)?.t ?? Date.now());
    const store = this.state[mode]; const sequence = ['home'];
    for (const episode of stopEpisodes(points, { stopRadiusM: ROUTINE_DEFAULTS.stopRadiusM, nominalIntervalSec: ROUTINE_DEFAULTS.nominalIntervalSec })) {
      const center = episodeCenter(episode.samples);
      if (episode.dwellSec < this.p.minStopSec || haversineM(center, this.home) <= this.p.placeRadiusM) continue;
      let place = this.nearestPlace(store, center);
      if (!place && store.places.length < this.p.maxPlaces) {
        place = { id: `place-${store.places.length + 1}`, label: this.labeler?.(center) ?? `place ${store.places.length + 1}`, lat: center.lat, lon: center.lon, weight: 0, visits: 0, tod: Array(24 / this.p.todBinHours).fill(0), dow: Array(7).fill(0), dwell: [], feedbackOk: false, firstSeenMs: episode.startMs };
        store.places.push(place);
      }
      if (!place) continue;
      const total = place.weight + 1;
      place.lat = (place.lat * place.weight + center.lat) / total; place.lon = (place.lon * place.weight + center.lon) / total;
      place.weight = total; place.visits += 1; place.lastSeenMs = episode.startMs;
      const { tod, dow } = this.bins(episode.startMs); place.tod[tod] += 1; place.dow[dow] += 1;
      place.dwell.push({ sec: episode.dwellSec, w: 1 }); if (place.dwell.length > this.p.maxDwellSamples) place.dwell.shift();
      if (sequence.at(-1) !== place.id) sequence.push(place.id);
    }
    sequence.push('home');
    for (let i = 1; i < sequence.length; i += 1) { const key = `${sequence[i - 1]}>${sequence[i]}`; store.transitions[key] = (store.transitions[key] ?? 0) + 1; }
    for (const key of new Set(points.filter((p) => haversineM(p, this.home) > this.p.placeRadiusM).map((p) => this.cell(p)))) store.cells[key] = (store.cells[key] ?? 0) + 1;
    store.trips += 1; if (mode === 'solo') this.state.soloDays += 1; else this.state.accompaniedDays += 1;
    return { mode, places: store.places.length, cells: Object.keys(store.cells).length, sequence };
  }
  /** Guardian feedback "this place is fine": the place joins the solo memory at full familiarity. */
  markPlaceOk({ point, atMs, label = null }) {
    this.decayTo(atMs);
    const store = this.state.solo; let place = this.nearestPlace(store, point);
    if (!place) { place = { id: `place-${store.places.length + 1}`, label: label ?? this.labeler?.(point) ?? `place ${store.places.length + 1}`, lat: point.lat, lon: point.lon, weight: 0, visits: 0, tod: Array(24 / this.p.todBinHours).fill(0), dow: Array(7).fill(0), dwell: [], feedbackOk: false, firstSeenMs: atMs }; store.places.push(place); }
    place.weight = Math.max(place.weight, this.p.familiarWeight); place.feedbackOk = true; if (label) place.label = label;
    this.state.feedback.push({ placeId: place.id, atMs, kind: 'PLACE_OK' });
    return { placeId: place.id, label: place.label };
  }
  get coldStart() { return this.state.soloDays < this.p.coldStartDays; }
  /** Familiarity of a point for solo walks (0..1), the place under it and its dwell reference; coordinates stay inside. */
  score(point, nowMs) {
    const f = this.factor(nowMs); const store = this.state.solo; const home = haversineM(point, this.home);
    if (home <= this.p.placeRadiusM) return { familiarity: 1, label: 'home', placeId: 'home', distanceBand: 'near home', distanceHomeM: home, dwellRefSec: null, coldStart: this.coldStart };
    const place = this.nearestPlace(store, point);
    const placeFamiliarity = place ? Math.min(1, place.weight * f / this.p.familiarWeight) : 0;
    const cellFamiliarity = Math.min(1, Math.max(0, ...this.neighbours(this.cell(point)).map((key) => (store.cells[key] ?? 0) * f)) / this.p.familiarWeight);
    const familiarity = Math.max(placeFamiliarity, cellFamiliarity);
    const known = place && placeFamiliarity >= this.p.familiarAt;
    const dwell = known ? weightedQuantile(place.dwell.map((s) => ({ v: s.sec, w: s.w * f })), 0.95) : null;
    return { familiarity: round(familiarity, 2), label: known ? `familiar ${place.label}` : familiarity >= this.p.familiarAt ? 'familiar route' : 'unfamiliar area', placeId: known ? place.id : null,
      distanceBand: distanceBand(home), distanceHomeM: home, dwellRefSec: dwell, coldStart: this.coldStart };
  }
  /** Agent-facing summary: labels, counts, time bands and dwell minutes; no coordinates. */
  describe(nowMs) {
    const f = this.factor(nowMs);
    const bandLabel = (index) => `${String(index * this.p.todBinHours).padStart(2, '0')}-${String((index + 1) * this.p.todBinHours).padStart(2, '0')}h`;
    return { version: PLACE_MEMORY_VERSION, soloDays: this.state.soloDays, accompaniedDays: this.state.accompaniedDays, coldStart: this.coldStart, corridorCells: Object.values(this.state.solo.cells).filter((w) => w * f / this.p.familiarWeight >= this.p.familiarAt).length,
      places: this.state.solo.places.map((place) => ({ label: place.label, familiarity: round(Math.min(1, place.weight * f / this.p.familiarWeight), 2), visits: place.visits, usualTimeBand: bandLabel(place.tod.indexOf(Math.max(...place.tod))),
        dwellP50Min: round((weightedQuantile(place.dwell.map((s) => ({ v: s.sec, w: s.w * f })), 0.5) ?? 0) / 60, 1), guardianMarkedOk: place.feedbackOk, distanceBand: distanceBand(haversineM(place, this.home)) })).sort((a, b) => b.familiarity - a.familiarity).slice(0, 16),
      accompaniedPlaces: this.state.accompanied.places.length };
  }
  stateHash() { return approvalHash(this.state); }
}

function weightedQuantile(entries, q) {
  const sorted = entries.filter((e) => Number.isFinite(e.v) && e.w > 0).sort((a, b) => a.v - b.v);
  const total = sorted.reduce((sum, e) => sum + e.w, 0); if (!total) return null;
  let acc = 0; for (const entry of sorted) { acc += entry.w; if (acc >= q * total) return entry.v; }
  return sorted.at(-1).v;
}

/**
 * Learning gate against poisoning. Solo trips update the solo-normal memory only when they ended normally (no guardian
 * alert, or the guardian dismissed the alert as OK); accompanied trips go to a separate store; everything else is skipped.
 */
export function learningDecision({ accompanied, guardianAlerts = 0, guardianDismissedOk = false, panic = false }) {
  if (panic) return { learn: false, mode: null, reason: 'PANIC during the trip' };
  if (accompanied) return { learn: true, mode: 'accompanied', reason: 'accompanied trip (separate store)' };
  if (guardianAlerts === 0) return { learn: true, mode: 'solo', reason: 'solo trip ended without alert' };
  if (guardianDismissedOk) return { learn: true, mode: 'solo', reason: 'guardian dismissed the alert as OK' };
  return { learn: false, mode: null, reason: 'alert not dismissed by the guardian' };
}

/** Sealed at-rest form: AES-256-GCM via the location-privacy MecCipher, bound to the resident and the memory version. */
export async function sealPlaceMemory(memory, cipher, residentId) {
  await cipher.ready;
  return { type: 'PLACE_MEMORY', version: PLACE_MEMORY_VERSION, residentId, stateHash: memory.stateHash(), sealed: cipher.seal(memory.state, `place-memory:${residentId}`) };
}
export async function openPlaceMemory(record, cipher, { home, tzOffsetMin, params, labeler }) {
  await cipher.ready;
  const state = cipher.open(record.sealed, `place-memory:${record.residentId}`);
  const memory = new PlaceMemory({ home, tzOffsetMin, params, state, labeler });
  if (memory.stateHash() !== record.stateHash) throw new Error('place memory state hash review required');
  return memory;
}

/**
 * Companion check. A report counts as co-located when resident and companion share the MEC zone or cell, are closer
 * than maxDistanceM and move with similar heading and speed (or both stand still). `consecutive` co-located reports
 * make the trip accompanied; a simulated guardian-phone BLE sighting of the keyring does the same without location.
 */
export class CompanionTracker {
  constructor({ maxDistanceM = 50, consecutive = 3, maxHeadingDiffDeg = 60, maxSpeedDiffMps = 0.5 } = {}) {
    Object.assign(this, { maxDistanceM, consecutive, maxHeadingDiffDeg, maxSpeedDiffMps });
    this.streak = 0; this.previous = null; this.accompanied = false; this.reason = null; this.coLocatedReports = 0; this.since = null;
  }
  observe({ t, resident, companion = null, bleSeenByGuardianPhone = false }) {
    const prev = this.previous; this.previous = { t, resident, companion };
    if (bleSeenByGuardianPhone) { this.mark(t, 'guardian phone sees the keyring over BLE (simulated flag)'); return this.status(); }
    if (!companion || !resident) { this.streak = 0; return this.status(); }
    const sameNetwork = (resident.zoneId && resident.zoneId === companion.zoneId) || (resident.cellId && resident.cellId === companion.cellId);
    const close = haversineM(resident, companion) < this.maxDistanceM;
    let similar = true;
    if (prev?.resident && prev?.companion) {
      const dt = Math.max(1, (t - prev.t) / 1000);
      const rSpeed = haversineM(prev.resident, resident) / dt; const cSpeed = haversineM(prev.companion, companion) / dt;
      const still = rSpeed < 0.2 && cSpeed < 0.2;
      const headingDiff = still ? 0 : Math.abs(((bearingDeg(prev.resident, resident) - bearingDeg(prev.companion, companion) + 540) % 360) - 180);
      similar = still || (Math.abs(rSpeed - cSpeed) <= this.maxSpeedDiffMps && headingDiff <= this.maxHeadingDiffDeg);
    }
    if (sameNetwork && close && similar) { this.streak += 1; this.coLocatedReports += 1; if (this.streak >= this.consecutive) this.mark(t, `MEC013 co-location for ${this.streak} consecutive reports (same zone or cell, under ${this.maxDistanceM} m, similar heading and speed)`); }
    else this.streak = 0;
    return this.status();
  }
  mark(t, reason) { if (!this.accompanied) { this.accompanied = true; this.since = t; this.reason = reason; } }
  status() { return { accompanied: this.accompanied, reason: this.reason, streak: this.streak, coLocatedReports: this.coLocatedReports, since: this.since }; }
}
