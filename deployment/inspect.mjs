import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const project = process.env.COMPOSE_PROJECT_NAME ?? 'bubblelock-deploy';
const { stdout } = await exec('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`]);
const ids = stdout.trim().split(/\s+/).filter(Boolean);
if (!ids.length) throw new Error(`No containers for ${project}`);
const inspected = JSON.parse((await exec('docker', ['inspect', ...ids], { maxBuffer: 4 * 1024 * 1024 })).stdout);
const expected = {
  proxy: new Set([String(process.env.HTTP_PORT ?? 80), String(process.env.HTTPS_PORT ?? 443)]),
  mqtt: new Set([String(process.env.MQTT_PORT ?? 8883)]),
};
const failures = [];
const results = inspected.map((container) => {
  const service = container.Config.Labels['com.docker.compose.service'];
  const ports = Object.values(container.HostConfig.PortBindings ?? {}).flat().map((binding) => binding.HostPort);
  const allowed = expected[service] ?? new Set();
  if (ports.length !== allowed.size || ports.some((port) => !allowed.has(port))) failures.push(`${service}: unexpected published ports ${ports}`);
  if (container.Mounts.some((mount) => mount.Type !== 'volume')) failures.push(`${service}: non-volume host mount`);
  if (!container.Config.User || /^(root|0)(:|$)/.test(container.Config.User)) failures.push(`${service}: root runtime user`);
  if (['proxy', 'api', 'web', 'mqtt', 'mqtt-bridge'].includes(service) && !container.HostConfig.ReadonlyRootfs) failures.push(`${service}: writable root filesystem`);
  if (service !== 'static' && !container.HostConfig.SecurityOpt?.includes('no-new-privileges:true')) failures.push(`${service}: missing no-new-privileges`);
  return { service, running: container.State.Running, ports, user: container.Config.User, readOnly: container.HostConfig.ReadonlyRootfs, mounts: container.Mounts.map(({ Type, Name, Destination, RW }) => ({ Type, Name, Destination, RW })) };
});
console.log(JSON.stringify({ project, status: failures.length ? 'FAIL' : 'PASS', results, failures }, null, 2));
if (failures.length) process.exitCode = 1;
