import { ReceiptJournal } from '../../src/receipt-journal.mjs';
import { GatewayBridge } from '../../src/gateway-bridge.mjs';
import { IntegrationStore } from './integration-store.mjs';
import { PostgresIntegrationStore } from './postgres-integration-store.mjs';
import { PolicyService } from './policy-service.mjs';
import { MecAdapter, MecCallbackIngress, MecPolicyReconciler, MecSubscriptionManager } from './mec-adapter.mjs';
import { HandoverCoordinator } from './handover-coordinator.mjs';
import { FlCoordinator } from './fl-coordinator.mjs';
import { FlOneM2mPublisher } from './fl-publisher.mjs';
import { McpOrchestrator } from './mcp-orchestrator.mjs';
import { IntegrationApiGateway } from './api-gateway.mjs';
import { GatewayControl } from './gateway-control.mjs';
import { PortalService } from './portal-service.mjs';
import { PortalLocationService } from './portal-location-service.mjs';
import { LocationPrivacyService } from './location-privacy.mjs';
import { DeviceIncidentService } from './device-incidents.mjs';
import { RetentionService } from './retention-service.mjs';
import { GatewayRegistrationService } from './gateway-registration.mjs';
import { GatewayRegistrationCse } from './gateway-registration-cse.mjs';
import { GatewayCredentialIssuer } from './gateway-credential-issuer.mjs';
import { GroupRuntime } from './group-runtime.mjs';

export async function createIntegrationRuntime({ statePath = null, receiptPath = null, database = null, mqttClient = null, fetchImpl = globalThis.fetch, clock = () => new Date().toISOString(), core = {} } = {}) {
  const receiptJournal = receiptPath ? new ReceiptJournal(receiptPath, { clock }) : null;
  const databaseOptions = database ?? (process.env.BUBBLE_DATABASE_URL ? { connectionString: process.env.BUBBLE_DATABASE_URL, namespace: process.env.BUBBLE_DATABASE_NAMESPACE ?? 'bubble-lock' } : null);
  const encryptionKey = core.mec?.encryptionKey ?? process.env.BUBBLE_MEC_ENCRYPTION_KEY;
  if (databaseOptions && !encryptionKey) throw new Error('PostgreSQL runtime requires a shared MEC encryption key');
  const store = databaseOptions ? await new PostgresIntegrationStore({ ...databaseOptions, receiptJournal }).init() : await new IntegrationStore(statePath, { receiptJournal }).init();
  if (store.kind === 'postgres') clock = () => store.now();
  const policyService = new PolicyService({ store, clock });
  const handoverCoordinator = new HandoverCoordinator({ store, policyService, clock, fetchImpl, ...(core.handover ?? {}) });
  for (const edge of core.handover?.edges ?? []) handoverCoordinator.registerEdge(edge);
  for (const entry of core.handover?.manifests ?? []) await handoverCoordinator.registerManifest(entry.ueId, entry);
  const locationAdapter = new MecAdapter({ serviceName: 'Location', endpoint: core.locationEndpoint, clock, fetchImpl, ...(core.mec?.Location ?? {}) });
  const rnisAdapter = new MecAdapter({ serviceName: 'RNIS', endpoint: core.rnisEndpoint, clock, fetchImpl, ...(core.mec?.RNIS ?? {}) });
  const mecSubscriptions = new MecSubscriptionManager({ store, policyService, adapters: { Location: locationAdapter, RNIS: rnisAdapter }, callbackBaseUrl: core.mec?.callbackBaseUrl, encryptionKey, clock });
  await mecSubscriptions.cipher.ready;
  const mecIngress = new MecCallbackIngress({ store, policyService, subscriptions: mecSubscriptions, clock, locationAdapter, rnisAdapter });
  const reconciler = new MecPolicyReconciler({ store, policyService, handoverCoordinator, clock });
  mecIngress.onEvent((event) => reconciler.reconcileApprovedIntent(event));
  const flPublisher = core.fl?.publication ? new FlOneM2mPublisher({ fetchImpl, ...core.fl.publication }) : null;
  const flCoordinator = new FlCoordinator({ store, clock, ...(core.fl ?? {}), ...(flPublisher ? { publisher: (input) => flPublisher.publish(input) } : {}) });
  const mcpOrchestrator = new McpOrchestrator({ store, policyService, clock });
  const gatewayControl = new GatewayControl({ store, policyService, handoverCoordinator, clock });
  const registrationCse = core.registration?.cse ? new GatewayRegistrationCse({fetchImpl,...core.registration.cse}) : null;
  const credentialIssuer = core.registration?.issuer ? new GatewayCredentialIssuer(core.registration.issuer) : null;
  const gatewayRegistration = new GatewayRegistrationService({store,policyService,gatewayControl,clock,
    createAe:core.registration?.createAe ?? (registrationCse ? (input)=>registrationCse.createAe(input) : null),
    issueCredential:core.registration?.issueCredential ?? (credentialIssuer ? (input)=>credentialIssuer.issue(input) : null),
    terminateSessions:core.registration?.terminateSessions});
  for(const bootstrap of core.registration?.bootstraps ?? []) await gatewayRegistration.provisionBootstrap(bootstrap);
  const portalService = new PortalService({ store, policyService, gatewayControl, clock });
  const groupRuntime = core.group ? new GroupRuntime({ store, gatewayControl, clock, fetchImpl, ...core.group }) : null;
  if (groupRuntime) { await groupRuntime.ready; portalService.groupRuntime = groupRuntime; }
  const locationPrivacy = new LocationPrivacyService({store,policyService,portalService,cipher:mecSubscriptions.cipher,clock});
  portalService.locationPrivacy=locationPrivacy;
  handoverCoordinator.observationCipher=mecSubscriptions.cipher;
  const deviceIncidents=new DeviceIncidentService({store,portalService,policyService,gatewayControl,clock});
  const portalLocations = new PortalLocationService({ store, policyService, portalService, gatewayControl, mecIngress, handoverCoordinator, privacy:locationPrivacy,deviceIncidents, clock, deviceBindings: core.locationDeviceBindings ?? {} });
  await portalLocations.migrateLegacy();await handoverCoordinator.migrateObservations();await handoverCoordinator.purgeLegacyCse();
  portalLocations.start();
  const retention = new RetentionService({ store, clock, receiptJournal, ...(core.retention ?? {}) });
  if (core.retention?.autoPrune !== false) retention.start();
  const api = new IntegrationApiGateway({ policyService, mecIngress, mecSubscriptions, handoverCoordinator, flCoordinator, mcpOrchestrator, gatewayControl, gatewayRegistration, portalService, portalLocations, groupRuntime, clock });
  let gatewayBridge = null;
  if (mqttClient) {
    gatewayBridge = new GatewayBridge({ mqttClient, fetchImpl, receiptJournal, clock, ...core });
    gatewayBridge.onAck(async (receipt) => {
      const record = store.get('gatewayCommands', receipt.commandId);
      if (!record || receipt.ackState !== 'READBACK_VERIFIED') return;
      const command = record.command;
      await handoverCoordinator.settleDispatch({ ueId: command.deviceId, commandId: command.commandId, claimId: command.claimId, epoch: command.ownershipEpoch, payloadHash: record.payloadHash, ackState: receipt.ackState, readback: typeof receipt.payload.readback === 'boolean' ? { state: receipt.payload.readback } : receipt.payload.readback });
    });
  }
  let mecTimer;
  if (core.mec?.autoReconcile !== false && (locationAdapter.endpoint || rnisAdapter.endpoint || locationAdapter.platformRoot || rnisAdapter.platformRoot)) {
    mecSubscriptions.start();
    mecTimer = setInterval(() => mecIngress.drainOutbox().then(() => mecIngress.prune()).catch(() => {}), 1000);
    mecTimer.unref?.();
  }
  const close = async () => { groupRuntime?.close(); mecSubscriptions.stop(); portalLocations.close(); retention.close(); clearInterval(mecTimer); await mcpOrchestrator.close(); await store.close(); };
  return { store, receiptJournal, policyService, mecIngress, mecSubscriptions, reconciler, handoverCoordinator, flCoordinator, mcpOrchestrator, gatewayControl, gatewayRegistration, portalService, portalLocations, locationPrivacy,deviceIncidents, retention, api, gatewayBridge, groupRuntime, close };
}
