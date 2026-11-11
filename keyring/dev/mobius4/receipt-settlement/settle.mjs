import { parseArgs } from 'node:util';
import { commandReceiptName } from '../../../integration-candidate/receipt-native-source.mjs';
import { createFileSettlementCommit } from '../../../integration-candidate/receipt-settlement-files.mjs';
import { scopedCommandReceiptContainers } from '../scoped-command-receipts.mjs';
import { loadScopedReceiptContext, readJson } from './scoped-io.mjs';

async function main() {
  if (typeof process.getuid !== 'function') throw new Error('POSIX_SETTLEMENT_HOST_REQUIRED');
  const { values } = parseArgs({ options: {
    'team-root': { type: 'string' }, state: { type: 'string' }, ledger: { type: 'string' },
    gateway: { type: 'string' }, command: { type: 'string' }, ack: { type: 'string' },
  } });
  if (!values['team-root'] || !values.state || !values.ledger || !values.gateway || !values.command) {
    throw new Error('REQUIRED_ARGUMENTS_TEAM_ROOT_STATE_LEDGER_GATEWAY_COMMAND');
  }
  if (!Object.hasOwn(scopedCommandReceiptContainers, values.gateway)) throw new Error('UNKNOWN_SCOPED_GATEWAY');
  const nativeRef = `${scopedCommandReceiptContainers[values.gateway]}/${commandReceiptName(values.command)}`;
  const [context, ack] = await Promise.all([
    loadScopedReceiptContext({ teamRoot: values['team-root'], state: values.state }),
    values.ack ? readJson(values.ack, 65536) : undefined,
  ]);
  const settle = context.settleForSnapshot(await context.readSnapshot(), createFileSettlementCommit(values.ledger));
  const result = await settle({ nativeRef, ack });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === 'WAITING_FOR_NATIVE') process.exitCode = 2;
  if (result.status === 'REVIEW') process.exitCode = 3;
}

try {
  await main();
} catch (error) {
  const code = [error.code, error.message].find((value) => typeof value === 'string' && /^[A-Z][A-Z0-9_]+$/.test(value));
  process.stderr.write(`${JSON.stringify({ status: 'ERROR', code: code ?? 'SCOPED_SETTLEMENT_FAILED' })}\n`);
  process.exitCode = 1;
}
