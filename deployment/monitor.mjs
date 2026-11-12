import { execFile } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const project = process.env.COMPOSE_PROJECT_NAME ?? 'bubblelock-deploy';
const alertDays = Number(process.env.CERT_ALERT_DAYS ?? 14);
if (!Number.isSafeInteger(alertDays) || alertDays < 1 || alertDays > 365) throw new TypeError('CERT_ALERT_DAYS must be between 1 and 365');
const ids = (await exec('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`])).stdout.trim().split(/\s+/).filter(Boolean);
if (!ids.length) throw new Error('No deployment containers');
const states = JSON.parse((await exec('docker', ['inspect', ...ids], { maxBuffer: 4 * 1024 * 1024 })).stdout);
const containerAlerts = states.flatMap((container) => {
  const service = container.Config.Labels['com.docker.compose.service'];
  if (['static', 'db-init'].includes(service) && container.State.ExitCode === 0) return [];
  if (!container.State.Running || container.State.OOMKilled || container.State.Health?.Status === 'unhealthy') {
    return [{ service, running: container.State.Running, oomKilled: container.State.OOMKilled, health: container.State.Health?.Status, action: 'Inspect service logs and restore the failed dependency before restarting dependants' }];
  }
  return [];
});
const pki = resolve(process.env.RUN_TMP ?? '.local/deployment', 'pki');
const certificateAlerts = await Promise.all(['mqtt', 'gateway-1'].map(async (certificate) => {
  try {
    const validTo = Date.parse(new X509Certificate(await readFile(join(pki, `${certificate}.pem`))).validTo);
    if (validTo - Date.now() > alertDays * 86400_000) return [];
    return [{ certificate, expiresAt: new Date(validTo).toISOString(), action: 'Rotate the MQTT and Gateway certificates using deployment/RUNBOOK.md before expiry' }];
  } catch {
    return [{ certificate, action: 'Restore the certificate file and check deployment/RUNBOOK.md before restarting services' }];
  }
}));
const alerts = [...containerAlerts, ...certificateAlerts.flat()];
console.log(JSON.stringify({ status: alerts.length ? 'ALERT' : 'HEALTHY', alerts }));
if (alerts.length) process.exitCode = 1;
