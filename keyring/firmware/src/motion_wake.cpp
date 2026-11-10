#include <Arduino.h>
#include "motion_wake.h"
#include "board_r18.h"
#include "firmware_options.h"

namespace {
// ST LIS2DW12 DS11811 Rev9 sections 8.6/8.7/8.24/8.25/8.28/8.31/8.35.
constexpr uint8_t Ctrl3 = 0x22, Ctrl4 = 0x23, WakeThreshold = 0x34;
constexpr uint8_t WakeDuration = 0x35, WakeSource = 0x38, AllSource = 0x3b, Ctrl7 = 0x3f;
}

bool MotionWake::update(uint8_t reg, uint8_t mask, uint8_t value) {
  uint8_t previous = 0, actual = 0;
  if (!readRegister(board::AccelAddress, reg, &previous, 1)) return false;
  const uint8_t next = (previous & static_cast<uint8_t>(~mask)) | (value & mask);
  return writeRegister(board::AccelAddress, reg, next) &&
      readRegister(board::AccelAddress, reg, &actual, 1) && (actual & mask) == (next & mask);
}

bool MotionWake::clear(uint8_t &source) {
  uint8_t all = 0;
  return readRegister(board::AccelAddress, WakeSource, &source, 1) &&
      readRegister(board::AccelAddress, AllSource, &all, 1);
}

bool MotionWake::begin(bool accelerometerReady, Read read, Write write) {
  readRegister = read; writeRegister = write;
  configured = false;
  if (!accelerometerReady || !read || !write) return false;
  // Disable routing while preparing it; retain unrelated register bits.
  bool ok = update(Ctrl4, 0x20, 0) &&
      update(Ctrl3, 0x38, 0x10) && // push-pull, active-high, latched interrupt
      update(WakeThreshold, 0x7f, KEYRING_WAKE_THRESHOLD) && // SLEEP_ON=0; no automatic sensor ODR switching
      update(WakeDuration, 0x60, KEYRING_WAKE_DURATION << 5) &&
      update(Ctrl7, 0x20, 0x20); // INTERRUPTS_ENABLE
  uint8_t source = 0;
  configured = ok && clear(source) && update(Ctrl4, 0x20, 0x20); // INT1_WU only
  if (!configured) {
    // Best effort disables an incomplete route. The CPU will not arm motion sleep.
    update(Ctrl4, 0x20, 0);
  }
  return configured;
}

bool MotionWake::poll(uint64_t now) {
  if (!configured || now < nextPoll) return false;
  nextPoll = now + 25;
  if (digitalRead(board::AccelInterrupt) != HIGH) return false;
  uint8_t source = 0;
  if (!clear(source)) { configured = false; return false; }
  if (!(source & 0x08)) return false;
  if (count != UINT32_MAX) ++count;
  return true;
}

bool MotionWake::clearForSleep() {
  if (!configured) return false;
  uint8_t source = 0;
  if (!clear(source)) { configured = false; return false; }
  // Do not discard a just-arrived movement in order to enter sleep.
  if (source & 0x08) {
    if (count != UINT32_MAX) ++count;
    return false;
  }
  return digitalRead(board::AccelInterrupt) == LOW;
}
