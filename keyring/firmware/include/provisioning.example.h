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
// Optional MAX98357A cue accompanying an already-authorized motor pulse.
// #define KEYRING_ENABLE_AUDIO 1
// #define KEYRING_AUDIO_FREQUENCY 880
// #define KEYRING_AUDIO_AMPLITUDE 512
// One physical panel per device; both controller profiles are supported in source.
// 0 = disabled, 1 = ST7789 1.54 inch 240x240, 2 = JD9853 2.01 inch candidate 240x296.
// #define KEYRING_DISPLAY_PROFILE 1
// #define KEYRING_LCD_ROTATION 0
// #define KEYRING_LCD_X_OFFSET 0
// #define KEYRING_LCD_Y_OFFSET 0
// #define KEYRING_LCD_SHOW_MS 5000UL
// JD9853 geometry comes from user panel evidence and remains physically unverified.
// #define KEYRING_JD9853_WIDTH 240
// #define KEYRING_JD9853_HEIGHT 296
// #define KEYRING_JD9853_BGR 0
// #define KEYRING_JD9853_INVERT 1
// Optional plaintext receipt copies; use only an explicitly provisioned, protected card.
// #define KEYRING_ENABLE_SD_LOG 1
// #define KEYRING_SD_MAX_BYTES 1048576UL
// r18 INA219 monitor is enabled by default. These are nominal settings, not measured calibration.
// #define KEYRING_ENABLE_POWER_MONITOR 1
// #define KEYRING_POWER_SAMPLE_MS 2000UL
// #define KEYRING_POWER_SHUNT_MILLIOHMS 100
