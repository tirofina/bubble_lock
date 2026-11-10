const ACCEPTED_ONE_M2M_STATUS = new Set([200, 204]);
const ACK_STATES = new Set(['RECEIVED', 'FORWARDED', 'APPLIED', 'READBACK_VERIFIED', 'RETRY_PENDING']);
const COMMAND_KEYS = ['version', 'gatewayId', 'deviceId', 'commandId', 'claimId', 'desiredState', 'issuedAt', 'deadline', 'grantRevision', 'ownershipEpoch'];
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

function mqttTo(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || /[?#%\\]/.test(path)
      || path.replace(/\/$/, '').slice(1).split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('oneM2M resourcePath requires a valid HTTP resource path');
  }
  if (path.startsWith('/~/')) return path.slice(2).replace(/\/$/, '');
  if (path.startsWith('/_/')) return `/${path.slice(2)}`.replace(/\/$/, '');
  return path.slice(1).replace(/\/$/, '');
}

function canonicalCommand(input, gatewayId, issuedAt) {
  const isCanonical = input.version !== undefined;
  const hasAuthorization = isCanonical || input.claimId !== undefined || input.grantRevision !== undefined;
  if (!hasAuthorization) return null; // Legacy emulator payload remains available.
  if (isCanonical && (Object.keys(input).length !== COMMAND_KEYS.length || COMMAND_KEYS.some((key) => !(key in input)))) {
    throw new Error('Gateway command fields must match keyring command schema');
  }
  const command = isCanonical ? input : {
    version: 1, gatewayId, deviceId: input.deviceId, commandId: input.commandId, claimId: input.claimId,
    desiredState: { state: input.state }, issuedAt: input.issuedAt ?? issuedAt, deadline: input.deadline,
    grantRevision: input.grantRevision, ownershipEpoch: input.ownershipEpoch ?? input.epoch
  };
  if (command.version !== 1 || command.gatewayId !== gatewayId) throw new Error('Gateway command identity mismatch');
  for (const key of ['gatewayId', 'deviceId', 'commandId', 'claimId']) {
    if (typeof command[key] !== 'string' || !ID.test(command[key])) throw new Error(`Gateway command requires valid ${key}`);
  }
  if (!command.desiredState || Object.keys(command.desiredState).length !== 1 || typeof command.desiredState.state !== 'boolean') {
    throw new Error('Gateway desiredState requires a boolean state');
  }
  for (const [key, minimum] of [['grantRevision', 1], ['ownershipEpoch', 0]]) {
    if (!Number.isInteger(command[key]) || command[key] < minimum || command[key] > 2147483647) throw new Error(`Gateway command requires valid ${key}`);
  }
  for (const key of ['issuedAt', 'deadline']) {
    if (typeof command[key] !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/.test(command[key]) || !Number.isFinite(Date.parse(command[key]))) {
      throw new Error(`Gateway command requires RFC3339 ${key}`);
    }
  }
  if (Date.parse(command.deadline) <= Date.parse(command.issuedAt)) throw new Error('Gateway deadline must follow issuedAt');
  return Object.fromEntries(COMMAND_KEYS.map((key) => [key, key === 'desiredState' ? { state: command.desiredState.state } : command[key]]));
}

function decodePayload(payload) {
  if (Buffer.isBuffer(payload)) return JSON.parse(payload.toString('utf8'));
  if (typeof payload === 'string') return JSON.parse(payload);
  return payload;
}

function topicFor(template, gatewayId) {
  return template.replaceAll('{gatewayId}', gatewayId);
}

function requireTelemetryShape(payload) {
  const required = ['deviceId', 'sequence', 'timestamp', 'state', 'batteryPct', 'rssiDbm', 'schemaVersion'];
  const missing = required.filter((key) => payload?.[key] === undefined);
  if (missing.length > 0) throw new Error(`Gateway telemetry fields required: ${missing.join(', ')}`);
  if (!Number.isInteger(payload.sequence) || payload.sequence < 0 || payload.sequence > 4294967295) throw new Error('Gateway sequence uses uint32');
  if (typeof payload.state !== 'boolean') throw new Error('Gateway state uses boolean');
  if (!Number.isInteger(payload.batteryPct) || payload.batteryPct < 0 || payload.batteryPct > 100) {
    throw new Error('Gateway batteryPct uses uint8');
  }
  if (!Number.isInteger(payload.rssiDbm) || payload.rssiDbm < -127 || payload.rssiDbm > 20) throw new Error('Gateway rssiDbm uses -127..20');
  if (payload.schemaVersion !== '1.0.0') throw new Error('Gateway schemaVersion requires 1.0.0');
  if (typeof payload.timestamp !== 'string' || !Number.isFinite(Date.parse(payload.timestamp))) throw new Error('Gateway timestamp requires RFC3339');
  return payload;
}

function requireAckShape(payload) {
  const required = ['deviceId', 'commandId', 'ackState', 'timestamp'];
  const missing = required.filter((key) => payload?.[key] === undefined);
  if (missing.length > 0) throw new Error(`Gateway ACK fields required: ${missing.join(', ')}`);
  if (!ACK_STATES.has(payload.ackState)) throw new Error('Gateway ackState requires a recognized state');
  return payload;
}

export class GatewayBridge {
  constructor({
    mqttClient,
    fetchImpl = globalThis.fetch,
    baseUrl,
    originator,
    rvi = '4',
    resourcePath = '/Mobius/privacy-bubble-test-ae/bubbleState',
    telemetryTopic = 'privacy-bubble/gateway/{gatewayId}/telemetry',
    commandTopic = 'privacy-bubble/gateway/{gatewayId}/command',
    ackTopic = 'privacy-bubble/gateway/{gatewayId}/ack',
    gatewayId = 'pi-gateway-local',
    clock = () => new Date().toISOString(),
    maxDedupEntries = 4096,
    receiptJournal = null,
    oneM2MTransport = 'http',
    cseId = 'Mobius4',
    oneM2MRequestTopic = '/oneM2M/req/{originator}/{cseId}/json',
    oneM2MResponseTopic = '/oneM2M/resp/{originator}/{cseId}/json'
  }) {
    if (!mqttClient) throw new Error('GatewayBridge requires an MQTT client');
    if (typeof fetchImpl !== 'function') throw new Error('GatewayBridge requires an HTTP fetch implementation');
    this.mqttClient = mqttClient;
    this.fetchImpl = fetchImpl;
    this.baseUrl = baseUrl?.replace(/\/$/, '');
    this.originator = originator;
    this.rvi = String(rvi);
    this.resourcePath = resourcePath;
    if (!['http', 'mqtt'].includes(oneM2MTransport)) throw new Error('oneM2M transport uses http or mqtt');
    this.oneM2MTransport = oneM2MTransport;
    this.cseId = cseId;
    this.telemetryTopic = topicFor(telemetryTopic, gatewayId);
    this.commandTopic = topicFor(commandTopic, gatewayId);
    this.ackTopic = topicFor(ackTopic, gatewayId);
    this.oneM2MRequestTopic = oneM2MRequestTopic.replaceAll('{originator}', this.originator).replaceAll('{cseId}', this.cseId);
    this.oneM2MResponseTopic = oneM2MResponseTopic.replaceAll('{originator}', this.originator).replaceAll('{cseId}', this.cseId);
    this.gatewayId = gatewayId;
    this.clock = clock;
    this.maxDedupEntries = maxDedupEntries;
    this.receiptJournal = receiptJournal;
    this.seenTelemetry = new Set();
    this.inFlightTelemetry = new Set();
    this.ackByCommand = new Map();
    this.pendingCommands = new Map();
    this.commandPayloads = new Map();
    this.pendingOneM2M = new Map();
    this.receipts = [];
    this.ackListeners = new Set();
    this.messageListenerAttached = false;
  }

  async start() {
    if (!this.messageListenerAttached) {
      this.mqttClient.on('message', (topic, message) => {
        return this.handleMessage(topic, message).catch((error) => {
          return this.recordReceipt({ status: 'REVIEW', transport: 'mqtt', topic, error: error.message, timestamp: this.clock() });
        });
      });
      this.messageListenerAttached = true;
    }
    await this.mqttCall('subscribe', this.telemetryTopic, { qos: 1 });
    await this.mqttCall('subscribe', this.ackTopic, { qos: 1 });
    if (this.oneM2MTransport === 'mqtt') await this.mqttCall('subscribe', this.oneM2MResponseTopic, { qos: 1 });
    return { status: 'READY', telemetryTopic: this.telemetryTopic, ackTopic: this.ackTopic, listenerAttached: this.messageListenerAttached };
  }

  async mqttCall(method, ...args) {
    const operation = this.mqttClient[`${method}Async`] ?? this.mqttClient[method];
    return operation.apply(this.mqttClient, args);
  }

  async handleMessage(topic, message) {
    if (topic === this.telemetryTopic) return this.handleTelemetry(decodePayload(message));
    if (topic === this.ackTopic) return this.handleAck(decodePayload(message));
    if (topic === this.oneM2MResponseTopic) return this.handleOneM2MResponse(decodePayload(message));
    return { status: 'IGNORED', topic, timestamp: this.clock() };
  }

  async handleTelemetry(rawPayload) {
    const payload = requireTelemetryShape(decodePayload(rawPayload));
    const dedupKey = `${payload.deviceId}:${payload.sequence}`;
    if (this.seenTelemetry.has(dedupKey)) {
      const duplicate = { status: 'DUPLICATE', dedupKey, transport: 'mqtt', timestamp: this.clock() };
      return this.recordReceipt(duplicate);
    }
    if (this.inFlightTelemetry.has(dedupKey)) {
      const inFlight = { status: 'IN_FLIGHT', dedupKey, transport: 'mqtt', timestamp: this.clock() };
      return this.recordReceipt(inFlight);
    }
    this.inFlightTelemetry.add(dedupKey);

    if (this.oneM2MTransport === 'mqtt') return this.handleTelemetryMqtt(payload, dedupKey);

    const requestId = `pb-${this.gatewayId}-${payload.deviceId}-${payload.sequence}`.replace(/[^a-zA-Z0-9_-]/g, '_');
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${this.resourcePath}`, {
        method: 'PUT',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-M2M-RVI': this.rvi,
          'X-M2M-Origin': this.originator,
          'X-M2M-RI': requestId,
          'Idempotency-Key': requestId
        },
        body: JSON.stringify({ 'pb:binarySwitch': { state: payload.state } })
      });
    } catch (error) {
      this.inFlightTelemetry.delete(dedupKey);
      const transportReview = { status: 'REVIEW', dedupKey, requestId, transport: 'oneM2M-http', error: error.message, timestamp: this.clock() };
      return this.recordReceipt(transportReview);
    }
    const bodyText = await response.text();
    const applied = ACCEPTED_ONE_M2M_STATUS.has(response.status);
    if (applied) {
      this.seenTelemetry.add(dedupKey);
      while (this.seenTelemetry.size > this.maxDedupEntries) this.seenTelemetry.delete(this.seenTelemetry.values().next().value);
    }
    this.inFlightTelemetry.delete(dedupKey);
    const receipt = {
      contractId: 'privacy-bubble.raspberrypi-gateway',
      contractVersion: '1.0.0',
      docRevision: '2.0.0',
      gatewayId: this.gatewayId,
      deviceId: payload.deviceId,
      sequence: payload.sequence,
      dedupKey,
      requestId,
      oneM2MResource: this.resourcePath,
      responseStatus: response.status,
      status: applied ? 'APPLIED' : 'REVIEW',
      timestamp: this.clock(),
      payload,
      responseBody: bodyText
    };
    return this.recordReceipt(receipt);
  }

  async handleTelemetryMqtt(payload, dedupKey) {
    const requestId = `pb-${this.gatewayId}-${payload.deviceId}-${payload.sequence}`.replace(/[^a-zA-Z0-9_-]/g, '_');
    const primitive = {
      op: 3,
      to: mqttTo(this.resourcePath),
      fr: this.originator,
      rqi: requestId,
      rvi: this.rvi,
      pc: { 'pb:binarySwitch': { state: payload.state } }
    };
    const pending = { dedupKey, payload, requestId, receipt: null };
    this.pendingOneM2M.set(requestId, pending);
    try {
      await this.mqttCall('publish', this.oneM2MRequestTopic, JSON.stringify(primitive), { qos: 1, retain: false });
    } catch (error) {
      this.pendingOneM2M.delete(requestId);
      this.inFlightTelemetry.delete(dedupKey);
      return this.recordReceipt({ status: 'REVIEW', dedupKey, requestId, transport: 'oneM2M-mqtt', error: error.message, timestamp: this.clock() });
    }
    if (pending.receipt) return pending.receipt;
    return this.recordReceipt({
      contractId: 'privacy-bubble.raspberrypi-gateway',
      contractVersion: '1.0.0',
      docRevision: '2.0.0',
      gatewayId: this.gatewayId,
      deviceId: payload.deviceId,
      sequence: payload.sequence,
      dedupKey,
      requestId,
      oneM2MResource: this.resourcePath,
      transport: 'oneM2M-mqtt',
      status: 'MQTT_DISPATCHED',
      timestamp: this.clock(),
      payload
    });
  }

  async handleOneM2MResponse(rawPrimitive) {
    const primitive = decodePayload(rawPrimitive);
    const requestId = primitive.rqi ?? primitive['m2m:rsp']?.rqi;
    const responseCode = Number(primitive.rsc ?? primitive['m2m:rsp']?.rsc);
    const pending = this.pendingOneM2M.get(requestId);
    if (!pending) return this.recordReceipt({ status: 'REVIEW', transport: 'oneM2M-mqtt', requestId, responseStatus: responseCode, timestamp: this.clock() });
    this.pendingOneM2M.delete(requestId);
    const applied = responseCode === 2004;
    if (applied) {
      this.seenTelemetry.add(pending.dedupKey);
      while (this.seenTelemetry.size > this.maxDedupEntries) this.seenTelemetry.delete(this.seenTelemetry.values().next().value);
    }
    this.inFlightTelemetry.delete(pending.dedupKey);
    pending.receipt = await this.recordReceipt({
      contractId: 'privacy-bubble.raspberrypi-gateway',
      contractVersion: '1.0.0',
      docRevision: '2.0.0',
      gatewayId: this.gatewayId,
      deviceId: pending.payload.deviceId,
      sequence: pending.payload.sequence,
      dedupKey: pending.dedupKey,
      requestId,
      oneM2MResource: this.resourcePath,
      transport: 'oneM2M-mqtt',
      responseStatus: responseCode,
      status: applied ? 'APPLIED' : 'REVIEW',
      timestamp: this.clock(),
      payload: pending.payload
    });
    return pending.receipt;
  }

  async handleAck(rawPayload) {
    const payload = requireAckShape(decodePayload(rawPayload));
    const pending = this.pendingCommands.get(payload.commandId);
    const previous = this.ackByCommand.get(payload.commandId);
    const expected = pending?.payload ?? this.commandPayloads.get(payload.commandId);
    const mismatch = !expected || payload.deviceId !== expected.deviceId
      || (payload.gatewayId !== undefined && payload.gatewayId !== this.gatewayId)
      || (payload.ownershipEpoch !== undefined && payload.ownershipEpoch !== (expected.ownershipEpoch ?? expected.epoch))
      || (payload.grantRevision !== undefined && payload.grantRevision !== expected.grantRevision)
      || (payload.ackState === 'READBACK_VERIFIED' && payload.readback !== undefined
        && (typeof payload.readback === 'boolean' ? payload.readback : payload.readback?.state) !== (expected.desiredState?.state ?? expected.desiredState));
    if (mismatch) return this.recordReceipt({ status: 'REVIEW', commandId: payload.commandId, deviceId: payload.deviceId, reason: 'ack-command-binding', timestamp: this.clock(), payload });
    if (previous?.ackState === 'READBACK_VERIFIED') return previous;
    const receipt = {
      contractId: 'privacy-bubble.raspberrypi-gateway', contractVersion: '1.0.0', docRevision: '2.0.0',
      gatewayId: this.gatewayId, deviceId: payload.deviceId, commandId: payload.commandId,
      ackState: payload.ackState, status: 'ACK_RECORDED', timestamp: this.clock(), payload
    };
    const persisted = await this.recordReceipt(receipt);
    this.ackByCommand.set(payload.commandId, persisted);
    if (payload.ackState === 'READBACK_VERIFIED') this.pendingCommands.delete(payload.commandId);
    for (const listener of this.ackListeners) await listener(persisted);
    return persisted;
  }

  onAck(listener) {
    if (typeof listener !== 'function') throw new Error('GatewayBridge ACK listener uses a function');
    this.ackListeners.add(listener);
    return () => this.ackListeners.delete(listener);
  }

  async sendCommand(input) {
    const { deviceId, commandId, deadline, epoch, state } = input;
    const existing = this.pendingCommands.get(commandId);
    const issuedAt = input.issuedAt ?? existing?.payload.issuedAt ?? this.clock();
    const payload = canonicalCommand(input, this.gatewayId, issuedAt)
      ?? { deviceId, commandId, desiredState: state, deadline, epoch, issuedAt };
    if (typeof (payload.desiredState?.state ?? payload.desiredState) !== 'boolean') throw new Error('Gateway command state uses boolean');
    if (!commandId) throw new Error('Gateway commandId is required');
    if (existing && JSON.stringify(existing.payload) !== JSON.stringify(payload)) throw new Error('Gateway commandId already binds another payload');
    const receipt = {
      contractId: 'privacy-bubble.raspberrypi-gateway', contractVersion: '1.0.0', docRevision: '2.0.0',
      gatewayId: this.gatewayId, commandId, deviceId, status: 'DISPATCHED', topic: this.commandTopic,
      timestamp: this.clock(), payload
    };
    // An application ACK can arrive before the broker publish promise resolves.
    this.commandPayloads.set(commandId, payload);
    this.pendingCommands.set(commandId, receipt);
    try {
      await this.mqttCall('publish', this.commandTopic, JSON.stringify(payload), { qos: 1, retain: false });
    } catch (error) {
      if (this.pendingCommands.get(commandId) === receipt) {
        if (existing) this.pendingCommands.set(commandId, existing);
        else this.pendingCommands.delete(commandId);
      }
      throw error;
    }
    return this.recordReceipt(receipt);
  }

  async recordReceipt(receipt) {
    const persisted = this.receiptJournal ? await this.receiptJournal.append(receipt) : receipt;
    this.receipts.push(persisted);
    return persisted;
  }

  getReceiptSnapshot() {
    return { receipts: [...this.receipts], pendingCommands: [...this.pendingCommands.keys()], acknowledgedCommands: [...this.ackByCommand.keys()] };
  }
}

export { requireAckShape, requireTelemetryShape, canonicalCommand, mqttTo };
