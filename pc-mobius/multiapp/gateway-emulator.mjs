/**
 * Emulated Raspberry Pi Gateway with emulated keyrings (simulation: true) for the R03 scenario.
 *
 * Hardware is emulated; the CSE, ACPs, subscriptions and resource writes are real. The write path
 * mirrors bubble_gateway.transport.TransportHub.publish: one contentInstance per record named
 * gw-sha256(requestId), cnf application/json:0, followed by a RETRIEVE that confirms the stored
 * content. Every observation and command also passes through bubble_gateway.model via the Python
 * bridge, so the Gateway contract checks and payload hash are the Pi daemon's own code.
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { Onem2mHttp, startNotificationServer, normalizeSid, payloadHash } from './onem2m-http.mjs';
import { acpBody, acpPlan, BINARY_SWITCH_CND, COMMAND_BUNDLE_TYPE, CONTAINER_POLICY, DISPATCH_RECORD_TYPE, LABELS, STREAMS, STREAM_ACP } from './topology.mjs';
import { repositoryRoot } from './mobius-launcher.mjs';

const FIRMWARE = 'emulated-keyring-0.1.0';
const iso = () => new Date().toISOString();

async function loadValidators() {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const read = async (name) => JSON.parse(await readFile(join(repositoryRoot, 'contracts/keyring', name), 'utf8'));
  return { observation: ajv.compile(await read('observation.schema.json')), receipt: ajv.compile(await read('receipt.schema.json')), command: ajv.compile(await read('command.schema.json')) };
}

/** Persistent child running bubble_gateway.model; falls back to JSON Schema only when absent. */
async function startModelBridge(python) {
  if (!python?.executable) return null;
  const child = spawn(python.executable, [python.script], { cwd: repositoryRoot, env: { ...process.env, PYTHONPATH: python.pythonPath, PYTHONIOENCODING: 'utf-8' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const pending = new Map(); let next = 1; let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
  const lines = createInterface({ input: child.stdout });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`gateway model bridge: ${stderr}`)), 15000);
    lines.on('line', (line) => {
      const message = JSON.parse(line);
      if (message.ready) { clearTimeout(timer); resolve(); return; }
      pending.get(message.id)?.(message); pending.delete(message.id);
    });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`gateway model bridge exited ${code}: ${stderr}`)); });
  });
  await ready;
  return {
    call: (request) => new Promise((resolve) => { const id = next++; pending.set(id, resolve); child.stdin.write(`${JSON.stringify({ ...request, id })}\n`); }),
    close: () => { child.stdin.end(); child.kill(); },
    implementation: 'bubble_gateway.model (Python)',
  };
}

/** Emulated keyring firmware state: boot identity, sequence, LED/bubble state, battery. */
class EmulatedKeyring {
  constructor({ deviceId, mac, battery = 80, rssi = -60 }) {
    Object.assign(this, { deviceId, mac, battery, rssi, state: false, sequence: 0, presses: [0, 0], bootId: `emu-${randomBytes(4).toString('hex')}` });
  }
  observation(gatewayId, { buttonState = 'released', battery } = {}) {
    if (battery !== undefined) this.battery = battery;
    if (buttonState === 'confirm') this.presses[0] += 1;
    if (buttonState === 'panic') this.presses[1] += 1;
    this.sequence += 1;
    const observedAt = iso();
    return {
      version: 1, gatewayId, deviceId: this.deviceId, bootId: this.bootId, sequence: this.sequence, observedAt, receivedAt: iso(),
      rssi: this.rssi, battery: this.battery, buttonState, sensorValues: { batteryAlert: this.battery <= 15, buttonPresses: [...this.presses] },
      state: this.state, firmwareRevision: FIRMWARE, timestampSource: 'gateway-received',
    };
  }
  async apply(desired, [low, high]) {
    const acceptedAt = iso();
    await delay(low + Math.floor(Math.random() * Math.max(1, high - low)));
    this.state = desired;
    const appliedAt = iso();
    await delay(5);
    return { acceptedAt, appliedAt, readback: { state: this.state } };
  }
}

export async function startGatewayEmulator(config, { report = () => {} } = {}) {
  const { cse, gateway, apps } = config;
  const http = new Onem2mHttp({ endpoint: cse.endpoint, originator: gateway.aeId });
  const validators = await loadValidators();
  const bridge = await startModelBridge(config.python).catch((error) => { report({ type: 'warning', message: error.message }); return null; });
  const keyrings = new Map(config.keyrings.map((entry) => [entry.deviceId, new EmulatedKeyring(entry)]));
  const devices = Object.fromEntries(config.keyrings.map((entry) => [entry.deviceId, entry.mac]));
  const handled = new Map();
  const subscriptions = new Map();
  const writes = [];
  const latency = config.bleLatencyMs ?? [35, 70];
  const aePath = `${cse.cseBase}/${gateway.rn}`;
  const rootOf = (deviceId) => `${aePath}/${deviceId}`;

  async function model(kind, payload) {
    if (!bridge) return { ok: true, payloadHash: payloadHash(payload), implementation: 'json-schema-fallback' };
    const result = await bridge.call({ kind, payload, gatewayId: gateway.gatewayId, devices });
    return { ...result, implementation: bridge.implementation };
  }

  /** TransportHub.publish equivalent over oneM2M HTTP, plus creator attribute request. */
  async function nativeCreate(container, rqi, payload) {
    const rn = `gw-${createHash('sha256').update(rqi).digest('hex')}`;
    const started = Date.now();
    const created = await http.request('POST', container, { body: { 'm2m:cin': { rn, cnf: 'application/json:0', con: payload, cr: null } }, ty: 4 });
    const acknowledgedMs = Date.now();
    if (![2001, 4105].includes(created.rsc)) throw new Error(`native CREATE ${container} rsc ${created.rsc}: ${JSON.stringify(created.payload)?.slice(0, 200)}`);
    const readback = await http.expect('GET', `${container}/${rn}`, [2000]);
    const stored = readback.payload['m2m:cin'];
    // Key order is not preserved by the CSE store; compare canonical (sorted-key) JSON like TransportHub._confirm_stored.
    if (payloadHash(stored.con) !== payloadHash(payload)) throw new Error(`native readback differs at ${container}/${rn}`);
    const record = { container, rn, rqi, ri: stored.ri, ct: stored.ct, rsc: created.rsc, confirmed: true, startedMs: started, acknowledgedMs, confirmedMs: Date.now(), durationMs: Date.now() - started };
    writes.push(record);
    return record;
  }

  async function provision() {
    const plan = acpPlan({ gateway: gateway.aeId, ...apps });
    const acps = {};
    for (const [rn, rules] of Object.entries(plan)) acps[rn] = (await http.ensure(aePath, 1, acpBody(rn, rules, gateway.aeId))).payload['m2m:acp'].ri;
    const resources = {};
    for (const deviceId of keyrings.keys()) {
      const common = [LABELS.device(deviceId), LABELS.gateway(gateway.gatewayId), LABELS.household(gateway.householdId)];
      await http.ensure(aePath, 3, { 'm2m:cnt': { rn: deviceId, lbl: [LABELS.keyring, LABELS.sdt, ...common], acpi: [acps['acp-root']] } });
      for (const stream of STREAMS) {
        await http.ensure(rootOf(deviceId), 3, { 'm2m:cnt': { rn: stream, ...CONTAINER_POLICY[stream], lbl: [LABELS.stream(stream), ...common], acpi: [acps[STREAM_ACP[stream]]] } });
      }
      await http.ensure(rootOf(deviceId), 28, { 'cod:binSh': { rn: 'switch', cnd: BINARY_SWITCH_CND, state: false, lbl: [LABELS.stream('switch'), ...common], acpi: [acps['acp-switch']] } });
      const commandPath = `${rootOf(deviceId)}/command`;
      const subPath = `${commandPath}/sub-gateway`;
      await http.request('DELETE', subPath);
      await http.expect('POST', commandPath, [2001], { body: { 'm2m:sub': { rn: 'sub-gateway', nu: [gateway.aeId], su: gateway.aeId, enc: { net: [3], chty: [4] }, nct: 1 } }, ty: 23 });
      subscriptions.set(subPath, deviceId);
      resources[deviceId] = { root: rootOf(deviceId), switch: `${rootOf(deviceId)}/switch`, ...Object.fromEntries(STREAMS.map((stream) => [stream, `${rootOf(deviceId)}/${stream}`])) };
    }
    return { acps, resources };
  }

  function rejection(command, deviceId, ackCode, detail) {
    return {
      version: 1, gatewayId: gateway.gatewayId, deviceId, commandId: command?.commandId ?? `unknown-${randomBytes(4).toString('hex')}`,
      payloadHash: command ? payloadHash(command) : '0'.repeat(64), status: 'REJECTED', ackCode, acceptedAt: null, appliedAt: null, receivedAt: iso(),
      readback: null, firmwareRevision: FIRMWARE, ownershipEpoch: Number.isInteger(command?.ownershipEpoch) ? command.ownershipEpoch : gateway.ownershipEpoch,
      grantRevision: Number.isInteger(command?.grantRevision) && command.grantRevision >= 1 ? command.grantRevision : 1, timestampSource: 'unavailable', detail, bootId: keyrings.get(deviceId)?.bootId ?? null,
    };
  }

  async function reject(deviceId, cin, command, ackCode, detail, notifiedMs) {
    const receipt = rejection(command, deviceId, ackCode, detail);
    if (!validators.receipt(receipt)) throw new Error(`receipt schema: ${JSON.stringify(validators.receipt.errors)}`);
    const written = await nativeCreate(`${rootOf(deviceId)}/receipt`, `reject-${cin.ri}-${deviceId}`, receipt);
    report({ type: 'command-rejected', deviceId, commandId: receipt.commandId, ackCode, detail, creator: cin.cr ?? null, commandResource: cin.ri, notifiedMs, receipt: written });
  }

  async function handleCommand(deviceId, cin, notifiedMs) {
    const bundle = cin.con;
    if (cin.cr !== apps.guardian) return reject(deviceId, cin, bundle?.commands?.find?.((entry) => entry?.command?.deviceId === deviceId)?.command, 'UNAUTHORIZED_WRITER', `creator ${cin.cr ?? 'absent'} is not the guardian AE`, notifiedMs);
    if (bundle?.type !== COMMAND_BUNDLE_TYPE || bundle.version !== 1 || !Array.isArray(bundle.commands)) return reject(deviceId, cin, null, 'SCHEMA_MISMATCH', 'command bundle shape', notifiedMs);
    const entry = bundle.commands.find((item) => item?.command?.deviceId === deviceId);
    if (!entry) return;
    const command = entry.command;
    if (!validators.command(command)) return reject(deviceId, cin, command, 'SCHEMA_MISMATCH', 'keyring command schema', notifiedMs);
    // The deadline is enforced at the edge before idempotency, so an expired replay is answered with EXPIRED.
    if (Date.parse(command.deadline) <= Date.now()) return reject(deviceId, cin, command, 'EXPIRED', 'deadline passed before dispatch', notifiedMs);
    if (handled.has(command.commandId)) return;
    handled.set(command.commandId, 'IN_PROGRESS');
    const checked = await model('command', command);
    if (!checked.ok) return reject(deviceId, cin, command, 'SCHEMA_MISMATCH', checked.error, notifiedMs);
    if (checked.payloadHash !== entry.payloadHash || payloadHash(command) !== entry.payloadHash) return reject(deviceId, cin, command, 'PAYLOAD_HASH_MISMATCH', 'payloadHash differs from bundle', notifiedMs);
    if (command.ownershipEpoch !== gateway.ownershipEpoch) return reject(deviceId, cin, command, 'STALE_EPOCH', 'ownership epoch differs from Gateway binding', notifiedMs);
    const keyring = keyrings.get(deviceId);
    const dispatchedAt = iso();
    const dispatch = { version: 1, type: DISPATCH_RECORD_TYPE, gatewayId: gateway.gatewayId, deviceId, commandId: command.commandId, claimId: command.claimId, payloadHash: entry.payloadHash, grantRevision: command.grantRevision, ownershipEpoch: command.ownershipEpoch, deadline: command.deadline, dispatchedAt, transport: 'ble-gatt-emulated', simulation: true, commandResource: cin.ri, command };
    const dispatchWrite = await nativeCreate(`${rootOf(deviceId)}/receipt`, `dispatch-${command.commandId}`, dispatch);
    const applied = await keyring.apply(command.desiredState.state, latency);
    const receipt = {
      version: 1, gatewayId: gateway.gatewayId, deviceId, commandId: command.commandId, payloadHash: entry.payloadHash, status: 'APPLIED', ackCode: 'APPLIED',
      acceptedAt: applied.acceptedAt, appliedAt: applied.appliedAt, receivedAt: iso(), readback: applied.readback, firmwareRevision: FIRMWARE,
      ownershipEpoch: command.ownershipEpoch, grantRevision: command.grantRevision, timestampSource: 'gateway-estimated', detail: 'emulated keyring (simulation)', bootId: keyring.bootId,
    };
    if (!validators.receipt(receipt)) throw new Error(`receipt schema: ${JSON.stringify(validators.receipt.errors)}`);
    const receiptWrite = await nativeCreate(`${rootOf(deviceId)}/receipt`, `receipt-${command.commandId}`, receipt);
    const switchStarted = Date.now();
    await http.expect('PUT', `${rootOf(deviceId)}/switch`, [2004], { body: { 'cod:binSh': { state: applied.readback.state } } });
    const switchRead = await http.expect('GET', `${rootOf(deviceId)}/switch`, [2000]);
    const switchState = switchRead.payload['cod:binSh'].state;
    handled.set(command.commandId, 'APPLIED');
    report({
      type: 'command-applied', deviceId, commandId: command.commandId, claimId: command.claimId, payloadHash: entry.payloadHash, grantRevision: command.grantRevision, ownershipEpoch: command.ownershipEpoch, deadline: command.deadline,
      creator: cin.cr, commandResource: cin.ri, commandCt: cin.ct, modelCheck: checked.implementation, notifiedMs, dispatchedAt, dispatchWrite, applied, receiptReceivedAt: receipt.receivedAt, receiptWrite,
      switchUpdatedMs: switchStarted, switchConfirmedMs: Date.now(), switchState, switchMatches: switchState === command.desiredState.state,
    });
  }

  const notifications = await startNotificationServer({
    cseId: cse.cseId,
    creators: { gateway: [gateway.aeId] },
    onNotify: async ({ sgn }) => {
      const notifiedMs = Date.now();
      const sur = normalizeSid(sgn.sur, cse.cseBase);
      const deviceId = subscriptions.get(sur);
      const cin = sgn.nev?.rep?.['m2m:cin'];
      if (!deviceId || !cin) return;
      try { await handleCommand(deviceId, cin, notifiedMs); }
      catch (error) { report({ type: 'error', deviceId, message: error.message }); }
    },
  });
  const ae = await http.registerAe(cse.cseBase, { rn: gateway.rn, api: 'Npb.gateway.emulated', poa: [`${notifications.url}/gateway`], lbl: [LABELS.gateway(gateway.gatewayId), 'pb-simulation'] });
  const provisioning = await provision();

  async function emit({ deviceId, kind, buttonState, battery }) {
    const keyring = keyrings.get(deviceId);
    if (!keyring) throw new Error(`unknown keyring ${deviceId}`);
    const payload = keyring.observation(gateway.gatewayId, { buttonState: kind === 'button' ? buttonState ?? 'panic' : 'released', battery });
    if (!validators.observation(payload)) throw new Error(`observation schema: ${JSON.stringify(validators.observation.errors)}`);
    const checked = await model('observation', payload);
    if (!checked.ok) throw new Error(`gateway model rejected observation: ${checked.error}`);
    const container = `${rootOf(deviceId)}/${kind === 'telemetry' ? 'observation' : kind}`;
    const written = await nativeCreate(container, `obs-${gateway.gatewayId}-${deviceId}-${keyring.bootId}-${payload.sequence}-${kind}`, payload);
    return { ...written, payload, modelCheck: checked.implementation, payloadHash: checked.payloadHash };
  }

  async function close() {
    for (const path of subscriptions.keys()) await http.request('DELETE', path).catch(() => {});
    await notifications.close();
    bridge?.close();
  }

  return { ae, provisioning, emit, close, writes, notificationStats: notifications.stats, modelImplementation: bridge?.implementation ?? 'json-schema-fallback' };
}

// Child-process entry: node gateway-emulator.mjs <config.json>, controlled over IPC.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolvePath(process.argv[1])) {
  const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
  const send = (message) => process.send?.(message);
  try {
    const emulator = await startGatewayEmulator(config, { report: send });
    send({ type: 'ready', ae: emulator.ae, provisioning: emulator.provisioning, modelImplementation: emulator.modelImplementation });
    process.on('message', async (message) => {
      if (message?.type === 'emit') {
        try { send({ type: 'emitted', id: message.id, result: await emulator.emit(message) }); }
        catch (error) { send({ type: 'emitted', id: message.id, error: error.message }); }
      } else if (message?.type === 'stats') {
        send({ type: 'stats', id: message.id, writes: emulator.writes.length, notifications: emulator.notificationStats });
      } else if (message?.type === 'stop') {
        await emulator.close(); send({ type: 'stopped' }); process.exit(0);
      }
    });
  } catch (error) { send({ type: 'fatal', message: error.message }); process.exit(1); }
}
