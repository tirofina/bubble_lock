const ACCEPTED_ONE_M2M_STATUS = new Set([200, 204]);

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
  if (!Number.isInteger(payload.sequence) || payload.sequence < 0) throw new Error('Gateway sequence uses uint32');
  if (typeof payload.state !== 'boolean') throw new Error('Gateway state uses boolean');
  if (!Number.isInteger(payload.batteryPct) || payload.batteryPct < 0 || payload.batteryPct > 100) {
    throw new Error('Gateway batteryPct uses uint8');
  }
  if (!Number.isInteger(payload.rssiDbm)) throw new Error('Gateway rssiDbm uses int8');
  return payload;
}

function requireAckShape(payload) {
  const required = ['deviceId', 'commandId', 'ackState', 'timestamp'];
  const missing = required.filter((key) => payload?.[key] === undefined);
  if (missing.length > 0) throw new Error(`Gateway ACK fields required: ${missing.join(', ')}`);
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
    this.pendingOneM2M = new Map();
    this.receipts = [];
    this.ackListeners = new Set();
    this.messageListenerAttached = false;
  }

  async start() {
    await this.mqttClient.subscribe(this.telemetryTopic, { qos: 1 });
    await this.mqttClient.subscribe(this.ackTopic, { qos: 1 });
    if (this.oneM2MTransport === 'mqtt') await this.mqttClient.subscribe(this.oneM2MResponseTopic, { qos: 1 });
    if (!this.messageListenerAttached) {
      this.mqttClient.on('message', (topic, message) => {
        this.handleMessage(topic, message).catch((error) => {
          this.recordReceipt({ status: 'REVIEW', transport: 'mqtt', topic, error: error.message, timestamp: this.clock() });
        });
      });
      this.messageListenerAttached = true;
    }
    return { status: 'READY', telemetryTopic: this.telemetryTopic, ackTopic: this.ackTopic, listenerAttached: this.messageListenerAttached };
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
      op: 2,
      to: this.resourcePath,
      fr: this.originator,
      rqi: requestId,
      pc: { 'pb:binarySwitch': { state: payload.state } }
    };
    try {
      await this.mqttClient.publish(this.oneM2MRequestTopic, JSON.stringify(primitive), { qos: 1, retain: false });
    } catch (error) {
      this.inFlightTelemetry.delete(dedupKey);
      return this.recordReceipt({ status: 'REVIEW', dedupKey, requestId, transport: 'oneM2M-mqtt', error: error.message, timestamp: this.clock() });
    }
    this.pendingOneM2M.set(requestId, { dedupKey, payload, requestId });
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
    const applied = [2000, 2001, 2004, 2005].includes(responseCode);
    if (applied) {
      this.seenTelemetry.add(pending.dedupKey);
      while (this.seenTelemetry.size > this.maxDedupEntries) this.seenTelemetry.delete(this.seenTelemetry.values().next().value);
    }
    this.inFlightTelemetry.delete(pending.dedupKey);
    return this.recordReceipt({
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
  }

  async handleAck(rawPayload) {
    const payload = requireAckShape(decodePayload(rawPayload));
    const receipt = {
      contractId: 'privacy-bubble.raspberrypi-gateway',
      contractVersion: '1.0.0',
      docRevision: '2.0.0',
      gatewayId: this.gatewayId,
      deviceId: payload.deviceId,
      commandId: payload.commandId,
      ackState: payload.ackState,
      status: 'ACK_RECORDED',
      timestamp: this.clock(),
      payload
    };
    this.ackByCommand.set(payload.commandId, receipt);
    this.pendingCommands.delete(payload.commandId);
    const persisted = await this.recordReceipt(receipt);
    for (const listener of this.ackListeners) await listener(persisted);
    return persisted;
  }

  onAck(listener) {
    if (typeof listener !== 'function') throw new Error('GatewayBridge ACK listener uses a function');
    this.ackListeners.add(listener);
    return () => this.ackListeners.delete(listener);
  }

  async sendCommand({ deviceId, state, commandId, deadline, epoch }) {
    if (typeof state !== 'boolean') throw new Error('Gateway command state uses boolean');
    if (!commandId) throw new Error('Gateway commandId is required');
    const payload = { deviceId, commandId, desiredState: state, deadline, epoch, issuedAt: this.clock() };
    await this.mqttClient.publish(this.commandTopic, JSON.stringify(payload), { qos: 1, retain: false });
    const receipt = {
      contractId: 'privacy-bubble.raspberrypi-gateway',
      contractVersion: '1.0.0',
      docRevision: '2.0.0',
      gatewayId: this.gatewayId,
      commandId,
      deviceId,
      status: 'DISPATCHED',
      topic: this.commandTopic,
      timestamp: this.clock(),
      payload
    };
    this.pendingCommands.set(commandId, receipt);
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

export { requireAckShape, requireTelemetryShape };
