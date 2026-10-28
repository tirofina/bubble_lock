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
#ifndef KEYRING_ENABLE_AUDIO
#define KEYRING_ENABLE_AUDIO 0
#endif
#ifndef KEYRING_AUDIO_FREQUENCY
#define KEYRING_AUDIO_FREQUENCY 880
#endif
#ifndef KEYRING_AUDIO_AMPLITUDE
#define KEYRING_AUDIO_AMPLITUDE 512
#endif
#ifndef KEYRING_DISPLAY_PROFILE
#define KEYRING_DISPLAY_PROFILE 0 // 0 disabled, 1 ST7789 240x240, 2 JD9853 240x296 candidate
#endif
#ifndef KEYRING_LCD_ROTATION
#define KEYRING_LCD_ROTATION 0
#endif
#ifndef KEYRING_LCD_X_OFFSET
#define KEYRING_LCD_X_OFFSET 0
#endif
#ifndef KEYRING_LCD_Y_OFFSET
#define KEYRING_LCD_Y_OFFSET 0
#endif
#ifndef KEYRING_LCD_SHOW_MS
#define KEYRING_LCD_SHOW_MS 5000UL
#endif
#ifndef KEYRING_LCD_SPI_HZ
#define KEYRING_LCD_SPI_HZ 10000000UL
#endif
#ifndef KEYRING_JD9853_WIDTH
#define KEYRING_JD9853_WIDTH 240
#endif
#ifndef KEYRING_JD9853_HEIGHT
#define KEYRING_JD9853_HEIGHT 296
#endif
#ifndef KEYRING_JD9853_BGR
#define KEYRING_JD9853_BGR 0
#endif
#ifndef KEYRING_JD9853_INVERT
#define KEYRING_JD9853_INVERT 1
#endif
#ifndef KEYRING_ENABLE_SD_LOG
#define KEYRING_ENABLE_SD_LOG 0
#endif
#ifndef KEYRING_SD_MAX_BYTES
#define KEYRING_SD_MAX_BYTES 1048576UL
#endif
#ifndef KEYRING_ENABLE_POWER_MONITOR
#define KEYRING_ENABLE_POWER_MONITOR 1
#endif
#ifndef KEYRING_POWER_SAMPLE_MS
#define KEYRING_POWER_SAMPLE_MS 2000UL
#endif
#ifndef KEYRING_POWER_SHUNT_MILLIOHMS
#define KEYRING_POWER_SHUNT_MILLIOHMS 100
#endif

// Configuration errors fail at build time; this task does not run a build.
static_assert(KEYRING_ENABLE_SLEEP == 0 || KEYRING_ENABLE_SLEEP == 1, "Sleep option must be 0 or 1");
static_assert(KEYRING_IDLE_SLEEP_MS >= 10000UL && KEYRING_IDLE_SLEEP_MS <= 3600000UL, "Idle sleep range is 10s..1h");
static_assert(KEYRING_SLEEP_POLL_MS >= 1000UL && KEYRING_SLEEP_POLL_MS <= 300000UL, "Sleep timer range is 1s..5min");
static_assert(KEYRING_WAKE_THRESHOLD >= 1 && KEYRING_WAKE_THRESHOLD <= 63, "LIS2DW12 WK_THS is six bits");
static_assert(KEYRING_WAKE_DURATION >= 0 && KEYRING_WAKE_DURATION <= 3, "LIS2DW12 WAKE_DUR is two bits");
static_assert(KEYRING_ENABLE_AUDIO == 0 || KEYRING_ENABLE_AUDIO == 1, "Audio option must be 0 or 1");
static_assert(KEYRING_AUDIO_FREQUENCY >= 100 && KEYRING_AUDIO_FREQUENCY <= 4000, "Cue frequency range is 100..4000Hz");
static_assert(KEYRING_AUDIO_AMPLITUDE >= 0 && KEYRING_AUDIO_AMPLITUDE <= 2048, "Cue amplitude range is 0..2048 PCM counts");
static_assert(KEYRING_DISPLAY_PROFILE >= 0 && KEYRING_DISPLAY_PROFILE <= 2, "Choose a fitted display profile");
static_assert(KEYRING_LCD_ROTATION >= 0 && KEYRING_LCD_ROTATION <= 3, "LCD rotation range is 0..3");
static_assert(KEYRING_LCD_X_OFFSET >= 0 && KEYRING_LCD_X_OFFSET <= 255 && KEYRING_LCD_Y_OFFSET >= 0 && KEYRING_LCD_Y_OFFSET <= 255, "LCD offsets are unsigned bytes");
static_assert(KEYRING_LCD_SHOW_MS >= 1000 && KEYRING_LCD_SHOW_MS <= 30000, "Backlight window range is 1..30s");
static_assert(KEYRING_LCD_SPI_HZ >= 1000000 && KEYRING_LCD_SPI_HZ <= 20000000, "LCD SPI range is 1..20MHz");
static_assert(KEYRING_JD9853_WIDTH > 0 && KEYRING_JD9853_WIDTH <= 240 && KEYRING_JD9853_HEIGHT > 0 && KEYRING_JD9853_HEIGHT <= 320, "JD9853 portrait geometry must fit controller RAM");
static_assert(KEYRING_JD9853_BGR == 0 || KEYRING_JD9853_BGR == 1, "BGR option must be 0 or 1");
static_assert(KEYRING_JD9853_INVERT == 0 || KEYRING_JD9853_INVERT == 1, "Inversion option must be 0 or 1");
static_assert(KEYRING_ENABLE_SD_LOG == 0 || KEYRING_ENABLE_SD_LOG == 1, "SD log option must be 0 or 1");
static_assert(KEYRING_SD_MAX_BYTES >= 4096 && KEYRING_SD_MAX_BYTES <= 16777216UL, "SD receipt cap range is 4KiB..16MiB");
static_assert(KEYRING_ENABLE_POWER_MONITOR == 0 || KEYRING_ENABLE_POWER_MONITOR == 1, "Power monitor option must be 0 or 1");
static_assert(KEYRING_POWER_SAMPLE_MS >= 100 && KEYRING_POWER_SAMPLE_MS <= 60000UL, "Power sample interval range is 100ms..60s");
static_assert(KEYRING_POWER_SHUNT_MILLIOHMS >= 10 && KEYRING_POWER_SHUNT_MILLIOHMS <= 1000, "Nominal sense resistor range is 10..1000 milliohm");
