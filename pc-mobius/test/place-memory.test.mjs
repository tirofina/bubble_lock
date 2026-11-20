import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { MecCipher } from '../integration/src/mec-state.mjs';
import { CompanionTracker, PlaceMemory, learningDecision, openPlaceMemory, sealPlaceMemory } from '../integration/src/place-memory.mjs';
import { learningCurve, summarizeCurve } from '../integration/src/routine-learning.mjs';
import { LEARNING_DAYS, dayofcareDefinition, learningEvening, routineMapOf } from '../integration/src/routine-scenarios.mjs';

const description = JSON.parse(readFileSync(new URL('./fixtures/dayofcare-trail.json', import.meta.url), 'utf8'));
const definition = dayofcareDefinition(description, { farTrip: true });
const map = routineMapOf(definition);
const labeler = (point) => { const match = map.match(point); return match.distanceM <= 35 ? match.name : 'unmapped stop'; };
const DAY = 86400000;

test('place memory clusters stops into places, forgets with a half-life and leaves the cold start after five solo days', () => {
  const memory = new PlaceMemory({ home: map.home, tzOffsetMin: 60, labeler });
  assert.equal(memory.coldStart, true);
  const evenings = LEARNING_DAYS.slice(0, 5).map((spec) => learningEvening(definition, spec));
  for (const evening of evenings) memory.learnTrip({ samples: evening.samples, endedMs: evening.walk.endMs, mode: 'solo' });
  assert.equal(memory.coldStart, false);
  const bench = memory.state.solo.places.find((place) => place.label === 'south bench');
  assert.ok(bench && bench.visits >= 5, 'the bench is one place visited every evening');
  const at = evenings.at(-1).walk.endMs;
  const benchScore = memory.score(definition.nodes.B2, at);
  assert.equal(benchScore.label, 'familiar south bench'); assert.ok(benchScore.dwellRefSec >= 900);
  assert.equal(memory.score(definition.nodes.Q, at).label, 'unfamiliar area');
  const later = memory.score(definition.nodes.B2, at + 4 * 21 * DAY);
  assert.ok(later.familiarity < benchScore.familiarity, 'familiarity decays without visits');
  assert.ok(memory.state.solo.transitions['home>place-1'] > 4 && memory.state.solo.transitions['home>place-1'] < 5, 'five evenings home to bench, slightly forgotten');
  const describe = JSON.stringify(memory.describe(at));
  assert.equal(/\b(43|7)\.\d{4,}/.test(describe), false, 'the agent summary carries no coordinates');
});

test('learning gate: accompanied trips stay separate, alerts learn only after a guardian OK, PANIC never', () => {
  assert.deepEqual(learningDecision({ accompanied: true, guardianAlerts: 0 }).mode, 'accompanied');
  assert.equal(learningDecision({ accompanied: false, guardianAlerts: 0 }).mode, 'solo');
  assert.equal(learningDecision({ accompanied: false, guardianAlerts: 1 }).learn, false);
  assert.equal(learningDecision({ accompanied: false, guardianAlerts: 1, guardianDismissedOk: true }).mode, 'solo');
  assert.equal(learningDecision({ accompanied: false, guardianAlerts: 1, guardianDismissedOk: true, panic: true }).learn, false);
  const memory = new PlaceMemory({ home: map.home, tzOffsetMin: 60, labeler });
  const cafe = learningEvening(definition, LEARNING_DAYS.find((spec) => spec.kind === 'cafe-with-guardian'));
  memory.learnTrip({ samples: cafe.samples, endedMs: cafe.walk.endMs, mode: 'accompanied' });
  assert.equal(memory.score(definition.nodes.Q, cafe.walk.endMs).label, 'unfamiliar area', 'an accompanied visit does not make the cafe normal for solo walks');
  memory.markPlaceOk({ point: definition.nodes.Q, atMs: cafe.walk.endMs, label: 'Fontvieille cafe' });
  assert.equal(memory.score(definition.nodes.Q, cafe.walk.endMs).label, 'familiar Fontvieille cafe');
});

test('companion check: MEC co-location for three reports or a simulated BLE sighting marks the trip accompanied', () => {
  const tracker = new CompanionTracker(); const base = { lat: 43.7332, lon: 7.4150 };
  for (let i = 0; i < 3; i += 1) tracker.observe({ t: i * 20000, resident: { lat: base.lat + i * 0.00015, lon: base.lon, zoneId: 'park-district' }, companion: { lat: base.lat + i * 0.00015, lon: base.lon + 0.00005, zoneId: 'park-district' } });
  assert.equal(tracker.status().accompanied, true); assert.match(tracker.status().reason, /MEC013 co-location/);
  const apart = new CompanionTracker();
  for (let i = 0; i < 5; i += 1) apart.observe({ t: i * 20000, resident: { lat: base.lat + i * 0.00015, lon: base.lon, zoneId: 'park-district' }, companion: { lat: 43.7308, lon: 7.4180, zoneId: 'office-district' } });
  assert.equal(apart.status().accompanied, false);
  const ble = new CompanionTracker(); ble.observe({ t: 0, resident: base, bleSeenByGuardianPhone: true });
  assert.match(ble.status().reason, /simulated/);
});

test('sealed place memory: AES-256-GCM at rest, hash-checked on open, tamper refused', async () => {
  const cipher = new MecCipher({ store: { path: null }, encryptionKey: randomBytes(32).toString('base64') });
  const memory = new PlaceMemory({ home: map.home, tzOffsetMin: 60, labeler });
  const evening = learningEvening(definition, LEARNING_DAYS[0]); memory.learnTrip({ samples: evening.samples, endedMs: evening.walk.endMs, mode: 'solo' });
  const record = await sealPlaceMemory(memory, cipher, 'resident-r1');
  assert.equal(record.sealed.algorithm, 'AES-256-GCM'); assert.equal(/\b(43|7)\.\d{4,}/.test(JSON.stringify(record)), false);
  const reopened = await openPlaceMemory(record, cipher, { home: map.home, tzOffsetMin: 60 });
  assert.equal(reopened.stateHash(), memory.stateHash());
  await assert.rejects(openPlaceMemory({ ...record, residentId: 'resident-other' }, cipher, { home: map.home, tzOffsetMin: 60 }));
});

test('learning curve: false alarms drop with guardian-confirmed learning, repeated wandering stays an alert, no gate hides it', async () => {
  const curves = {};
  for (const variant of ['learning', 'frozen', 'noGate']) curves[variant] = summarizeCurve(await learningCurve({ definition, map, variant, labeler }));
  assert.ok(curves.learning.falseAlarmsDays8to14 < curves.frozen.falseAlarmsDays8to14);
  assert.equal(curves.learning.wanderingDetected, curves.learning.wanderingEvenings);
  assert.ok(Object.values(curves.learning.leadTimeSec).every((value) => value > 0));
  assert.ok(curves.noGate.wanderingDetected < curves.learning.wanderingDetected, 'learning every trip turns repeated wandering into routine');
});
