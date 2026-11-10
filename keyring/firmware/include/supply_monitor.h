#pragma once
#include <stdint.h>
#include <stddef.h>

// Main-loop-only INA219 access; shares Wire with fuel gauge and accelerometer.
class SupplyMonitor {
public:
  using Read = bool (*)(uint8_t, uint8_t, uint8_t *, size_t);
  using Write = bool (*)(uint8_t, uint8_t, uint16_t);
  struct Reading {
    bool valid = false;
    int32_t shuntUv = 0, currentUa = 0, loadPowerUw = 0;
    uint16_t busMv = 0;
    uint64_t readAt = 0;
  };
  void begin(Read read, Write write);
  void poll(uint64_t now);
  bool busy() const { return waiting; }
  bool prepareSleep();
  bool valid(uint64_t now) const;
  const char *status(uint64_t now) const;
  const Reading &reading() const { return sample; }
private:
  bool readWord(uint8_t reg, uint16_t &value);
  bool standby();
  bool configure(uint64_t now);
  void fail(const char *reason, uint64_t now);
  void invalid(const char *reason, uint64_t now);
  Read readRegister = nullptr;
  Write writeRegister = nullptr;
  Reading sample;
  const char *state = "disabled";
  bool configured = false, waiting = false;
  uint64_t nextAt = 0, nextCheck = 0, deadline = 0;
};
