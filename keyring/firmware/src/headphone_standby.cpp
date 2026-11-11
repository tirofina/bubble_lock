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
bool HeadphoneStandby::audioAllowed() const {
  return speakerAllowed() || (KEYRING_AUDIO_OUTPUT == 2 && playbackOwned.load(std::memory_order_acquire));
}
const char *HeadphoneStandby::status() const {
  switch (state.load(std::memory_order_acquire)) {
    case State::Unmanaged: return "unmanaged";
    case State::Off: return "configured_off";
    case State::I2cError: return "i2c_error";
    case State::Mismatch: return "register_mismatch";
    case State::Preparing: return "pcm_preparing";
    case State::Playing: return "pcm_playing";
    default: return "unknown";
  }
}
bool HeadphoneStandby::writeChecked(uint8_t reg, uint8_t value) {
  uint8_t observed = 0;
  return writeRegister && readRegister && writeRegister(board::HeadphoneAddress, reg, value)
    && readRegister(board::HeadphoneAddress, reg, &observed, 1) && observed == value;
}
bool HeadphoneStandby::beginPlayback(bool (*permit)(void *), void *context) {
  if (!KEYRING_ENABLE_AUDIO || KEYRING_AUDIO_OUTPUT != 2 || !permit || !permit(context)) return false;
  bool expected = false;
  if (!controlBusy.compare_exchange_strong(expected, true)) return false;
  playbackOwned.store(true, std::memory_order_release);
  configuredOff.store(false, std::memory_order_release);
  state = State::Preparing;
  // Rev4 Tables 5/16-22: slave 16kHz, ICLK=MCLK=256fs=4.096MHz,
  // INT=1 and NLSB=16; charge pump uses its independent 667kHz oscillator.
  const uint8_t registers[][2] = {
    {General, 0}, {Volume, QuietVolume}, {Enable, 0}, {0x04, 0},
    {0x06, 0}, {0x07, 0}, {0x08, 0x80}, {0x09, 0x10}, {0x0a, 0x08},
    {Enable, 0xfd} // SHDN/MCLKEN/CPEN/HPEN/LNOEN/DACEN; line inputs stay off.
  };
  for (const auto &entry : registers) {
    if (!permit(context) || !writeChecked(entry[0], entry[1])) { finishPlayback(); return false; }
  }
  const uint64_t readyBy = nowMs() + 50;
  bool ready = false;
  while (permit(context) && nowMs() < readyBy) {
    uint8_t a = 0, b = 0;
    if (!readRegister(board::HeadphoneAddress, 0, &a, 1) || !readRegister(board::HeadphoneAddress, 1, &b, 1)) break;
    if (a & 0x03) break; // Latched left/right overcurrent.
    // Status register definitions (p23) define SHP/SLO/SDAC active-low.
    if ((a & 0x30) == 0x30 && (b & 0x0d) == 0) { ready = true; break; }
    delay(1);
  }
  if (!ready || !permit(context) || !writeChecked(Volume, KEYRING_HEADPHONE_VOLUME)) { finishPlayback(); return false; }
  state = State::Playing;
  return true;
}
bool HeadphoneStandby::checkPlayback() {
  uint8_t a = 0, b = 0, enable = 0, volume = 0;
  return playbackOwned.load(std::memory_order_acquire) && readRegister
    && readRegister(board::HeadphoneAddress, 0, &a, 1) && (a & 0x33) == 0x30
    && readRegister(board::HeadphoneAddress, 1, &b, 1) && (b & 0x0d) == 0
    && readRegister(board::HeadphoneAddress, Enable, &enable, 1) && enable == 0xfd
    && readRegister(board::HeadphoneAddress, Volume, &volume, 1) && volume == KEYRING_HEADPHONE_VOLUME;
}
bool HeadphoneStandby::finishPlayback() {
  if (!playbackOwned.load(std::memory_order_acquire)) return speakerAllowed();
  const bool quiet = forceOff();
  playbackOwned.store(false, std::memory_order_release);
  controlBusy.store(false, std::memory_order_release);
  return quiet;
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
  bool expected = false;
  if (!controlBusy.compare_exchange_strong(expected, true)) return false;
  const State previous = state.load();
  bool repaired = false;
  if (configuredOff.load(std::memory_order_acquire)) {
    uint8_t general = 0, volume = 0, enable = 0;
    if (!readControls(general, volume, enable) || general != 0 || volume != QuietVolume || enable != 0) {
      repaired = true; forceOff();
    }
  } else forceOff();
  nextCheck = nowMs() + CheckIntervalMs;
  controlBusy.store(false, std::memory_order_release);
  return repaired || previous != state.load();
}
bool HeadphoneStandby::prepareSleep() {
  if (!KEYRING_MANAGE_HEADPHONE_STANDBY) return true;
  bool expected = false;
  if (!controlBusy.compare_exchange_strong(expected, true)) return false;
  const bool quiet = forceOff();
  controlBusy.store(false, std::memory_order_release);
  return quiet;
}
