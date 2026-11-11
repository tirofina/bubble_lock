import { readFile } from 'node:fs/promises';
import { PostgresIntegrationStore } from '../integration/src/postgres-integration-store.mjs';
import { PolicyService } from '../integration/src/policy-service.mjs';
import { GatewayControl } from '../integration/src/gateway-control.mjs';
import { FlCoordinator } from '../integration/src/fl-coordinator.mjs';
import { HandoverCoordinator } from '../integration/src/handover-coordinator.mjs';

const [configPath, namespace, action, fixturePath] = process.argv.slice(2);
const config = JSON.parse(await readFile(configPath, 'utf8'));
const connectionString = `postgresql://${encodeURIComponent(config.user)}:${encodeURIComponent(config.password)}@${config.host}:${config.port}/${config.policyDatabase}`;
const store = await new PostgresIntegrationStore({ connectionString, namespace, autoDrainJournal: false }).init();
const clock = () => store.now(); const policy = new PolicyService({ store, clock });
const gateway = new GatewayControl({ store, policyService: policy, handoverCoordinator: new HandoverCoordinator({ store, policyService: policy, clock }), clock });
const fixture = fixturePath ? JSON.parse(await readFile(fixturePath, 'utf8')) : {};
const waitRelease = () => new Promise((resolve) => process.once('message', resolve));
let result;
try {
  if (action === 'claim') result = await gateway.issue(fixture.input);
  else if (action === 'authorize') { process.send?.({ type: 'READY' }); result = await gateway.authorize(fixture.gatewayId, fixture.peer, fixture.binding); }
  else if (action === 'dispatch-start') result = await gateway.dispatchStart(fixture.gatewayId, fixture.peer, fixture.binding);
  else if (action === 'receipt') result = await gateway.receiveReceipt(fixture.gatewayId, fixture.peer, fixture.receipt);
  else if (action === 'clock-read') { process.send?.({ type: 'READY' }); result = await store.transaction('clock-read', async () => ({ now: clock() })); }
  else if (action === 'held-authority') result = await store.transaction('clock-holder', async () => { process.send?.({ type: 'LOCKED' }); await waitRelease(); return { released: true }; });
  else if (action === 'held-revoke') result = await store.transaction('grant-revoke-test', async () => {
    const revoked = await policy.revokeGrant({ principal: fixture.principal, grantId: fixture.grantId });
    process.send?.({ type: 'LOCKED' }); await waitRelease(); return revoked;
  });
  else if (action === 'crash-before-commit') result = await store.transaction('crash-test', async () => {
    await store.put('crashMarkers', 'pending', { state: 'uncommitted' });
    await store.append('receipts', { eventId: 'crash-uncommitted', type: 'CRASH_PROBE', timestamp: clock() });
    process.send?.({ type: 'LOCKED' }); await waitRelease(); return { completed: true };
  });
  else if (action === 'consent-revoke') {
    const fl = new FlCoordinator({ store, clock }); const participant = store.get('flParticipants', `${fixture.taskId}:${fixture.participantId}`);
    result = await fl.setParticipantConsent({ taskId: fixture.taskId, participantId: fixture.participantId, principal: { principalId: participant.principalId, originator: participant.originator }, status: 'REVOKED' });
  } else if (action === 'fl-finalize') {
    const fl = new FlCoordinator({ store, clock }); await fl.recover(fixture.roundId); result = await fl.finalizeRound(fixture.roundId);
  } else if (action === 'read') result = store.snapshot();
  else throw new Error('WORKER_ACTION');
  process.send?.({ type: 'RESULT', result });
} catch (error) { process.send?.({ type: 'RESULT', error: error.code ?? error.message }); }
finally { await store.close(); process.disconnect?.(); }
