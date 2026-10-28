#pragma once
#include <stdint.h>
#include <stddef.h>

class MotionWake {
public:
  using Read = bool (*)(uint8_t, uint8_t, uint8_t *, size_t);
  using Write = bool (*)(uint8_t, uint8_t, uint8_t);
  bool begin(bool accelerometerReady, Read read, Write write);
  bool poll(uint64_t now);
  bool clearForSleep();
  bool ready() const { return configured; }
  uint32_t events() const { return count; }
private:
  bool update(uint8_t reg, uint8_t mask, uint8_t value);
  bool clear(uint8_t &source);
  Read readRegister = nullptr;
  Write writeRegister = nullptr;
  bool configured = false;
  uint32_t count = 0;
  uint64_t nextPoll = 0;
};
