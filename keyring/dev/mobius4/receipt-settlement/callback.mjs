import { X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createReceiptNotificationHttpsServer } from '../../../integration-candidate/receipt-notification-https.mjs';
import { createReceiptNotificationIngress } from '../../../integration-candidate/receipt-notification-ingress.mjs';
import { createPostgresReceiptInbox } from '../../../integration-candidate/receipt-notification-postgres.mjs';
import { scopedCommandReceiptContainers, scopedReceiptCseKey as cseKey } from '../scoped-command-receipts.mjs';
import { openScopedReceiptPool, requireScopedReceiptSchema } from './scoped-database.mjs';

const path = '/onem2m/keyring/receipt-notifications';

async function main() {
  const profileTls = new URL('../.local/scoped/tls/', import.meta.url);
  const [ca, cert, key, relayCert] = await Promise.all([
    ...['ca.pem', 'server.pem', 'server.key'].map((name) => readFile(new URL(name, profileTls))),
    readFile(new URL('./.local/callback-peer/relay.pem', import.meta.url)),
  ]);
  const fingerprint256 = new X509Certificate(relayCert).fingerprint256;
  const pool = await openScopedReceiptPool('keyring-scoped-receipt-callback');
  pool.on('error', () => console.error(JSON.stringify({ status: 'CALLBACK_DATABASE_CONNECTION_LOST' })));
  let server;
  const shutdown = () => server?.close();
  try {
    await requireScopedReceiptSchema(pool);
    const inbox = createPostgresReceiptInbox(pool);
    const subscriptions = Object.values(scopedCommandReceiptContainers).map((receiptContainer) => ({
      cseKey, originator: '/Mobius4', receiptContainer, subscriptionRef: `${receiptContainer.slice(1)}/keyring-settlement`,
    }));
    const receive = createReceiptNotificationIngress({ subscriptions, enqueue: inbox.enqueue });
    server = createReceiptNotificationHttpsServer({ tls: { ca, cert, key }, peers: [{ fingerprint256, cseKey }], receive, path });
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    const listening = once(server, 'listening');
    server.listen(8790, '127.0.0.1');
    await listening;
    console.log(JSON.stringify({ status: 'SCOPED_RECEIPT_CALLBACK_READY', endpoint: `https://127.0.0.1:8790${path}` }));
    await once(server, 'close');
  } finally {
    if (server?.listening) server.close();
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
    await pool.end();
  }
}

try {
  await main();
} catch (error) {
  const code = [error?.code, error?.message].find((value) => typeof value === 'string' && /^[A-Z0-9_]{1,80}$/.test(value));
  console.error(JSON.stringify({ status: 'ERROR', code: code ?? 'SCOPED_RECEIPT_CALLBACK_FAILED' }));
  process.exitCode = 1;
}
