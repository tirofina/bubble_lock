#pragma once
#if __has_include("provisioning.h")
#include "provisioning.h"
#endif
#ifndef KEYRING_PASSKEY
#define KEYRING_PASSKEY 0
#endif
#ifndef KEYRING_ENABLE_SLEEP
#define KEYRING_ENABLE_SLEEP 0
#endif
#ifndef KEYRING_IDLE_SLEEP_MS
#define KEYRING_IDLE_SLEEP_MS 60000UL
#endif
#ifndef KEYRING_SLEEP_POLL_MS
#define KEYRING_SLEEP_POLL_MS 30000UL
#endif
#ifndef KEYRING_WAKE_THRESHOLD
#define KEYRING_WAKE_THRESHOLD 8
#endif
#ifndef KEYRING_WAKE_DURATION
#define KEYRING_WAKE_DURATION 1
#endif

// Configuration errors fail at build time; this task does not run a build.
static_assert(KEYRING_ENABLE_SLEEP == 0 || KEYRING_ENABLE_SLEEP == 1, "Sleep option must be 0 or 1");
static_assert(KEYRING_IDLE_SLEEP_MS >= 10000UL && KEYRING_IDLE_SLEEP_MS <= 3600000UL, "Idle sleep range is 10s..1h");
static_assert(KEYRING_SLEEP_POLL_MS >= 1000UL && KEYRING_SLEEP_POLL_MS <= 300000UL, "Sleep timer range is 1s..5min");
static_assert(KEYRING_WAKE_THRESHOLD >= 1 && KEYRING_WAKE_THRESHOLD <= 63, "LIS2DW12 WK_THS is six bits");
static_assert(KEYRING_WAKE_DURATION >= 0 && KEYRING_WAKE_DURATION <= 3, "LIS2DW12 WAKE_DUR is two bits");
