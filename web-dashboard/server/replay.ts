import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import acceptanceFixtures from '../fixtures/api-acceptance.json' with { type: 'json' };
import { createReceiptAdapter, parseJournalJsonl } from '../shared/receipt-adapter.ts';
import { parseDashboardEvent } from '../shared/validation.ts';
import type { DashboardEvent, SourceMode } from '../shared/types.ts';

export const DEFAULT_RECEIPT_FILE = fileURLToPath(new URL('../fixtures/core-demo.jsonl', import.meta.url));

export interface ReplaySnapshot {
  readonly source: SourceMode;
  readonly simulation: true;
  readonly events: readonly DashboardEvent[];
  readonly lastSequence: number;
}

/** Immutable startup snapshot. Explicit files never get invented API acceptance. */
export async function loadReplay(receiptFile?: string): Promise<ReplaySnapshot> {
  const receipts = parseJournalJsonl(await readFile(receiptFile ?? DEFAULT_RECEIPT_FILE, 'utf8'));
  const source = receiptFile === undefined ? 'fixture-replay'
    : receipts.some((receipt) => receipt.contractId === 'privacy-bubble.integration.v1') ? 'integration-journal-replay' : 'core-journal-replay';
  const adapter = createReceiptAdapter({ source });
  const events: DashboardEvent[] = [];
  if (receiptFile === undefined) {
    for (const fixture of acceptanceFixtures) {
      const event = parseDashboardEvent(fixture);
      if (event.type === 'command.accepted') events.push(adapter.acceptanceEvent(event.acceptance));
    }
  }
  events.push(...receipts.map(adapter.adaptReceipt));
  return { source, simulation: true, events, lastSequence: events.at(-1)?.sequence ?? 0 };
}
