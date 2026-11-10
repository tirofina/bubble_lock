import { startReplayServer } from './sse.ts';

const receiptFile = process.env['RECEIPT_FILE'];
const service = await startReplayServer(receiptFile === undefined ? {} : { receiptFile });
console.log(`SIMULATED ${service.replay.source}: ${service.url} (${service.replay.lastSequence} events). No authentication; roleScope is metadata.`);
const stop = () => {
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);
  void service.close();
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
