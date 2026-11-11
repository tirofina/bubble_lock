#pragma once
#include <atomic>
#include <stddef.h>
#include <stdint.h>

// MAX9850 shutdown and optional PCM control. Playback owns I2C control until finishPlayback.
class HeadphoneStandby {
public:
  using Read = bool (*)(uint8_t, uint8_t, uint8_t *, size_t);
  using Write = bool (*)(uint8_t, uint8_t, uint8_t);
  void begin(Read read, Write write);
  bool poll(uint64_t now);
  bool prepareSleep();
  bool speakerAllowed() const;
  bool audioAllowed() const;
  bool beginPlayback(bool (*permit)(void *), void *context);
  bool checkPlayback();
  bool finishPlayback();
  const char *status() const;
private:
  enum class State { Unmanaged, Unknown, Off, I2cError, Mismatch, Preparing, Playing };
  std::atomic<State> state{State::Unknown};
  bool readControls(uint8_t &general, uint8_t &volume, uint8_t &enable);
  bool forceOff();
  Read readRegister = nullptr;
  Write writeRegister = nullptr;
  std::atomic<bool> configuredOff{false};
  std::atomic<bool> playbackOwned{false};
  std::atomic<bool> controlBusy{false};
  bool writeChecked(uint8_t reg, uint8_t value);
  uint64_t nextCheck = 0;
};
