import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createReceiptAdapter, initialTimelineState, reduceTimeline, stageDurationMs,
  summarizeCommand, timelineReducer,
} from '../shared/index.ts';
import { loadReplay } from '../server/replay.ts';

test('calculates stage durations when explicit acceptance and member ACKs exist', async () => {
  // Given
  const replay = await loadReplay();
  // When
  const state = reduceTimeline(replay.events);
  // Then
  const command = state.commands['grp-demo'];
  assert.ok(command);
  assert.deepEqual(summarizeCommand(command), {
    status: 'verified', memberCount: 2, ackCount: 2, verifiedCount: 2,
    retryPendingCount: 0, acceptedToSentMs: 5000,
    sentToAppliedMs: 10000, appliedToVerifiedMs: 3000,
  });
  assert.equal(command.members['keyringA']?.commandId, 'grp-demo:keyringA');
  assert.equal(command.members['keyringA']?.readback, true);
  assert.equal(command.members['keyringA']?.accepted.status, 'pending');
});

test('keeps stages pending when only a readback verification receipt exists', async () => {
  // Given
  const receipt = (await loadReplay()).events.find((event) => event.receipt?.ackState === 'READBACK_VERIFIED')?.receipt;
  assert.ok(receipt);
  // When
  const state = reduceTimeline([createReceiptAdapter().adaptReceipt(receipt)]);
  // Then
  const command = state.commands['grp-demo'];
  assert.ok(command);
  assert.equal(command.accepted.status, 'pending');
  assert.equal(command.sent.status, 'pending');
  assert.equal(command.applied.status, 'pending');
  assert.equal(command.verified.status, 'complete');
  assert.equal(summarizeCommand(command).appliedToVerifiedMs, null);
});

test('never invents acceptance when dispatch is the only command evidence', async () => {
  // Given
  const dispatch = (await loadReplay()).events.find((event) => event.type === 'command.dispatched');
  assert.ok(dispatch);
  // When
  const state = timelineReducer(initialTimelineState, dispatch);
  // Then
  assert.equal(state.commands['grp-demo']?.accepted.status, 'pending');
  assert.equal(state.commands['grp-demo']?.sent.status, 'complete');
  assert.equal(state.commands['grp-demo']?.applied.status, 'pending');
});

test('reports member partial failure when one member awaits retry', async () => {
  // Given
  const replay = await loadReplay();
  // When
  const state = reduceTimeline(replay.events);
  // Then
  const command = state.commands['grp-partial'];
  assert.ok(command);
  const summary = summarizeCommand(command);
  assert.equal(summary.status, 'partial');
  assert.equal(summary.verifiedCount, 1);
  assert.equal(summary.retryPendingCount, 1);
  assert.equal(command.members['keyringA']?.readbackVerified, true);
  assert.equal(command.members['keyringB']?.ack, true);
  assert.equal(command.members['keyringB']?.readback, false);
  assert.equal(command.members['keyringB']?.readbackVerified, false);
  assert.equal(command.members['keyringB']?.applied.status, 'pending');
  assert.equal(command.applied.status, 'pending');
  assert.equal(command.verified.status, 'pending');
});

test('reports failure when the only observed member explicitly requests retry', async () => {
  // Given
  const retry = (await loadReplay()).events.find((event) => event.receipt?.ackState === 'RETRY_PENDING');
  assert.ok(retry);
  // When
  const command = reduceTimeline([retry]).commands['grp-partial'];
  // Then
  assert.ok(command);
  assert.equal(summarizeCommand(command).status, 'failure');
  assert.equal(command.verified.status, 'pending');
});

test('does not manufacture stage timestamps when only a settled group summary exists', async () => {
  // Given
  const summary = (await loadReplay()).events.find((event) => event.receipt?.status === 'SETTLED');
  assert.ok(summary);
  // When
  const command = reduceTimeline([summary]).commands['grp-demo'];
  // Then
  assert.ok(command);
  assert.equal(Object.keys(command.members).length, 2);
  assert.equal(command.members['keyringA']?.ack, true);
  assert.equal(command.sent.status, 'pending');
  assert.equal(command.applied.status, 'pending');
  assert.equal(command.verified.status, 'pending');
});

test('ignores duplicate and out-of-order stream events without regressing state', async () => {
  // Given
  const replay = await loadReplay();
  const state = reduceTimeline(replay.events);
  const first = replay.events[0];
  const last = replay.events.at(-1);
  assert.ok(first);
  assert.ok(last);
  // When
  const updated = [last, first].reduce(timelineReducer, state);
  // Then
  assert.equal(updated.commands, state.commands);
  assert.equal(updated.lastSequence, 18);
  assert.equal(updated.ignoredEvents, 2);
});

test('keeps negative or absent time differences unknown', () => {
  // Given
  const earlier = { status: 'complete', at: '2026-10-29T00:00:00.000Z', source: 'test' } as const;
  const later = { status: 'complete', at: '2026-10-29T00:00:01.000Z', source: 'test' } as const;
  // When / Then
  assert.equal(stageDurationMs(later, earlier), null);
  assert.equal(stageDurationMs({ status: 'pending' }, later), null);
});
