#pragma once
// Copy to provisioning.h locally. Supply a different six-digit passkey per unit.
// Zero is intentionally invalid; there is no shared factory passkey.
#define KEYRING_PASSKEY 0
// Optional immutable device ID, ASCII [A-Za-z0-9][A-Za-z0-9._:-]*, <=64 bytes.
// Without this override, identity is derived from the chip eFuse MAC.
// #define KEYRING_DEVICE_ID "keyring-your-inventory-id"
// Optional: sleep changes BLE availability; enable only for a selected deployment.
// #define KEYRING_ENABLE_SLEEP 1
// #define KEYRING_IDLE_SLEEP_MS 60000UL
// #define KEYRING_SLEEP_POLL_MS 30000UL
// Sensor threshold in FS/64 units and duration in ODR cycles; tune on real hardware.
// #define KEYRING_WAKE_THRESHOLD 8
// #define KEYRING_WAKE_DURATION 1
