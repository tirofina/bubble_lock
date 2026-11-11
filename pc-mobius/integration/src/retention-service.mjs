import { approvalHash, recordEnvelope } from './integration-utils.mjs';

const DAY = 86400000;
export const RETENTION_DEFAULTS = Object.freeze({ abstract: 7 * DAY, detail: DAY, pseudonym: DAY, audit: 30 * DAY, provenance: 30 * DAY });
const rules = {
  events: 'abstract', portalNotifications: 'abstract', abstractStates: 'abstract', deviceButtonStates: 'abstract', gatewayDeviceReceipts: 'abstract',
  gatewayTelemetry: 'detail', handoverObservations: 'detail', handoverPayloads: 'detail', locationPayloads: 'detail', locationLeases: 'detail', portalIncidents: 'detail', portalOperations: 'detail', deviceIncidentEvents: 'detail', portalCommandRequests: 'detail',
  pseudonymMappings: 'pseudonym', relayAssociations: 'pseudonym',
  flProvenance: 'provenance', flWorkerUpdates: 'provenance', mcpEvidence: 'audit',
};
const timestamp = (row) => Date.parse(row.createdAt ?? row.observedAt ?? row.timestamp ?? row.completedAt ?? row.acceptedAt ?? row.receivedAt ?? row.registeredAt ?? row.requestedAt ?? row.journaledAt);

export class RetentionService {
  constructor({ store, clock = () => new Date().toISOString(), receiptJournal = null, intervalMs = 60000, householdPolicies = {} }) {
    Object.assign(this, { store, clock, receiptJournal, intervalMs }); this.householdPolicies = structuredClone(householdPolicies);
    for (const policy of Object.values(this.householdPolicies)) for (const [category, value] of Object.entries(policy)) if (!(category in RETENTION_DEFAULTS) || !Number.isSafeInteger(value) || value < 1000 || value > RETENTION_DEFAULTS[category]) throw new Error('RETENTION_POLICY_RANGE');
  }
  duration(category, row) { return this.householdPolicies[row.householdId ?? row.subjectId]?.[category] ?? RETENTION_DEFAULTS[category]; }
  expires(row, category, now) {
    const origin = timestamp(row); const explicit = Date.parse(row.expiresAt);
    const deadline = Math.min(Number.isFinite(origin) ? origin + this.duration(category, row) : Infinity, Number.isFinite(explicit) ? explicit : Infinity);
    return deadline <= now;
  }
  async runOnce() {
    const report = await this.store.transaction('retention:expiry', async () => {
      const now = Date.parse(this.clock()); const counts = {}; const hashes = []; const removedReceiptIds = [];
      for (const [collection, category] of Object.entries(rules)) {
        const rows = this.store.collection(collection);
        for (const [key, row] of Object.entries(rows)) if (this.expires(row, category, now)) { delete rows[key]; counts[collection] = (counts[collection] ?? 0) + 1; hashes.push(approvalHash({ collection, key })); }
      }
      for (const [key, participant] of Object.entries(this.store.collection('flParticipants'))) {
        const origin = participant.registeredAt ?? participant.consent?.validFrom;
        if (participant.status === 'RETENTION_EXPIRED' || !this.expires({ ...participant, createdAt: origin }, 'provenance', now)) continue;
        const datasetId = participant.dataset?.datasetId; const datasetVersion = participant.dataset?.datasetVersion;
        participant.dataset = { datasetId, datasetVersion }; participant.status = 'RETENTION_EXPIRED'; participant.provenanceDeletedAt = this.clock();
        const task = this.store.get('flTasks', participant.taskId);
        if (task?.lineageContributors?.includes(participant.participantId)) { task.state = 'SERVING_PAUSED'; task.reviewState = 'PROVENANCE_EXPIRED'; task.servingGeneration++; }
        counts.flParticipantProvenance = (counts.flParticipantProvenance ?? 0) + 1; hashes.push(approvalHash({ collection: 'flParticipants', key }));
      }
      for (const round of this.store.list('flRounds')) if (this.expires(round, 'provenance', now)) {
        for (const update of round.updates ?? []) if (update.localTrainReceipt) { delete update.localTrainReceipt; counts.flTrainReceipts = (counts.flTrainReceipts ?? 0) + 1; }
      }
      const receipts = this.store.collection('receipts');
      for (let index = receipts.length - 1; index >= 0; index--) if (this.expires(receipts[index], 'audit', now)) { removedReceiptIds.push(receipts[index].eventId); hashes.push(approvalHash({ collection: 'receipts', eventId: receipts[index].eventId })); receipts.splice(index, 1); counts.receipts = (counts.receipts ?? 0) + 1; }
      if (removedReceiptIds.length && typeof this.store.pruneReceiptOutbox === 'function') await this.store.pruneReceiptOutbox(removedReceiptIds);
      const result = { deletedAt: this.clock(), counts, deletedCount: Object.values(counts).reduce((sum, value) => sum + value, 0), deletedKeysHash: approvalHash(hashes.sort()), categories: RETENTION_DEFAULTS };
      if (result.deletedCount) await this.store.append('receipts', recordEnvelope({ type: 'RETENTION_EXPIRED', ...result }, this.clock));
      return result;
    });
    if (this.receiptJournal?.prune) {
      const now = Date.parse(this.clock()); const expired = (row) => this.expires(row, 'audit', now);
      const result = typeof this.store.pruneReceiptJournal === 'function' ? await this.store.pruneReceiptJournal(expired) : await this.receiptJournal.prune(expired);
      report.journalRemoved = result.removed;
      if (result.removed) await this.store.append('receipts', recordEnvelope({ type: 'RETENTION_JOURNAL_PRUNED', removed: result.removed, deletedAt: this.clock() }, this.clock));
    }
    this.lastResult = report; return report;
  }
  start() { this.timer ??= setInterval(() => { void this.runOnce().catch((error) => { this.lastError = error.code ?? error.message; }); }, this.intervalMs); this.timer.unref?.(); }
  close() { clearInterval(this.timer); this.timer = null; }
}
