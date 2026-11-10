-- KEYRING integration candidate for the CORE companion database (DOC-REV 2.0.0).
-- Apply after CORE has provisioned the privacy_bubble schema.
CREATE TABLE IF NOT EXISTS privacy_bubble.keyring_command_settlement (
    gateway_id TEXT COLLATE "C" NOT NULL,
    command_id TEXT COLLATE "C" NOT NULL,
    settlement JSONB NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (gateway_id, command_id),
    CHECK (gateway_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'),
    CHECK (command_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'),
    CHECK (
        jsonb_typeof(settlement) = 'object'
        AND settlement @> '{"version":1}'::jsonb
        AND ((settlement->>'gatewayId') COLLATE "C") IS NOT DISTINCT FROM gateway_id
        AND ((settlement->>'commandId') COLLATE "C") IS NOT DISTINCT FROM command_id
        AND jsonb_typeof(settlement->'readbackState') IS NOT DISTINCT FROM 'boolean'
        AND COALESCE(settlement->>'payloadHash', '') ~ '^[a-f0-9]{64}$'
        AND COALESCE(settlement->>'receiptSha256', '') ~ '^[a-f0-9]{64}$'
        AND octet_length(settlement::text) <= 8192
    )
);
