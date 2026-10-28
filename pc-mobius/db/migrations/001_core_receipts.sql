-- Privacy Bubble PC-MOBIUS-CORE receipt and dispatch schema.
-- Target: PostgreSQL 15+ / Mobius4 companion database.

CREATE SCHEMA IF NOT EXISTS privacy_bubble;

CREATE TABLE IF NOT EXISTS privacy_bubble.gateway_event (
    event_id            BIGSERIAL PRIMARY KEY,
    gateway_id          TEXT NOT NULL,
    device_id           TEXT NOT NULL,
    sequence_no         BIGINT NOT NULL CHECK (sequence_no >= 0),
    event_timestamp     TIMESTAMPTZ NOT NULL,
    state               BOOLEAN NOT NULL,
    battery_pct         SMALLINT NOT NULL CHECK (battery_pct BETWEEN 0 AND 100),
    rssi_dbm            SMALLINT NOT NULL CHECK (rssi_dbm BETWEEN -127 AND 0),
    schema_version      TEXT NOT NULL,
    dedup_key           TEXT GENERATED ALWAYS AS (device_id || ':' || sequence_no::TEXT) STORED,
    one_m2m_resource    TEXT NOT NULL,
    transport           TEXT NOT NULL CHECK (transport IN ('http', 'mqtt')),
    processing_status   TEXT NOT NULL CHECK (processing_status IN ('RECEIVED', 'IN_FLIGHT', 'APPLIED', 'REVIEW')),
    request_id          TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (device_id, sequence_no)
);

CREATE INDEX IF NOT EXISTS gateway_event_status_idx
    ON privacy_bubble.gateway_event (processing_status, created_at DESC);

CREATE TABLE IF NOT EXISTS privacy_bubble.command_dispatch (
    dispatch_id         BIGSERIAL PRIMARY KEY,
    group_id            TEXT,
    command_id          TEXT NOT NULL,
    member_id           TEXT NOT NULL,
    gateway_id          TEXT NOT NULL,
    device_id           TEXT NOT NULL,
    desired_state       BOOLEAN NOT NULL,
    epoch               BIGINT NOT NULL CHECK (epoch >= 0),
    deadline            TIMESTAMPTZ,
    attempt_no          INTEGER NOT NULL DEFAULT 1 CHECK (attempt_no > 0),
    dispatch_status     TEXT NOT NULL CHECK (dispatch_status IN ('RESERVED', 'DISPATCHED', 'IN_FLIGHT', 'APPLIED', 'REVIEW', 'SETTLED')),
    command_timestamp   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ack_timestamp       TIMESTAMPTZ,
    readback_state      BOOLEAN,
    UNIQUE (command_id, member_id)
);

CREATE INDEX IF NOT EXISTS command_dispatch_group_idx
    ON privacy_bubble.command_dispatch (group_id, command_timestamp DESC);

CREATE TABLE IF NOT EXISTS privacy_bubble.receipt_journal (
    receipt_id          BIGSERIAL PRIMARY KEY,
    receipt_type        TEXT NOT NULL CHECK (receipt_type IN ('TELEMETRY', 'COMMAND', 'ACK', 'ONEM2M_RESPONSE', 'GROUP_SUMMARY')),
    correlation_id      TEXT NOT NULL,
    status              TEXT NOT NULL,
    response_status     INTEGER,
    payload             JSONB NOT NULL,
    receipt_hash        CHAR(64) NOT NULL,
    recorded_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (receipt_type, correlation_id, receipt_hash)
);

CREATE INDEX IF NOT EXISTS receipt_journal_correlation_idx
    ON privacy_bubble.receipt_journal (correlation_id, recorded_at DESC);

CREATE TABLE IF NOT EXISTS privacy_bubble.onem2m_binding (
    binding_id          BIGSERIAL PRIMARY KEY,
    cse_id              TEXT NOT NULL,
    resource_path       TEXT NOT NULL,
    container_definition TEXT NOT NULL,
    wire_envelope       TEXT NOT NULL,
    transport           TEXT NOT NULL CHECK (transport IN ('http', 'mqtt')),
    rvi                 TEXT NOT NULL,
    originator          TEXT NOT NULL,
    contract_revision   TEXT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (cse_id, resource_path, transport)
);

INSERT INTO privacy_bubble.onem2m_binding
    (cse_id, resource_path, container_definition, wire_envelope, transport, rvi, originator, contract_revision)
VALUES
    ('Mobius4', '/Mobius/privacy-bubble-test-ae/bubbleState', 'org.onem2m.common.moduleclass.binarySwitch', 'pb:binarySwitch', 'http', '4', 'pb-core-admin-local', '2.0.0'),
    ('Mobius4', '/Mobius/privacy-bubble-test-ae/bubbleState', 'org.onem2m.common.moduleclass.binarySwitch', 'pb:binarySwitch', 'mqtt', '4', 'pb-core-admin-local', '2.0.0')
ON CONFLICT (cse_id, resource_path, transport) DO UPDATE
SET container_definition = EXCLUDED.container_definition,
    wire_envelope = EXCLUDED.wire_envelope,
    rvi = EXCLUDED.rvi,
    originator = EXCLUDED.originator,
    contract_revision = EXCLUDED.contract_revision;
