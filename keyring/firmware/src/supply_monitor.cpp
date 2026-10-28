#include <esp_timer.h>
#include "supply_monitor.h"
#include "board_r18.h"
#include "firmware_options.h"

namespace {
constexpr uint16_t Calibration = 0x4000;
// 16V bus, +/-80mV shunt, bus/shunt 12-bit, single-shot both. Not BOM's shunt-only mode.
constexpr uint16_t Standby = 0x0998;
constexpr uint16_t Trigger = Standby | 3;
constexpr uint16_t ConfigurationMask = 0x3ff8;
constexpr uint64_t ConversionTimeoutMs = 100, RetryMs = 5000;
constexpr uint64_t MaxAgeMs = static_cast<uint64_t>(KEYRING_POWER_SAMPLE_MS) * 2 + 100;
uint64_t nowMs() { return static_cast<uint64_t>(esp_timer_get_time()) / 1000; }
int32_t rounded(int64_t value, int64_t divisor) {
  return static_cast<int32_t>(value >= 0 ? (value + divisor / 2) / divisor : -((-value + divisor / 2) / divisor));
}
}

void SupplyMonitor::begin(Read read, Write write) {
  readRegister = read; writeRegister = write;
  sample = {}; configured = waiting = false; nextAt = 0; state = "disabled";
  if (!KEYRING_ENABLE_POWER_MONITOR) return;
  configure(nowMs());
}
bool SupplyMonitor::readWord(uint8_t reg, uint16_t &value) {
  uint8_t data[2] = {};
  if (!readRegister || !readRegister(board::PowerMonitorAddress, reg, data, 2)) return false;
  value = (static_cast<uint16_t>(data[0]) << 8) | data[1];
  return true;
}
bool SupplyMonitor::standby() {
  uint16_t config = 0;
  return writeRegister && writeRegister(board::PowerMonitorAddress, 0x00, Standby) &&
      readWord(0x00, config) && (config & 0x3fff) == Standby;
}
bool SupplyMonitor::configure(uint64_t now) {
  uint16_t calibration = 0;
  if (!standby() || !writeRegister(board::PowerMonitorAddress, 0x05, Calibration) ||
      !readWord(0x05, calibration) || calibration != Calibration) {
    fail("configuration_error", now); return false;
  }
  configured = true; waiting = false; state = "waiting"; nextAt = now;
  return true;
}
void SupplyMonitor::fail(const char *reason, uint64_t now) {
  // A single best-effort stop, followed by bounded backoff. No I2C bus scan/reset.
  standby();
  sample = {}; configured = false; waiting = false; state = reason; nextAt = now + RetryMs;
}
void SupplyMonitor::invalid(const char *reason, uint64_t now) {
  sample = {}; waiting = false;
  if (!standby()) { fail("shutdown_error", now); return; }
  state = reason; nextAt = now + KEYRING_POWER_SAMPLE_MS;
}
bool SupplyMonitor::valid(uint64_t now) const {
  return sample.valid && now >= sample.readAt && now - sample.readAt <= MaxAgeMs;
}
const char *SupplyMonitor::status(uint64_t now) const {
  return sample.valid && !valid(now) ? "stale" : state;
}
void SupplyMonitor::poll(uint64_t now) {
  if (!KEYRING_ENABLE_POWER_MONITOR) return;
  if (!configured) {
    if (now >= nextAt) configure(now);
    return;
  }
  if (!waiting) {
    if (now < nextAt) return;
    // Refresh calibration for each shot so a chip reset cannot masquerade as zero current.
    if (!writeRegister(board::PowerMonitorAddress, 0x05, Calibration) ||
        !writeRegister(board::PowerMonitorAddress, 0x00, Trigger)) {
      fail("i2c_error", now); return;
    }
    const uint64_t started = nowMs();
    waiting = true; deadline = started + ConversionTimeoutMs; nextCheck = started + 2;
    if (!sample.valid) state = "sampling";
    return; // No delay/polling loop while the converter is running.
  }
  if (now >= deadline) { fail("conversion_timeout", now); return; }
  if (now < nextCheck) return;
  uint16_t bus = 0, shunt = 0, current = 0, calibration = 0, config = 0;
  if (!readWord(0x02, bus)) { fail("i2c_error", now); return; }
  if (!(bus & 0x0002)) { nextCheck = now + 2; return; } // CNVR from Bus Voltage.
  if (bus & 0x0001) { invalid("overflow", now); return; }
  if (!readWord(0x01, shunt) || !readWord(0x04, current) || !readWord(0x05, calibration) ||
      !readWord(0x00, config)) { fail("i2c_error", now); return; }
  if (calibration != Calibration || (config & ConfigurationMask) != Standby) {
    fail("configuration_changed", now); return;
  }
  const int16_t rawShunt = static_cast<int16_t>(shunt);
  const int16_t rawCurrent = static_cast<int16_t>(current);
  // Math OVF alone cannot detect clipping at the selected PGA range.
  if (rawShunt <= -8000 || rawShunt >= 8000 || (bus >> 3) >= 4000) {
    invalid("overrange", now); return;
  }
  if (static_cast<int32_t>(rawCurrent) != static_cast<int32_t>(rawShunt) * 4) {
    fail("inconsistent", now); return;
  }
  if (!standby()) { fail("shutdown_error", now); return; }
  Reading next;
  next.valid = true; next.shuntUv = static_cast<int32_t>(rawShunt) * 10;
  next.busMv = (bus >> 3) * 4;
  // Current_LSB = 0.04096 / (0x4000 * Rshunt), rounded to integer microamperes.
  next.currentUa = rounded(static_cast<int64_t>(rawCurrent) * 2500, KEYRING_POWER_SHUNT_MILLIOHMS);
  // Signed load-side power derived from this single-shot bus/current pair, not battery input power.
  next.loadPowerUw = rounded(static_cast<int64_t>(next.busMv) * next.currentUa, 1000);
  next.readAt = nowMs();
  sample = next; waiting = false; state = "ok"; nextAt = next.readAt + KEYRING_POWER_SAMPLE_MS;
}
bool SupplyMonitor::prepareSleep() {
  if (!KEYRING_ENABLE_POWER_MONITOR) return true;
  if (waiting || !configured) return false;
  if (!standby()) { fail("shutdown_error", nowMs()); return false; }
  return true;
}
