import { RoutineMap, haversineM } from './routine-model.mjs';

/**
 * Synthetic evening walks for the routine model and the anomaly triage evaluation.
 * Every track is generated from a walk definition (nodes and segments placed on a sandbox map) and is labelled synthetic.
 * A definition carries its routes, the normal training days and the evaluation case specs, so the same runner works on
 * the bubble development map and on the dayofcare scenario trail.
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export const localToMs = (date, time, tzOffsetMin) => { const [y, m, d] = date.split('-').map(Number); const [hh, mm, ss = 0] = time.split(':').map(Number); return Date.UTC(y, m - 1, d, hh, mm, ss) - tzOffsetMin * 60000; };
const toward = (from, to, meters) => { const total = haversineM(from, to); const f = total ? Math.min(1, meters / total) : 0; return { lat: from.lat + (to.lat - from.lat) * f, lon: from.lon + (to.lon - from.lon) * f }; };
const offset = (point, meters, angle) => ({ lat: point.lat + (meters * Math.cos(angle)) / 110540, lon: point.lon + (meters * Math.sin(angle)) / (111320 * Math.cos(point.lat * Math.PI / 180)) });

export function routineMapOf(definition) { return new RoutineMap({ mapId: definition.mapId, home: definition.nodes.H, homeRadiusM: definition.homeRadiusM, tzOffsetMin: definition.tzOffsetMin, nodes: definition.nodes, segments: definition.segments }); }

/**
 * Piecewise-linear walk: depart from H, follow the route at speedMps (+-5% per leg), rest at stops[node] seconds
 * (a number for the first visit or an array per visit), optional pacing at the last node (back-and-forth legs toward
 * branch nodes), then sample every intervalSec with uniform position noise. gaps drop samples after arrival at a
 * node: the data pipeline loses fixes while the walk continues.
 */
export function synthesizeWalk({ definition, date, depart, route, speedMps, stops = {}, pacing = null, homeBeforeSec = 300, homeAfterSec = 180, endLocal = null, intervalSec = 20, noiseM = 2, gaps = [], seed = 1 }) {
  const random = mulberry32(seed); const nodes = definition.nodes; const tz = definition.tzOffsetMin;
  const departMs = localToMs(date, depart, tz); const startMs = departMs - homeBeforeSec * 1000;
  const frames = [{ t: startMs, p: nodes.H }, { t: departMs, p: nodes.H }]; const arrivals = {};
  let t = departMs;
  for (let index = 1; index < route.length; index += 1) {
    const from = nodes[route[index - 1]]; const to = nodes[route[index]];
    if (!from || !to) throw new Error(`walk route node ${route[index - 1]} or ${route[index]} missing`);
    t += haversineM(from, to) / (speedMps * (0.95 + 0.1 * random())) * 1000; frames.push({ t, p: to });
    (arrivals[route[index]] ??= []).push(t);
    const visit = arrivals[route[index]].length - 1; const spec = stops[route[index]];
    const rest = Array.isArray(spec) ? spec[visit] ?? 0 : visit === 0 ? spec ?? 0 : 0;
    if (rest) { t += rest * 1000; frames.push({ t, p: to, still: true }); }
  }
  let endMs = endLocal ? localToMs(date, endLocal, tz) : t + homeAfterSec * 1000;
  if (pacing) {
    const center = nodes[pacing.node]; const until = localToMs(date, pacing.untilLocal, tz); let leg = 0;
    while (t < until) {
      const target = toward(center, nodes[pacing.toward[leg % pacing.toward.length]], pacing.legM * (0.8 + 0.4 * random()));
      t += haversineM(center, target) / pacing.speedMps * 1000; frames.push({ t, p: target });
      t += (pacing.pauseSec[0] + random() * (pacing.pauseSec[1] - pacing.pauseSec[0])) * 1000; frames.push({ t, p: target, still: true });
      t += haversineM(center, target) / pacing.speedMps * 1000; frames.push({ t, p: center });
      t += (pacing.pauseSec[0] + random() * (pacing.pauseSec[1] - pacing.pauseSec[0])) * 1000; frames.push({ t, p: center, still: true });
      leg += 1;
    }
    endMs = Math.max(endMs, until);
  }
  if (frames.at(-1).t < endMs) frames.push({ t: endMs, p: frames.at(-1).p, still: true });
  const dropped = gaps.map((gap) => { const at = (arrivals[gap.atNode]?.[gap.visit ?? 0] ?? departMs) + (gap.offsetSec ?? 0) * 1000; return [at, at + gap.durationSec * 1000]; });
  const positionAt = (ms) => {
    const index = frames.findIndex((frame) => frame.t >= ms); if (index <= 0) return frames[Math.max(0, index)].p;
    const a = frames[index - 1]; const b = frames[index]; const f = b.t === a.t ? 1 : (ms - a.t) / (b.t - a.t);
    return { lat: a.p.lat + (b.p.lat - a.p.lat) * f, lon: a.p.lon + (b.p.lon - a.p.lon) * f };
  };
  const track = []; const samples = [];
  for (let ms = startMs; ms <= endMs; ms += intervalSec * 1000) {
    const noisy = offset(positionAt(ms), noiseM * Math.sqrt(random()), random() * 2 * Math.PI);
    const point = { t: ms, lat: Number(noisy.lat.toFixed(6)), lon: Number(noisy.lon.toFixed(6)) };
    track.push(point);
    if (!dropped.some(([from, to]) => ms >= from && ms < to)) samples.push(point);
  }
  const returnMs = route.at(-1) === 'H' ? arrivals.H?.at(-1) ?? null : null;
  return { samples, track, arrivals, startMs, endMs, departMs, returnMs, gaps: dropped.map(([from, to]) => ({ fromMs: from, toMs: to })) };
}

/** Seven synthetic normal days (labelled synthetic) used to train the routine profile. */
export function trainingDays(definition) {
  return definition.training.map((spec) => {
    const walk = synthesizeWalk({ definition, date: spec.date, depart: spec.depart, route: definition.routes[spec.route], speedMps: spec.speedMps, stops: spec.stops, gaps: [{ atNode: definition.gapNode, offsetSec: 5, durationSec: spec.gapSec }], seed: spec.seed });
    return { dayId: spec.dayId, date: spec.date, synthetic: true, route: spec.route, samples: walk.samples, departMs: walk.departMs, returnMs: walk.returnMs };
  });
}

const deviceStates = (startMs, endMs, bleSeenBy, battery = 82) => {
  const states = [];
  for (let t = startMs, index = 0; t <= endMs; t += 300000, index += 1) states.push({ t, bleSeenBy, battery: battery - Math.floor(index / 3), button: 'idle' });
  return states;
};

/** Evaluation cases on the scenario date; expectAlert is the ground-truth label used for the totals. */
export function evaluationCases(definition, { date = '2026-11-20' } = {}) {
  const tz = definition.tzOffsetMin;
  return definition.cases.map((spec) => {
    const walk = synthesizeWalk({ definition, date, ...spec.walk, route: definition.routes[spec.walk.route] });
    const truth = spec.truth; const panicMs = truth.panicLocal ? localToMs(date, truth.panicLocal, tz) : null;
    const deviation = truth.deviation === 'depart' ? walk.departMs : truth.deviation?.atNode ? walk.arrivals[truth.deviation.atNode]?.[truth.deviation.visit ?? 0] + (truth.deviation.offsetSec ?? 0) * 1000 : null;
    return { caseId: spec.caseId, title: spec.title, date, expectAlert: truth.expectAlert, expectedKind: truth.kind ?? null, rationale: truth.rationale, walk, samples: walk.samples, track: walk.track,
      devices: deviceStates(walk.startMs - 600000, walk.endMs, spec.keyringAtHome ? 'home-gateway' : 'relay-ue'), events: panicMs ? [{ t: panicMs, type: 'PANIC' }] : [],
      panicMs, deviationStartMs: deviation, startMs: walk.startMs, endMs: walk.endMs };
  });
}

// ------------------------------------------------------------------ bubble development map
const BUBBLE_ROUTES = {
  usual: ['H', 'G', 'A', 'J1', 'Bp', 'C', 'T1', 'T2', 'D', 'E', 'A', 'G', 'H'],
  usualBench: ['H', 'G', 'A', 'J1', 'Bp', 'B', 'Bp', 'C', 'T1', 'T2', 'D', 'E', 'A', 'G', 'H'],
  extended: ['H', 'G', 'A', 'J1', 'Bp', 'C', 'X1', 'X2', 'T1', 'T2', 'D', 'E', 'A', 'G', 'H'],
  extendedBench: ['H', 'G', 'A', 'J1', 'Bp', 'B', 'Bp', 'C', 'X1', 'X2', 'T1', 'T2', 'D', 'E', 'A', 'G', 'H'],
  wrongBranch: ['H', 'G', 'A', 'J1', 'Bp', 'B', 'Bp', 'C', 'T1', 'T2', 'D', 'E', 'W1', 'W2'],
};
/**
 * Development walk map on the bubble sandbox Monaco geometry (zone1 home, zone2 park); not a real park layout.
 * Node roles: H home, G gate, A loop entry, J1/Bp lower trail, B bench spur, C pond, T1-T2 underpass, D/E upper trail,
 * X1/X2 extended south loop, W1/W2 unfamiliar north branch with W2 the hill fork (branches W3a/W3b).
 */
export const DEV_MAP_BUBBLE = Object.freeze({
  mapId: 'bubble-dev-park', sandbox: 'bubble', scenario: 'dep-opt-b', ue: '33753370913', tzOffsetMin: 60, homeRadiusM: 40, gapNode: 'T1',
  note: 'development walk map placed on the bubble sandbox Monaco geometry (zone1 home, zone2 park); not a real park layout',
  nodes: {
    H: { lat: 43.74905, lon: 7.43735 }, G: { lat: 43.7479, lon: 7.4345 }, A: { lat: 43.747, lon: 7.4328 }, J1: { lat: 43.7461, lon: 7.4319 },
    Bp: { lat: 43.7454, lon: 7.4312 }, B: { lat: 43.7455, lon: 7.4314 }, C: { lat: 43.7447, lon: 7.4301 }, T1: { lat: 43.7442, lon: 7.4293 },
    T2: { lat: 43.745, lon: 7.4286 }, D: { lat: 43.7459, lon: 7.429 }, E: { lat: 43.7466, lon: 7.4305 }, X1: { lat: 43.7438, lon: 7.4308 },
    X2: { lat: 43.7433, lon: 7.4299 }, W1: { lat: 43.7475, lon: 7.43 }, W2: { lat: 43.7482, lon: 7.4293 }, W3a: { lat: 43.7485, lon: 7.4288 }, W3b: { lat: 43.748, lon: 7.4287 },
  },
  segments: [
    { id: 's01', name: 'home street', kind: 'street', from: 'H', to: 'G' }, { id: 's02', name: 'park entrance', kind: 'path', from: 'G', to: 'A' },
    { id: 's03', name: 'lower trail', kind: 'path', from: 'A', to: 'J1' }, { id: 's04', name: 'lower trail', kind: 'path', from: 'J1', to: 'Bp' },
    { id: 's05', name: 'bench by the lawn', kind: 'bench', from: 'Bp', to: 'B' }, { id: 's06', name: 'pond path', kind: 'path', from: 'Bp', to: 'C' },
    { id: 's07', name: 'shaded path', kind: 'path', from: 'C', to: 'T1' }, { id: 's08', name: 'underpass', kind: 'tunnel', from: 'T1', to: 'T2' },
    { id: 's09', name: 'west trail', kind: 'path', from: 'T2', to: 'D' }, { id: 's10', name: 'upper trail', kind: 'path', from: 'D', to: 'E' },
    { id: 's11', name: 'loop return', kind: 'path', from: 'E', to: 'A' }, { id: 's12', name: 'south loop', kind: 'path', from: 'C', to: 'X1' },
    { id: 's13', name: 'south loop', kind: 'path', from: 'X1', to: 'X2' }, { id: 's14', name: 'south loop', kind: 'path', from: 'X2', to: 'T1' },
    { id: 's15', name: 'north branch', kind: 'path', from: 'E', to: 'W1' }, { id: 's16', name: 'north branch to the hill fork', kind: 'path', from: 'W1', to: 'W2' },
    { id: 's17', name: 'hill fork, left branch', kind: 'fork', from: 'W2', to: 'W3a' }, { id: 's18', name: 'hill fork, right branch', kind: 'fork', from: 'W2', to: 'W3b' },
  ],
  routes: BUBBLE_ROUTES,
  training: [
    { dayId: 'day-1', date: '2026-11-13', depart: '16:28:00', route: 'usualBench', speedMps: 0.88, stops: { B: 360, J1: 10 }, gapSec: 60, seed: 101 },
    { dayId: 'day-2', date: '2026-11-14', depart: '16:33:00', route: 'extended', speedMps: 0.82, stops: {}, gapSec: 80, seed: 102 },
    { dayId: 'day-3', date: '2026-11-15', depart: '16:30:00', route: 'usualBench', speedMps: 0.85, stops: { B: 660 }, gapSec: 50, seed: 103 },
    { dayId: 'day-4', date: '2026-11-16', depart: '16:26:00', route: 'usualBench', speedMps: 0.9, stops: { B: 480, J1: 15 }, gapSec: 90, seed: 104 },
    { dayId: 'day-5', date: '2026-11-17', depart: '16:27:00', route: 'extendedBench', speedMps: 0.8, stops: { B: 240 }, gapSec: 70, seed: 105 },
    { dayId: 'day-6', date: '2026-11-18', depart: '16:31:00', route: 'usual', speedMps: 0.86, stops: {}, gapSec: 40, seed: 106 },
    { dayId: 'day-7', date: '2026-11-19', depart: '16:29:00', route: 'usualBench', speedMps: 0.84, stops: { B: 720 }, gapSec: 100, seed: 107 },
  ],
  cases: [
    { caseId: 'C1-normal-walk', title: 'Normal walk on the usual loop with a short bench rest', walk: { depart: '16:30:00', route: 'usualBench', speedMps: 0.86, stops: { B: 180 }, gaps: [{ atNode: 'T1', offsetSec: 5, durationSec: 60 }], seed: 201 }, truth: { expectAlert: false, rationale: 'usual loop, usual times' } },
    { caseId: 'C2-longer-loop', title: 'Longer but normal loop (south loop) returning a few minutes later', walk: { depart: '16:31:00', route: 'extendedBench', speedMps: 0.82, stops: { B: 300 }, gaps: [{ atNode: 'T1', offsetSec: 5, durationSec: 70 }], seed: 202 }, truth: { expectAlert: false, rationale: 'south loop is part of the learned corridor' } },
    { caseId: 'C3-bench-rest', title: 'Usual rest on the bench for about 9.5 minutes', walk: { depart: '16:30:00', route: 'usualBench', speedMps: 0.86, stops: { B: 570 }, gaps: [{ atNode: 'T1', offsetSec: 5, durationSec: 60 }], seed: 203 }, truth: { expectAlert: false, rationale: 'bench dwell inside the learned bench distribution' } },
    { caseId: 'C4-fork-dusk', title: 'Off the usual loop at the upper trail, stop and back-and-forth at the hill fork at dusk, PANIC at 17:18',
      walk: { depart: '16:35:00', route: 'wrongBranch', speedMps: 0.8, stops: { B: 180 }, gaps: [{ atNode: 'T1', offsetSec: 5, durationSec: 60 }], seed: 204, endLocal: '17:24:00', pacing: { node: 'W2', toward: ['W3a', 'W3b'], legM: 18, speedMps: 0.4, pauseSec: [20, 45], untilLocal: '17:24:00' } },
      truth: { expectAlert: true, kind: 'WANDERING', deviation: { atNode: 'E', visit: 0 }, panicLocal: '17:18:00', rationale: 'off corridor, stop and pacing at an unfamiliar fork after sunset' } },
    { caseId: 'C5-tunnel-gap', title: 'Six-minute location gap from the underpass while she keeps walking', walk: { depart: '16:30:00', route: 'usual', speedMps: 0.85, gaps: [{ atNode: 'T1', offsetSec: 5, durationSec: 360 }], seed: 205 }, truth: { expectAlert: false, rationale: 'data gap only; the network still serves the UE along the route' } },
    { caseId: 'C6-keyring-home', title: 'Keyring left at home while the relay UE walks the usual loop', walk: { depart: '16:30:00', route: 'usual', speedMps: 0.86, gaps: [{ atNode: 'T1', offsetSec: 5, durationSec: 60 }], seed: 206 }, keyringAtHome: true,
      truth: { expectAlert: true, kind: 'DEVICE_SEPARATION', deviation: 'depart', rationale: 'PANIC button is not with the resident' } },
  ],
});

// ------------------------------------------------------------------ dayofcare scenario trail
/**
 * Walk definition built from the dayofcare sandbox description (pb.mec-sandbox.dayofcare.v1): home door, Boulevard
 * de Belgique, park east gate, trail fork (476 m) and south bench (586 m) come from residentTrail; the bench seat
 * offset, the east-branch end and the park-edge loop are synthetic additions inside the park polygon.
 * The trail is out-and-back: the resident passes the fork twice on a normal day.
 */
export function dayofcareDefinition(description, { farTrip = false } = {}) {
  const points = description?.residentTrail?.points;
  if (!Array.isArray(points) || points.length < 29) throw new Error('dayofcare residentTrail with 30 points required');
  const at = (index) => ({ lat: points[index].lat, lon: points[index].lon });
  const fork = at(21); const bench = at(29);
  const nodes = {
    H: at(0), P3: at(3), P6: at(6), P9: at(9), P13: at(13), G: at(15), P18: at(18), F: fork, P24: at(24), P26: at(26), B: bench,
    B2: { lat: bench.lat + 0.000052, lon: bench.lon - 0.000218 }, EB: { lat: fork.lat - 0.0002, lon: fork.lon + 0.00046 },
    L1: { lat: 43.73395, lon: 7.415 }, L2: { lat: 43.7336, lon: 7.4143 }, L3: { lat: 43.7329, lon: 7.4142 },
  };
  const out =['H', 'P3', 'P6', 'P9', 'P13', 'G', 'P18', 'F', 'P24', 'P26', 'B', 'B2'];
  const shortLoop = ['B', 'P26', 'P24', 'P26', 'B', 'B2'];
  const back = ['B', 'P26', 'P24', 'F', 'P18', 'G', 'P13', 'P9', 'P6', 'P3', 'H'];
  const parkOut = ['H', 'P3', 'P6', 'P9', 'P13', 'G', 'P18', 'F', 'L1', 'L2', 'L3', 'B', 'B2'];
  // Far trip to a cafe in Fontvieille along the dayofcare guardianPath (office to bench); the cafe sits at its second point.
  const gp = farTrip && Array.isArray(description.guardianPath) && description.guardianPath.length >= 8 ? description.guardianPath.map(([lon, lat]) => ({ lat, lon })) : null;
  if (farTrip && !gp) throw new Error('dayofcare guardianPath with 8 points required for the far trip');
  const farNodes = gp ? { O: gp[0], Q: gp[1], Y2: gp[2], Y3: gp[3], Y4: gp[4], Y5: gp[5], Y6: gp[6] } : {};
  Object.assign(nodes, farNodes);
  const toCafe = ['B2', 'B', 'Y6', 'Y5', 'Y4', 'Y3', 'Y2', 'Q']; const fromCafe = ['Q', 'Y2', 'Y3', 'Y4', 'Y5', 'Y6', 'B'];
  return {
    mapId: 'dayofcare-trail', sandbox: description.sandboxName ?? 'dayofcare', scenario: description.scenario ?? 'day-of-care', ue: description.ues?.find((ue) => ue.id === 'resident-relay')?.id ?? 'resident-relay',
    tzOffsetMin: 60, homeRadiusM: description.places?.home?.radiusM ?? 40, gapNode: 'P9', meps: (description.meps ?? []).map((mep) => mep.name),
    note: 'trail nodes from the dayofcare residentTrail; bench seat offset, east-branch end and park-edge loop are synthetic additions inside Parc Princesse Antoinette',
    nodes,
    segments: [
      { id: 'd01', name: 'home street', kind: 'street', from: 'H', to: 'P3' }, { id: 'd02', name: 'Boulevard de Belgique', kind: 'street', from: 'P3', to: 'P6' },
      { id: 'd03', name: 'Boulevard de Belgique', kind: 'street', from: 'P6', to: 'P9' }, { id: 'd04', name: 'shaded passage on the boulevard', kind: 'shaded', from: 'P9', to: 'P13' },
      { id: 'd05', name: 'Chemin des Revoires', kind: 'path', from: 'P13', to: 'G' }, { id: 'd06', name: 'park east path', kind: 'path', from: 'G', to: 'P18' },
      { id: 'd07', name: 'park east path', kind: 'path', from: 'P18', to: 'F' }, { id: 'd08', name: 'main footway', kind: 'path', from: 'F', to: 'P24' },
      { id: 'd09', name: 'main footway', kind: 'path', from: 'P24', to: 'P26' }, { id: 'd10', name: 'main footway to the bench', kind: 'path', from: 'P26', to: 'B' },
      { id: 'd11', name: 'south bench', kind: 'bench', from: 'B', to: 'B2' }, { id: 'd12', name: 'east branch at the trail fork', kind: 'fork', from: 'F', to: 'EB' },
      { id: 'd13', name: 'park edge loop', kind: 'path', from: 'F', to: 'L1' }, { id: 'd14', name: 'park edge loop', kind: 'path', from: 'L1', to: 'L2' },
      { id: 'd15', name: 'park edge loop', kind: 'path', from: 'L2', to: 'L3' }, { id: 'd16', name: 'park edge loop', kind: 'path', from: 'L3', to: 'B' },
      ...(gp ? [{ id: 'd17', name: 'path to Fontvieille', kind: 'path', from: 'B', to: 'Y6' }, { id: 'd18', name: 'path to Fontvieille', kind: 'path', from: 'Y6', to: 'Y5' },
        { id: 'd19', name: 'path to Fontvieille', kind: 'path', from: 'Y5', to: 'Y4' }, { id: 'd20', name: 'path to Fontvieille', kind: 'path', from: 'Y4', to: 'Y3' },
        { id: 'd21', name: 'street to the Fontvieille cafe', kind: 'street', from: 'Y3', to: 'Y2' }, { id: 'd22', name: 'Fontvieille cafe', kind: 'place', from: 'Y2', to: 'Q' },
        { id: 'd23', name: 'Fontvieille office street', kind: 'street', from: 'Q', to: 'O' }] : []),
    ],
    routes: {
      usual: [...out, ...shortLoop, ...back], direct: [...out, ...back], parkLoop: [...parkOut, ...shortLoop, ...back],
      storyDay: [...out, ...shortLoop, 'B', 'P26', 'P24', 'F'],
      ...(gp ? { cafeTrip: [...out, ...toCafe.slice(1), ...fromCafe.slice(1), ...back] } : {}),
    },
    training: [
      { dayId: 'day-1', date: '2026-11-13', depart: '16:28:00', route: 'usual', speedMps: 0.9, stops: { B2: [1080, 780] }, gapSec: 60, seed: 301 },
      { dayId: 'day-2', date: '2026-11-14', depart: '16:33:00', route: 'parkLoop', speedMps: 0.86, stops: { B2: [960, 840] }, gapSec: 80, seed: 302 },
      { dayId: 'day-3', date: '2026-11-15', depart: '16:30:00', route: 'usual', speedMps: 0.9, stops: { B2: [1200, 600] }, gapSec: 50, seed: 303 },
      { dayId: 'day-4', date: '2026-11-16', depart: '16:26:00', route: 'usual', speedMps: 0.95, stops: { B2: [900, 900] }, gapSec: 90, seed: 304 },
      { dayId: 'day-5', date: '2026-11-17', depart: '16:29:00', route: 'parkLoop', speedMps: 0.85, stops: { B2: [1020, 720] }, gapSec: 70, seed: 305 },
      { dayId: 'day-6', date: '2026-11-18', depart: '16:31:00', route: 'direct', speedMps: 0.9, stops: { B2: [1500] }, gapSec: 40, seed: 306 },
      { dayId: 'day-7', date: '2026-11-19', depart: '16:30:00', route: 'usual', speedMps: 0.88, stops: { B2: [1140, 840] }, gapSec: 100, seed: 307 },
    ],
    cases: [
      { caseId: 'C1-normal-walk', title: 'Normal walk: bench rest with a short loop, home about 17:25', walk: { depart: '16:30:00', route: 'usual', speedMps: 0.9, stops: { B2: [1020, 720] }, gaps: [{ atNode: 'P9', offsetSec: 5, durationSec: 60 }], seed: 401 }, truth: { expectAlert: false, rationale: 'usual trail, usual bench rest and times' } },
      { caseId: 'C2-longer-loop', title: 'Longer but normal walk: park edge loop on the way out, home about 17:35', walk: { depart: '16:31:00', route: 'parkLoop', speedMps: 0.86, stops: { B2: [1080, 900] }, gaps: [{ atNode: 'P9', offsetSec: 5, durationSec: 70 }], seed: 402 }, truth: { expectAlert: false, rationale: 'park edge loop is part of the learned corridor (two of seven days)' } },
      { caseId: 'C3-bench-rest', title: 'Usual bench rest: 22 minutes on the south bench without the short loop', walk: { depart: '16:30:00', route: 'direct', speedMps: 0.9, stops: { B2: [1320] }, gaps: [{ atNode: 'P9', offsetSec: 5, durationSec: 60 }], seed: 403 }, truth: { expectAlert: false, rationale: 'bench dwell inside the learned bench distribution' } },
      { caseId: 'C4-fork-dusk', title: 'Story day: on the way home she stops at the trail fork at 17:10 (dusk), back and forth between branches, PANIC at 17:18',
        walk: { depart: '16:30:00', route: 'storyDay', speedMps: 0.9, stops: { B2: [900, 420] }, gaps: [{ atNode: 'P9', offsetSec: 5, durationSec: 60 }], seed: 404, endLocal: '17:24:00', pacing: { node: 'F', toward: ['EB', 'P18', 'P24'], legM: 16, speedMps: 0.4, pauseSec: [20, 45], untilLocal: '17:24:00' } },
        truth: { expectAlert: true, kind: 'WANDERING', deviation: { atNode: 'F', visit: 1 }, panicLocal: '17:18:00', rationale: 'stop and back-and-forth at the fork after sunset; the fork is usually passed without a stop' } },
      { caseId: 'C5-tunnel-gap', title: 'Six-minute location gap from the shaded passage while she keeps walking into the park', walk: { depart: '16:30:00', route: 'usual', speedMps: 0.9, stops: { B2: [1020, 720] }, gaps: [{ atNode: 'P9', offsetSec: 5, durationSec: 360 }], seed: 405 }, truth: { expectAlert: false, rationale: 'data gap only; the network still serves the UE along the trail and records the cell change' } },
      { caseId: 'C6-keyring-home', title: 'Keyring left at home while the relay UE walks the usual trail', walk: { depart: '16:30:00', route: 'usual', speedMps: 0.9, stops: { B2: [1020, 720] }, gaps: [{ atNode: 'P9', offsetSec: 5, durationSec: 60 }], seed: 406 }, keyringAtHome: true,
        truth: { expectAlert: true, kind: 'DEVICE_SEPARATION', deviation: 'depart', rationale: 'PANIC button is not with the resident' } },
    ],
  };
}

/**
 * Fourteen synthetic evenings for the place-memory learning curve (dayofcare far-trip definition). Days 1-5 fill the
 * cold start; the Fontvieille cafe is first visited with the guardian phone seeing the keyring (BLE flag, simulated),
 * then alone; the fork wandering of the story day repeats three times. guardian: what the scripted guardian answers
 * to an alert on that evening.
 */
export const LEARNING_DAYS = Object.freeze([
  { day: 1, date: '2026-11-21', kind: 'normal', route: 'usual', depart: '16:28:00', speedMps: 0.9, stops: { B2: [1080, 780] }, seed: 501 },
  { day: 2, date: '2026-11-22', kind: 'normal', route: 'direct', depart: '16:31:00', speedMps: 0.9, stops: { B2: [1500] }, seed: 502 },
  { day: 3, date: '2026-11-23', kind: 'normal', route: 'parkLoop', depart: '16:30:00', speedMps: 0.86, stops: { B2: [960, 840] }, seed: 503 },
  { day: 4, date: '2026-11-24', kind: 'normal', route: 'usual', depart: '16:26:00', speedMps: 0.95, stops: { B2: [900, 900] }, seed: 504 },
  { day: 5, date: '2026-11-25', kind: 'normal', route: 'usual', depart: '16:29:00', speedMps: 0.88, stops: { B2: [1140, 840] }, seed: 505 },
  { day: 6, date: '2026-11-26', kind: 'cafe-with-guardian', route: 'cafeTrip', depart: '16:30:00', speedMps: 0.9, stops: { B2: [600], Q: 1200 }, accompanied: 'ble', seed: 506 },
  { day: 7, date: '2026-11-27', kind: 'cafe-first-solo', route: 'cafeTrip', depart: '16:30:00', speedMps: 0.9, stops: { B2: [600], Q: 1200 }, guardian: 'dismissOk', markPlace: 'Q', seed: 507 },
  { day: 8, date: '2026-11-28', kind: 'wandering', route: 'storyDay', depart: '16:30:00', speedMps: 0.9, stops: { B2: [900, 420] }, wandering: true, seed: 508 },
  { day: 9, date: '2026-11-29', kind: 'normal', route: 'usual', depart: '16:30:00', speedMps: 0.9, stops: { B2: [1020, 720] }, seed: 509 },
  { day: 10, date: '2026-11-30', kind: 'cafe-solo', route: 'cafeTrip', depart: '16:31:00', speedMps: 0.88, stops: { B2: [660], Q: 1140 }, seed: 510 },
  { day: 11, date: '2026-12-01', kind: 'wandering', route: 'storyDay', depart: '16:30:00', speedMps: 0.9, stops: { B2: [900, 420] }, wandering: true, seed: 511 },
  { day: 12, date: '2026-12-02', kind: 'wandering', route: 'storyDay', depart: '16:29:00', speedMps: 0.88, stops: { B2: [960, 360] }, wandering: true, seed: 512 },
  { day: 13, date: '2026-12-03', kind: 'normal', route: 'parkLoop', depart: '16:31:00', speedMps: 0.86, stops: { B2: [1080, 900] }, seed: 513 },
  { day: 14, date: '2026-12-04', kind: 'cafe-solo', route: 'cafeTrip', depart: '16:30:00', speedMps: 0.9, stops: { B2: [600], Q: 1260 }, seed: 514 },
]);

export function learningEvening(definition, spec) {
  const tz = definition.tzOffsetMin;
  const pacing = spec.wandering ? { node: 'F', toward: ['EB', 'P18', 'P24'], legM: 16, speedMps: 0.4, pauseSec: [20, 45], untilLocal: '17:24:00' } : null;
  const walk = synthesizeWalk({ definition, date: spec.date, depart: spec.depart, route: definition.routes[spec.route], speedMps: spec.speedMps, stops: spec.stops, pacing, endLocal: spec.wandering ? '17:24:00' : null, gaps: [{ atNode: 'P9', offsetSec: 5, durationSec: 60 }], seed: spec.seed });
  const panicMs = spec.wandering ? localToMs(spec.date, '17:18:00', tz) : null;
  return { ...spec, walk, samples: walk.samples, track: walk.track, panicMs, deviationStartMs: spec.wandering ? walk.arrivals.F?.[1] ?? null : null, expectAlert: Boolean(spec.wandering) };
}

/**
 * Guardian UE track: stationary at the office node O, walks the guardianPath to the bench to meet the resident when she
 * first reaches meetNode, then walks beside her (offsetM east) until the end of the evening.
 */
export function guardianCompanionTrack(definition, walk, { meetNode = 'B2', speedMps = 1.2, offsetM = 4, seed = 9 } = {}) {
  const nodes = definition.nodes; const random = mulberry32(seed);
  const meetMs = walk.arrivals[meetNode]?.[0]; if (!meetMs) throw new Error(`resident never reaches ${meetNode}`);
  const path = ['O', 'Q', 'Y2', 'Y3', 'Y4', 'Y5', 'Y6', 'B', 'B2'].map((name) => nodes[name]);
  const legs = path.slice(1).map((point, index) => haversineM(path[index], point)); const total = legs.reduce((a, b) => a + b, 0);
  const startMs = meetMs - total / speedMps * 1000;
  const along = (meters) => { let rest = meters; for (const [index, leg] of legs.entries()) { if (rest <= leg) { const f = leg ? rest / leg : 0; return { lat: path[index].lat + (path[index + 1].lat - path[index].lat) * f, lon: path[index].lon + (path[index + 1].lon - path[index].lon) * f }; } rest -= leg; } return path.at(-1); };
  return walk.track.map((point) => {
    if (point.t < startMs) return { t: point.t, lat: nodes.O.lat, lon: nodes.O.lon };
    if (point.t < meetMs) { const p = along((point.t - startMs) / 1000 * speedMps); return { t: point.t, lat: Number(p.lat.toFixed(6)), lon: Number(p.lon.toFixed(6)) }; }
    const p = offset(point, offsetM + random(), Math.PI / 2); return { t: point.t, lat: Number(p.lat.toFixed(6)), lon: Number(p.lon.toFixed(6)) };
  });
}

/** Coarse grid (3 decimals, about 110 m by 80 m at this latitude) used on oneM2M loc and in every agent-facing output. */
export const grid = (value) => Math.round(value * 1000) / 1000;
