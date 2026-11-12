import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const project = process.env.COMPOSE_PROJECT_NAME ?? 'bubblelock-deploy';
const ids = (await exec('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`])).stdout.trim().split(/\s+/).filter(Boolean);
if (!ids.length) throw new Error('No deployment containers');
const states = JSON.parse((await exec('docker', ['inspect', ...ids], { maxBuffer: 4 * 1024 * 1024 })).stdout);
const alerts = states.flatMap((container) => {
  const service = container.Config.Labels['com.docker.compose.service'];
  if (['static', 'db-init'].includes(service) && container.State.ExitCode === 0) return [];
  if (!container.State.Running || container.State.OOMKilled || container.State.Health?.Status === 'unhealthy') {
    return [{ service, running: container.State.Running, oomKilled: container.State.OOMKilled, health: container.State.Health?.Status, action: 'Inspect service logs and restore the failed dependency before restarting dependants' }];
  }
  return [];
});
console.log(JSON.stringify({ status: alerts.length ? 'ALERT' : 'HEALTHY', alerts }));
if (alerts.length) process.exitCode = 1;
