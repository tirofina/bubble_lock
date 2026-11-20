import { RoutineDetector, trainRoutineProfile } from './routine-model.mjs';
import { CompanionTracker, PlaceMemory, learningDecision } from './place-memory.mjs';
import { LEARNING_DAYS, learningEvening } from './routine-scenarios.mjs';

/**
 * Offline evening replay on the 20 s grid: the detector sees the delivered samples, the companion tracker the companion
 * evidence (guardian positions with zones, or the simulated BLE flag). Returns alerts, the companion status and the
 * judgement against the labelled evening.
 */
export function replayEvening({ map, evening, detector, companionTrack = null, ble = false, zoneOf = () => 'zone' }) {
  const tracker = new CompanionTracker(); const byTime = new Map(evening.samples.map((sample) => [sample.t, sample]));
  const guardianByTime = companionTrack ? new Map(companionTrack.map((point) => [point.t, point])) : null; const alerts = [];
  for (let t = evening.walk.startMs; t <= evening.walk.endMs; t += 20000) {
    const sample = byTime.get(t);
    if (sample) {
      detector.observe(sample);
      if (ble || guardianByTime) {
        const companion = guardianByTime?.get(t); const status = tracker.observe({ t, resident: { ...sample, zoneId: zoneOf(sample) }, companion: companion ? { ...companion, zoneId: zoneOf(companion) } : null, bleSeenByGuardianPhone: ble && map.distanceHomeM(sample) > map.homeRadiusM });
        detector.observeCompanion(status);
      }
    }
    for (const alert of detector.evaluate(t).alerts) alerts.push({ kind: alert.kind, trigger: alert.features.trigger ?? null, score: alert.score, detectedMs: t, detectedLocal: map.localTime(t, true), place: alert.features.place ?? null });
  }
  return judge(map, evening, alerts, tracker.status());
}

export function judge(map, evening, alerts, companion) {
  const relevant = evening.expectAlert ? alerts.filter((alert) => alert.detectedMs >= evening.deviationStartMs && (!evening.panicMs || alert.detectedMs < evening.panicMs)) : [];
  const first = relevant[0] ?? null;
  return { alerts, companion, falseAlarms: alerts.length - (evening.expectAlert ? alerts.filter((alert) => alert.detectedMs >= evening.deviationStartMs).length : 0), detected: evening.expectAlert ? Boolean(first) : null,
    firstAlertLocal: first ? map.localTime(first.detectedMs, true) : null, leadTimeSec: first && evening.panicMs ? Math.round((evening.panicMs - first.detectedMs) / 1000) : null };
}

/** Scripted guardian: dismisses an alert as OK on evenings labelled dismissOk and marks the named place fine. */
export function guardianFeedback(spec, result, definition) {
  if (!result.alerts.length || spec.guardian !== 'dismissOk') return { dismissedOk: false, markPlace: null };
  return { dismissedOk: true, markPlace: spec.markPlace ? { node: spec.markPlace, point: definition.nodes[spec.markPlace], label: 'Fontvieille cafe' } : null };
}

/**
 * Learning curve over the LEARNING_DAYS schedule. Variants: learning (place memory, learning gate, guardian feedback),
 * frozen (place memory after the first five days, no further updates), noGate (every trip learned into the solo store)
 * and segmentV1 (the segment profile of the six-case triage, trained on the first five days).
 */
export async function learningCurve({ definition, map, variant = 'learning', days = LEARNING_DAYS, memory = null, labeler = null, afterDay = null }) {
  memory ??= new PlaceMemory({ home: map.home, tzOffsetMin: map.tzOffsetMin, labeler });
  const evenings = days.map((spec) => learningEvening(definition, spec));
  const v1 = variant === 'segmentV1' ? trainRoutineProfile({ map, days: evenings.slice(0, 5).map((evening) => ({ dayId: `day-${evening.day}`, synthetic: true, samples: evening.samples })) }) : null;
  const results = [];
  for (const evening of evenings) {
    const coldStartAtStart = !v1 && memory.coldStart;
    const detector = v1 ? new RoutineDetector({ map, profile: v1 }) : new RoutineDetector({ map, memory });
    const result = replayEvening({ map, evening, detector, ble: evening.accompanied === 'ble' });
    const feedback = guardianFeedback(evening, result, definition);
    const accompanied = result.companion.accompanied;
    let decision = learningDecision({ accompanied, guardianAlerts: result.alerts.length, guardianDismissedOk: feedback.dismissedOk, panic: Boolean(evening.panicMs) });
    if (variant === 'noGate') decision = { learn: true, mode: 'solo', reason: 'no learning gate: every trip learned as solo-normal' };
    if (variant === 'frozen' && evening.day > 5) decision = { learn: false, mode: null, reason: 'memory frozen after day 5' };
    if (v1) decision = { learn: false, mode: null, reason: 'segment profile v1 is static' };
    if (!v1 && feedback.markPlace && decision.learn) memory.markPlaceOk({ point: feedback.markPlace.point, atMs: evening.walk.endMs, label: feedback.markPlace.label });
    if (!v1 && decision.learn) memory.learnTrip({ samples: evening.samples, endedMs: evening.walk.endMs, mode: decision.mode });
    const row = { day: evening.day, date: evening.date, kind: evening.kind, expectAlert: evening.expectAlert, accompanied, companionReason: result.companion.reason, alerts: result.alerts.map(({ kind, trigger, detectedLocal, place }) => ({ kind, trigger, detectedLocal, place: place?.label ?? null })),
      falseAlarms: result.falseAlarms, detected: result.detected, firstAlertLocal: result.firstAlertLocal, leadTimeSec: result.leadTimeSec, guardianDismissedOk: feedback.dismissedOk, learned: decision, coldStartAtStart };
    results.push(row); memory = (await afterDay?.(row, memory, evening)) ?? memory;
  }
  return { variant, days: results, memory };
}

export function summarizeCurve(curve) {
  const wandering = curve.days.filter((day) => day.expectAlert);
  return { variant: curve.variant, falseAlarms: curve.days.reduce((sum, day) => sum + day.falseAlarms, 0), falseAlarmsByDay: curve.days.map((day) => day.falseAlarms),
    falseAlarmsDays1to7: curve.days.filter((day) => day.day <= 7).reduce((sum, day) => sum + day.falseAlarms, 0), falseAlarmsDays8to14: curve.days.filter((day) => day.day >= 8).reduce((sum, day) => sum + day.falseAlarms, 0),
    wanderingDetected: wandering.filter((day) => day.detected).length, wanderingEvenings: wandering.length, leadTimeSec: Object.fromEntries(wandering.map((day) => [`day-${day.day}`, day.leadTimeSec])) };
}
