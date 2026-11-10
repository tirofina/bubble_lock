const reasonPattern = /^[A-Z][A-Z0-9_]{0,79}$/;
const safeReason = (reason, fallback) => typeof reason === 'string' && reasonPattern.exec(reason)?.[0] === reason
  ? reason : fallback;

/** resolveSettlement selects a fixed authenticated CSE adapter by its configured key. */
export function createReceiptNotificationWorker({ inbox, resolveSettlement, maxAttempts = 12, leaseSeconds = 60 }) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100
      || !Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 3600) {
    throw new Error('INVALID_RECEIPT_WORKER_LIMITS');
  }

  return async function drainOne() {
    const job = await inbox.claim(leaseSeconds);
    if (!job) return { status: 'IDLE' };

    let outcome;
    if (job.attempts > maxAttempts) {
      outcome = { status: 'REVIEW', reason: 'RETRY_LIMIT' };
    } else {
      try {
        const settle = await resolveSettlement(job.cseKey);
        outcome = settle ? await settle({ nativeRef: job.nativeRef }) : { status: 'REVIEW', reason: 'UNKNOWN_CSE' };
      } catch {
        outcome = { status: 'WAITING_FOR_NATIVE', reason: 'SETTLEMENT_UNAVAILABLE' };
      }
    }
    let completion;
    if (['SETTLED', 'ALREADY_SETTLED'].includes(outcome?.status)) {
      completion = { state: 'SETTLED', reason: outcome.status };
    } else if (outcome?.status === 'WAITING_FOR_NATIVE' && job.attempts < maxAttempts) {
      completion = { state: 'PENDING', reason: safeReason(outcome.reason, 'WAITING_FOR_NATIVE'),
        delaySeconds: Math.min(300, 5 * 2 ** (job.attempts - 1)) };
    } else if (outcome?.status === 'WAITING_FOR_NATIVE') {
      completion = { state: 'REVIEW', reason: 'RETRY_LIMIT' };
    } else {
      completion = { state: 'REVIEW', reason: safeReason(outcome?.reason, 'INVALID_SETTLEMENT_OUTCOME') };
    }
    if (!await inbox.finish(job, completion)) return { status: 'LEASE_LOST' };
    return { status: completion.state, reason: completion.reason };
  };
}
