-- KEYRING integration candidate for durable Mobius4 receipt notifications.
CREATE TABLE IF NOT EXISTS privacy_bubble.keyring_receipt_notification (
    cse_key TEXT COLLATE "C" NOT NULL,
    native_ref TEXT COLLATE "C" NOT NULL,
    state TEXT NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING', 'SETTLED', 'REVIEW')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    lease_token UUID,
    lease_until TIMESTAMPTZ,
    last_result TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (cse_key, native_ref),
    CHECK (cse_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'),
    CHECK (native_ref ~ '^(/[A-Za-z0-9][A-Za-z0-9._-]{0,127}){2,8}/gw-[a-f0-9]{64}$'),
    CHECK (last_result IS NULL OR last_result ~ '^[A-Z][A-Z0-9_]{0,79}$'),
    CHECK ((lease_token IS NULL) = (lease_until IS NULL)),
    CHECK (state = 'PENDING' OR lease_token IS NULL)
);

CREATE INDEX IF NOT EXISTS keyring_receipt_notification_pending_idx
    ON privacy_bubble.keyring_receipt_notification (next_attempt_at, created_at)
    WHERE state = 'PENDING';
