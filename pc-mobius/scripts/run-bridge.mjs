import mqtt from 'mqtt';
import { GatewayBridge } from '../src/gateway-bridge.mjs';
import { ReceiptJournal } from '../src/receipt-journal.mjs';

const gatewayId = process.env.MOBIUS4_GATEWAY_ID ?? 'pi-gateway-local';
const mqttUrl = process.env.MOBIUS4_MQTT_URL ?? 'mqtt://127.0.0.1:1883';
const baseUrl = process.env.MOBIUS4_URL ?? 'http://127.0.0.1:7599';
const originator = process.env.MOBIUS4_ORIGINATOR ?? 'pb-core-admin-local';
const receiptPath = process.env.MOBIUS4_RECEIPT_PATH ?? './receipts/gateway-bridge.jsonl';
const oneM2MTransport = process.env.MOBIUS4_ONEM2M_TRANSPORT ?? 'http';
const cseId = process.env.MOBIUS4_CSE_ID ?? 'Mobius4';
const client = mqtt.connect(mqttUrl, { clientId: `pb-core-${gatewayId}`, clean: true, reconnectPeriod: 2000 });
const bridge = new GatewayBridge({ mqttClient: client, baseUrl, originator, gatewayId, cseId, oneM2MTransport, receiptJournal: new ReceiptJournal(receiptPath) });

client.on('connect', async () => {
  const ready = await bridge.start();
  console.log(JSON.stringify({ status: 'READY', mqttUrl, baseUrl, receiptPath, oneM2MTransport, ...ready }));
});
client.on('error', (error) => console.error(JSON.stringify({ status: 'REVIEW', component: 'mqtt', message: error.message })));
