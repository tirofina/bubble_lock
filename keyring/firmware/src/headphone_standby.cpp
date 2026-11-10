#include <Arduino.h>
#include <esp_timer.h>
#include "board_r18.h"
#include "firmware_options.h"
#include "headphone_standby.h"

namespace {
constexpr uint8_t General = 0x03, Volume = 0x02, Enable = 0x05;
constexpr uint8_t QuietVolume = 0xbf; // MUTE=1, SLEW=0, VOL=0x3f full attenuation.
constexpr uint64_t CheckIntervalMs = 5000;
uint64_t nowMs() { return static_cast<uint64_t>(esp_timer_get_time()) / 1000; }
}

void HeadphoneStandby::begin(Read read, Write write) {
  readRegister = read; writeRegister = write;
  configuredOff.store(false, std::memory_order_release);
  if (!KEYRING_MANAGE_HEADPHONE_STANDBY) { state = State::Unmanaged; return; }
  forceOff(); nextCheck = nowMs() + CheckIntervalMs;
}
bool HeadphoneStandby::speakerAllowed() const {
  return !KEYRING_MANAGE_HEADPHONE_STANDBY || configuredOff.load(std::memory_order_acquire);
}
const char *HeadphoneStandby::status() const {
  switch (state) {
    case State::Unmanaged: return "unmanaged";
    case State::Off: return "configured_off";
    case State::I2cError: return "i2c_error";
    case State::Mismatch: return "register_mismatch";
    default: return "unknown";
  }
}
bool HeadphoneStandby::readControls(uint8_t &general, uint8_t &volume, uint8_t &enable) {
  if (!readRegister) return false;
  // Separate calls: do not rely on another IC's register auto-increment behavior.
  const bool g = readRegister(board::HeadphoneAddress, General, &general, 1);
  if (!g || general != 0) configuredOff.store(false, std::memory_order_release);
  const bool v = readRegister(board::HeadphoneAddress, Volume, &volume, 1);
  if (!v || volume != QuietVolume) configuredOff.store(false, std::memory_order_release);
  const bool e = readRegister(board::HeadphoneAddress, Enable, &enable, 1);
  if (!e || enable != 0) configuredOff.store(false, std::memory_order_release);
  return g && v && e;
}
bool HeadphoneStandby::forceOff() {
  configuredOff.store(false, std::memory_order_release);
  if (!readRegister || !writeRegister) { state = State::I2cError; return false; }
  // Clear zero-cross detection before requesting immediate full attenuation.
  // GPIO is NC on r18; other general-purpose settings remain at their default zero.
  const bool g = writeRegister(board::HeadphoneAddress, General, 0);
  const bool v = writeRegister(board::HeadphoneAddress, Volume, QuietVolume);
  uint8_t previousEnable = 0;
  const bool previousRead = readRegister(board::HeadphoneAddress, Enable, &previousEnable, 1);
  // Disable headphone/line/DAC first. Never introduce an enable bit that was not read as set.
  const bool outputs = writeRegister(board::HeadphoneAddress, Enable, previousRead ? previousEnable & 0xf0 : 0);
  delayMicroseconds(60); // Main-loop shutdown sequence, not an actuator deadline guarantee.
  // Always attempt global shutdown even if an earlier transfer failed.
  const bool shutdown = writeRegister(board::HeadphoneAddress, Enable, 0);
  uint8_t general = 0, volume = 0, enable = 0;
  const bool readback = readControls(general, volume, enable);
  if (!g || !v || !previousRead || !outputs || !shutdown || !readback) { state = State::I2cError; return false; }
  if (general != 0 || volume != QuietVolume || enable != 0) { state = State::Mismatch; return false; }
  state = State::Off;
  configuredOff.store(true, std::memory_order_release);
  return true;
}
bool HeadphoneStandby::poll(uint64_t now) {
  if (!KEYRING_MANAGE_HEADPHONE_STANDBY || now < nextCheck) return false;
  const State previous = state;
  bool repaired = false;
  if (configuredOff.load(std::memory_order_acquire)) {
    uint8_t general = 0, volume = 0, enable = 0;
    if (!readControls(general, volume, enable) || general != 0 || volume != QuietVolume || enable != 0) {
      repaired = true; forceOff();
    }
  } else forceOff();
  nextCheck = nowMs() + CheckIntervalMs;
  return repaired || previous != state;
}
bool HeadphoneStandby::prepareSleep() {
  return !KEYRING_MANAGE_HEADPHONE_STANDBY || forceOff();
}
