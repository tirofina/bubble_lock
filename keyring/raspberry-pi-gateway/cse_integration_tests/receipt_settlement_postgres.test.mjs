import assert from 'node:assert/strict';
import test from 'node:test';
import { createPostgresSettlementCommit } from '../../integration-candidate/receipt-settlement-postgres.mjs';

const key = ['gw-a', 'cmd-a'];
const candidate = { version: 1, gatewayId: key[0], commandId: key[1], deviceId: 'kr-a', readbackState: true,
  payloadHash: 'a'.repeat(64), receiptSha256: 'b'.repeat(64), nativeResourceId: 'cin-a',
  nativeStoredAt: '2026-11-10T09:00:04.000Z', authorizationEventId: 'evt-authorized' };

function fixture({ inserted = [], winner = [], failCommit = false, failRollback = false } = {}) {
  const statements = [];
  const released = [];
  const client = {
    async query(sql, params) {
      const kind = sql.trimStart().split(/\s+/)[0];
      statements.push(kind);
      if (kind === 'BEGIN') assert.equal(sql, 'BEGIN ISOLATION LEVEL READ COMMITTED');
      if (kind === 'SET') assert.equal(sql, 'SET LOCAL synchronous_commit = on');
      if (kind === 'INSERT') {
        assert.match(sql, /ON CONFLICT \(gateway_id, command_id\) DO NOTHING/);
        assert.deepEqual(params, [...key, JSON.stringify(candidate)]);
        return { rows: inserted };
      }
      if (kind === 'SELECT') {
        assert.deepEqual(params, key);
        return { rows: winner };
      }
      if (kind === 'COMMIT' && failCommit) throw new Error('commit response lost');
      if (kind === 'ROLLBACK' && failRollback) throw new Error('connection closed');
      return { command: kind };
    },
    release(discard) { released.push(discard); },
  };
  return { commit: createPostgresSettlementCommit({ connect: async () => client }), statements, released };
}

test('returns a new settlement only after commit', async () => {
  const { commit, statements, released } = fixture({ inserted: [{ settlement: candidate }] });
  assert.deepEqual(await commit(key, candidate), { created: true, record: candidate });
  assert.deepEqual(statements, ['BEGIN', 'SET', 'INSERT', 'COMMIT']);
  assert.deepEqual(released, [false]);
});

test('returns the original writer record through a fresh statement on conflict', async () => {
  const original = { ...candidate, receiptSha256: 'c'.repeat(64) };
  const { commit, statements } = fixture({ winner: [{ settlement: original }] });
  assert.deepEqual(await commit(key, candidate), { created: false, record: original });
  assert.deepEqual(statements, ['BEGIN', 'SET', 'INSERT', 'SELECT', 'COMMIT']);
});

test('a lost commit reply rejects and destroys a connection that cannot roll back', async () => {
  const { commit, statements, released } = fixture({ inserted: [{ settlement: candidate }],
    failCommit: true, failRollback: true });
  await assert.rejects(commit(key, candidate), /commit response lost/);
  assert.deepEqual(statements, ['BEGIN', 'SET', 'INSERT', 'COMMIT', 'ROLLBACK']);
  assert.deepEqual(released, [true]);
});

test('an absent winner and a mismatched key never return success', async () => {
  const { commit, statements } = fixture();
  await assert.rejects(commit(['other', key[1]], candidate), /SETTLEMENT_KEY_MISMATCH/);
  assert.deepEqual(statements, []);
  await assert.rejects(commit(key, candidate), /SETTLEMENT_ROW_UNAVAILABLE/);
  assert.deepEqual(statements, ['BEGIN', 'SET', 'INSERT', 'SELECT', 'ROLLBACK']);
});
