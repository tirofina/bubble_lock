import type { AuditFixture, DashboardEvent, IntegrationReceipt } from './types.ts';

export function integrationReceipts(events: readonly DashboardEvent[]): readonly IntegrationReceipt[] {
  return events.flatMap((event) => event.type === 'integration.receipt' ? [event.receipt] : []);
}

export function integrationAudit(events: readonly DashboardEvent[]): readonly AuditFixture[] {
  return events.flatMap((event) => {
    if (event.type !== 'integration.receipt') return [];
    const receipt = event.receipt;
    return [{
      id: `${receipt.eventId}:${event.sequence}`,
      receivedAt: event.receivedAt,
      actor: receipt.principalId ?? 'PC-MOBIUS-INTEGRATION',
      action: receipt.type ?? receipt.eventType ?? receipt.service ?? 'INTEGRATION',
      resourceUri: event.resourceUri,
      outcome: receipt.allowed === false ? 'denied' : receipt.allowed === true ? 'allowed' : 'pending',
      simulation: true,
    } satisfies AuditFixture];
  });
}

export function integrationServices(events: readonly DashboardEvent[]) {
  const receipts = integrationReceipts(events);
  return [
    { title: 'MEC · Location / RNIS', prefix: 'MEC', fields: ['eventId', 'service', 'eventType', 'ueId', 'status', 'allowed'] },
    { title: 'Handover · Edge A → B', prefix: 'HANDOVER', fields: ['ueId', 'state', 'previousEdgeId', 'edgeId', 'epoch', 'grantId'] },
    { title: 'FL · round / model lineage', prefix: 'FL', fields: ['roundId', 'state', 'participantCount', 'selectionHash', 'modelHash'] },
    { title: 'MCP · 승인 / 실행', prefix: 'MCP', fields: ['runId', 'action', 'cursor', 'principalId', 'approvalHash'] },
  ].map((service) => {
    const receipt = receipts.findLast((record) => record.type?.startsWith(service.prefix) || (service.prefix === 'MEC' && record.service));
    return { ...service, receipt, values: service.fields.flatMap((name) => {
      const value = receipt?.[name];
      return value === undefined || value === null ? [] : [[name, String(value)] as const];
    }) };
  });
}
