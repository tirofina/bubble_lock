-- First durable delivery per path, separate from the worker's mutable queue state.
CREATE TABLE IF NOT EXISTS privacy_bubble.keyring_receipt_delivery (
    cse_key TEXT COLLATE "C" NOT NULL,
    native_ref TEXT COLLATE "C" NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('CSE_CALLBACK', 'RECOVERY_SWEEP')),
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    queued_new BOOLEAN NOT NULL,
    PRIMARY KEY (cse_key, native_ref, source),
    FOREIGN KEY (cse_key, native_ref)
        REFERENCES privacy_bubble.keyring_receipt_notification (cse_key, native_ref)
);

CREATE UNIQUE INDEX IF NOT EXISTS keyring_receipt_delivery_first_queue_idx
    ON privacy_bubble.keyring_receipt_delivery (cse_key, native_ref) WHERE queued_new;
