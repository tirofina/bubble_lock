CREATE SCHEMA IF NOT EXISTS privacy_bubble;

CREATE TABLE IF NOT EXISTS privacy_bubble.runtime_state (
  namespace TEXT PRIMARY KEY,
  version BIGINT NOT NULL DEFAULT 0 CHECK (version >= 0),
  state JSONB NOT NULL CHECK (jsonb_typeof(state) = 'object'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS privacy_bubble.runtime_commit (
  namespace TEXT NOT NULL REFERENCES privacy_bubble.runtime_state(namespace),
  version BIGINT NOT NULL,
  lock_key TEXT NOT NULL,
  writer_id TEXT NOT NULL,
  state_sha256 TEXT NOT NULL,
  committed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(namespace, version)
);
CREATE TABLE IF NOT EXISTS privacy_bubble.runtime_receipt_outbox (
  namespace TEXT NOT NULL REFERENCES privacy_bubble.runtime_state(namespace),
  receipt_id TEXT NOT NULL,
  receipt JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  delivered_at TIMESTAMPTZ,
  PRIMARY KEY(namespace, receipt_id)
);
CREATE INDEX IF NOT EXISTS runtime_receipt_pending ON privacy_bubble.runtime_receipt_outbox(namespace, created_at) WHERE delivered_at IS NULL;
CREATE TABLE IF NOT EXISTS privacy_bubble.runtime_claim (
  namespace TEXT NOT NULL,
  command_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  grant_revision BIGINT NOT NULL,
  ownership_epoch BIGINT NOT NULL,
  payload_hash TEXT NOT NULL,
  body JSONB NOT NULL,
  PRIMARY KEY(namespace, command_id, member_id),
  UNIQUE(namespace, claim_id)
);
CREATE TABLE IF NOT EXISTS privacy_bubble.runtime_policy (
  namespace TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  approval_hash TEXT NOT NULL,
  body JSONB NOT NULL,
  PRIMARY KEY(namespace, principal_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS privacy_bubble.runtime_fl_commit (
  namespace TEXT NOT NULL,
  task_id TEXT NOT NULL,
  round_id TEXT NOT NULL,
  base_model_version BIGINT NOT NULL,
  model_hash TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  PRIMARY KEY(namespace, task_id, round_id, base_model_version)
);
CREATE TABLE IF NOT EXISTS privacy_bubble.runtime_model_pointer (
  namespace TEXT NOT NULL,
  task_id TEXT NOT NULL,
  model_version BIGINT NOT NULL,
  serving_generation BIGINT NOT NULL,
  coordinator_epoch BIGINT NOT NULL,
  consent_policy_revision BIGINT NOT NULL,
  state TEXT NOT NULL,
  body JSONB NOT NULL,
  PRIMARY KEY(namespace, task_id)
);
CREATE TABLE IF NOT EXISTS privacy_bubble.runtime_delivery_outbox (
  namespace TEXT NOT NULL,
  channel TEXT NOT NULL,
  item_id TEXT NOT NULL,
  status TEXT NOT NULL,
  body JSONB NOT NULL,
  PRIMARY KEY(namespace, channel, item_id)
);
