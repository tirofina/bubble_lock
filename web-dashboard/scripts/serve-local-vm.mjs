// Starts serve:local against the self-hosted Mobius gateway layout (polling). The config lives in gitignored .local/.
import { fileURLToPath } from 'node:url';

process.env.DASHBOARD_SOURCE = 'cse-live';
process.env.CSE_LIVE_CONFIG ??= fileURLToPath(new URL('../../.local/cse-live-vm.json', import.meta.url));
await import('./serve-local.mjs');
