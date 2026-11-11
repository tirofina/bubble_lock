import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
// @ts-expect-error The adjacent Node module is exercised directly across the branch boundary.
import { createIntegrationRuntime } from '../../pc-mobius/integration/src/integration-runtime.mjs';
// @ts-expect-error FL's adjacent Node client exercises signed numerical updates.
import { enrollLocalClient, buildLocalUpdate } from '../../pc-mobius/integration/src/fl-client.mjs';
// @ts-expect-error MCP simulation fixtures use the same schema and approval lifecycle as the wire runtime.
import { registerMcpSimulation } from '../../pc-mobius/integration/src/mcp-domain-tools.mjs';
// @ts-expect-error CORE emits the production receipt objects used by the dashboard.
import { GatewayBridge } from '../../pc-mobius/src/gateway-bridge.mjs';
import { startReplayServer } from '../server/sse.ts';
import { loadReplay } from '../server/replay.ts';
import { createReceiptAdapter, parseJournalJsonl } from '../shared/receipt-adapter.ts';
import { parseDashboardEvent, parseJournalReceipt } from '../shared/validation.ts';
import { integrationAudit, integrationServices } from '../shared/integration.ts';
import { reduceTimeline } from '../shared/timeline.ts';

test('replays actual merged INTEGRATION policy MEC handover FL and MCP journals', { timeout: 10000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'bubble-web-integration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const receiptPath = join(directory, 'journal.jsonl');
  const runtime = await createIntegrationRuntime({ receiptPath });
  t.after(() => runtime.close());
  const principal = runtime.policyService.bindPrincipal({
    oidcToken: { sub: 'web-test', scope: 'consent:write grant:write policy:approve mcp:run' },
    mtlsPeer: { verified: true, fingerprint: 'test-fingerprint' },
  });
  const consent = await runtime.policyService.createConsent({ principal, subjectId: 'household-web-test', purpose: 'compatibility', scopes: ['bubble:read'] });
  const grant = await runtime.policyService.createGrant({ principal, consentId: consent.consentId, scopes: ['bubble:read'] });
  await runtime.mecIngress.ingest({ eventId: 'web-mec-event', service: 'Location', eventType: 'UE_LOCATION_UPDATE', ueId: 'keyring-web' });
  runtime.handoverCoordinator.registerEdge({ edgeId: 'web-edge' });
  await runtime.handoverCoordinator.handover({ ueId: 'keyring-web', targetEdgeId: 'web-edge', grantId: grant.grantId });
  const clients = [await enrollLocalClient(runtime.flCoordinator, { participantId: 'web-vm-a', taskId: 'web-task', seed: 101, clientIndex: 0 }), await enrollLocalClient(runtime.flCoordinator, { participantId: 'web-vm-b', taskId: 'web-task', seed: 202, clientIndex: 1 })];
  const round = await runtime.flCoordinator.createRound({ taskId: 'web-task', requiredLabels: ['privacy'] });
  for (const client of clients) await runtime.flCoordinator.submitUpdate(buildLocalUpdate(runtime.flCoordinator, client, round));
  await runtime.flCoordinator.finalizeRound(round.roundId);
  registerMcpSimulation(runtime.mcpOrchestrator);
  const run = await runtime.mcpOrchestrator.startRun({ principal, grantId: grant.grantId, toolCalls: [{ serverId: 'oneM2M', tool: 'discoverDevices' }], idempotencyKey: 'web-run' });
  await runtime.mcpOrchestrator.approveRun({ principal, runId: run.runId, approvalHash: run.approvalHash });
  await runtime.mcpOrchestrator.execute(run.runId);

  const replay = await loadReplay(receiptPath);
  const raw = parseJournalJsonl(await readFile(receiptPath, 'utf8'));
  assert.equal(replay.source, 'integration-journal-replay');
  assert.equal(replay.events.length, runtime.store.list('receipts').length);
  assert.deepEqual(replay.events.map((event) => event.receipt), raw);
  for (const event of replay.events) {
    parseDashboardEvent(event);
    assert.equal(event.type, 'integration.receipt');
    const { receiptHash, journaledAt: _time, ...record } = event.receipt!;
    assert.equal(receiptHash, createHash('sha256').update(JSON.stringify(record)).digest('hex'));
  }
  assert.deepEqual(reduceTimeline(replay.events).commands, {});
  assert.equal(reduceTimeline(replay.events).lastSequence, replay.events.length);
  const services = integrationServices(replay.events);
  assert.equal(services.every((service) => service.receipt !== undefined), true);
  assert.equal(services[1]?.receipt?.state, 'ACTIVE');
  assert.equal(services[2]?.receipt?.state, 'COMPLETED');
  assert.equal(services[3]?.receipt?.action, 'RUN_COMPLETED');
  assert.equal(integrationAudit(replay.events).length, replay.events.length);

  const server = await startReplayServer({ receiptFile: receiptPath, port: 0 });
  t.after(server.close);
  const auditResponse = await fetch(`${server.url}/api/audit?q=GRANT_ISSUED`);
  const audit = await auditResponse.json() as { source: string; records: { action: string }[] };
  assert.equal(audit.source, 'integration-journal-replay');
  assert.deepEqual(audit.records.map((record) => record.action), ['GRANT_ISSUED']);
  const controller = new AbortController();
  const response = await fetch(`${server.url}/events?lastSequence=${replay.lastSequence - 1}`, { signal: controller.signal });
  const reader = response.body!.getReader();
  const chunk = await reader.read();
  const data = new TextDecoder().decode(chunk.value);
  assert.match(data, new RegExp(`id: ${replay.lastSequence}\\n`));
  assert.match(data, /integration.receipt/);
  controller.abort();
});

test('mixed journals preserve CORE commands and validate INTEGRATION envelope fields', () => {
  const record = { contractId: 'privacy-bubble.integration.v1', docRevision: '2.0.0', eventId: 'gateway-enrolled', timestamp: '2026-11-10T00:00:00.000Z', type: 'GATEWAY_ENROLLED', gatewayId: 'gw-1' };
  const core = { status: 'REVIEW', timestamp: record.timestamp, error: 'retry' };
  const receipts = parseJournalJsonl(`${JSON.stringify(core)}\n${JSON.stringify(record)}\n`);
  const adapter = createReceiptAdapter({ source: 'integration-journal-replay' });
  const events = receipts.map(adapter.adaptReceipt);
  assert.deepEqual(events.map((event) => event.type), ['receipt.review', 'integration.receipt']);
  assert.deepEqual(events.map((event) => event.sequence), [1, 2]);
  assert.throws(() => parseJournalReceipt({ ...record, timestamp: 'invalid' }));
  assert.throws(() => parseJournalReceipt({ ...record, eventId: '' }));
  assert.throws(() => parseJournalReceipt({ ...record, type: undefined }));
  assert.throws(() => parseJournalReceipt({ ...record, receiptHash: 'invalid' }));
});

test('renders canonical keyring commands telemetry extensions and nested readback receipts', async () => {
  const timestamp = '2026-11-10T00:00:00.000Z';
  const bridge = new GatewayBridge({ gatewayId: 'gw-web', mqttClient: { publishAsync: async () => undefined }, clock: () => timestamp });
  const command = { version: 1, gatewayId: 'gw-web', deviceId: 'kr-web', commandId: 'cmd-web', claimId: 'claim-web', desiredState: { state: false }, issuedAt: timestamp, deadline: '2026-11-10T00:01:00.000Z', grantRevision: 2, ownershipEpoch: 3 };
  const dispatched = await bridge.sendCommand(command);
  const native = { version: 1, gatewayId: command.gatewayId, deviceId: command.deviceId, commandId: command.commandId, payloadHash: 'a'.repeat(64), status: 'APPLIED', ackCode: 'APPLIED', acceptedAt: timestamp, appliedAt: timestamp, receivedAt: timestamp, readback: { state: false }, firmwareRevision: 'keyring-0.7.0', ownershipEpoch: 3, grantRevision: 2, timestampSource: 'gateway-estimated', detail: null, bootId: 'boot-web' };
  const ack = { deviceId: command.deviceId, commandId: command.commandId, ackState: 'READBACK_VERIFIED', timestamp, readback: native.readback, payloadHash: native.payloadHash, grantRevision: 2, ownershipEpoch: 3, measurementScope: 'gpio-at-application', gatewayReceipt: native };
  const acknowledged = await bridge.handleAck(ack);
  assert.equal(acknowledged.status, 'ACK_RECORDED');
  const adapter = createReceiptAdapter();
  const events = [dispatched, acknowledged].map(adapter.adaptReceipt);
  const timeline = reduceTimeline(events);
  assert.equal(timeline.commands['cmd-web']?.members['cmd-web']?.readback, false);
  assert.equal(timeline.commands['cmd-web']?.applied.status, 'complete');
  assert.equal(timeline.commands['cmd-web']?.verified.status, 'complete');
  assert.throws(() => adapter.adaptReceipt({ ...acknowledged, payload: { ...ack, gatewayReceipt: { ...native, commandId: 'another-command' } } }));
  const reviewed = await bridge.handleAck({ ...ack, commandId: 'unknown', gatewayReceipt: { ...native, commandId: 'unknown' } });
  assert.equal(adapter.adaptReceipt(reviewed).type, 'receipt.review');

  const telemetry = { deviceId: 'kr-web', sequence: 1, timestamp, state: false, batteryPct: 50, rssiDbm: 5, schemaVersion: '1.0.0', gatewayId: 'gw-web', bootId: 'boot-web', firmwareSequence: 4, timestampSource: 'gateway-received' };
  const receipt = { contractId: 'privacy-bubble.raspberrypi-gateway', contractVersion: '1.0.0', docRevision: '2.0.0', gatewayId: 'gw-web', deviceId: 'kr-web', status: 'APPLIED', timestamp, sequence: 1, dedupKey: 'kr-web:1', requestId: 'web-telemetry', oneM2MResource: '/Mobius/bubbleState', payload: telemetry };
  assert.deepEqual(adapter.adaptReceipt(receipt).receipt, receipt);
});
