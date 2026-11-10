import { ReceiptJournal } from '../../src/receipt-journal.mjs';
import { GatewayBridge } from '../../src/gateway-bridge.mjs';
import { IntegrationStore } from './integration-store.mjs';
import { PolicyService } from './policy-service.mjs';
import { MecAdapter, MecCallbackIngress, MecPolicyReconciler } from './mec-adapter.mjs';
import { HandoverCoordinator } from './handover-coordinator.mjs';
import { FlCoordinator } from './fl-coordinator.mjs';
import { McpOrchestrator } from './mcp-orchestrator.mjs';
import { IntegrationApiGateway } from './api-gateway.mjs';
import { GatewayControl } from './gateway-control.mjs';

export async function createIntegrationRuntime({ statePath = null, receiptPath = null, mqttClient = null, fetchImpl = globalThis.fetch, clock = () => new Date().toISOString(), core = {} } = {}) {
  const receiptJournal = receiptPath ? new ReceiptJournal(receiptPath, { clock }) : null;
  const store = await new IntegrationStore(statePath, { receiptJournal }).init();
  const policyService = new PolicyService({ store, clock });
  const handoverCoordinator = new HandoverCoordinator({ store, clock });
  const locationAdapter = new MecAdapter({ serviceName: 'Location', endpoint: core.locationEndpoint, clock });
  const rnisAdapter = new MecAdapter({ serviceName: 'RNIS', endpoint: core.rnisEndpoint, clock });
  const mecIngress = new MecCallbackIngress({ store, clock, locationAdapter, rnisAdapter });
  const reconciler = new MecPolicyReconciler({ store, policyService, handoverCoordinator, clock });
  mecIngress.onEvent((event) => reconciler.reconcileApprovedIntent(event));
  const flCoordinator = new FlCoordinator({ store, clock });
  const mcpOrchestrator = new McpOrchestrator({ store, policyService, clock });
  const gatewayControl = new GatewayControl({ store, policyService, handoverCoordinator, clock });
  const api = new IntegrationApiGateway({ policyService, mecIngress, handoverCoordinator, flCoordinator, mcpOrchestrator, gatewayControl, clock });
  let gatewayBridge = null;
  if (mqttClient) gatewayBridge = new GatewayBridge({ mqttClient, fetchImpl, receiptJournal, clock, ...core });
  return { store, receiptJournal, policyService, mecIngress, reconciler, handoverCoordinator, flCoordinator, mcpOrchestrator, gatewayControl, api, gatewayBridge };
}
