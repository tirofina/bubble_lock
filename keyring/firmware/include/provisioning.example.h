#pragma once
// Copy to provisioning.h locally. Supply a different six-digit passkey per unit.
// Zero is intentionally invalid; there is no shared factory passkey.
#define KEYRING_PASSKEY 0
// Optional immutable device ID, ASCII [A-Za-z0-9][A-Za-z0-9._:-]*, <=64 bytes.
// Without this override, identity is derived from the chip eFuse MAC.
// #define KEYRING_DEVICE_ID "keyring-your-inventory-id"
