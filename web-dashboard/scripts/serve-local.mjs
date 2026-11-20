// Starts the BFF with self-hosted password accounts. BFF_HOST stays loopback: LAN browsers reach it through the Vite /api proxy.
import { fileURLToPath } from 'node:url';

process.env.LOCAL_ACCOUNTS_FILE ??= fileURLToPath(new URL('../../.local/portal-accounts.json', import.meta.url));
process.env.BFF_HOST = '127.0.0.1';
await import('../server/cli.ts');
