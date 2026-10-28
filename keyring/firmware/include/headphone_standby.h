#pragma once
#include <atomic>
#include <stddef.h>
#include <stdint.h>

// MAX9850 quiet-state management only. Does not implement headphone playback.
class HeadphoneStandby {
public:
  using Read = bool (*)(uint8_t, uint8_t, uint8_t *, size_t);
  using Write = bool (*)(uint8_t, uint8_t, uint8_t);
  void begin(Read read, Write write);
  bool poll(uint64_t now);
  bool prepareSleep();
  bool speakerAllowed() const;
  const char *status() const;
private:
  enum class State { Unmanaged, Unknown, Off, I2cError, Mismatch } state = State::Unknown;
  bool readControls(uint8_t &general, uint8_t &volume, uint8_t &enable);
  bool forceOff();
  Read readRegister = nullptr;
  Write writeRegister = nullptr;
  std::atomic<bool> configuredOff{false};
  uint64_t nextCheck = 0;
};
