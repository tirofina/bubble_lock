#pragma once
#include <stdint.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include "headphone_standby.h"

// Selected speaker/headphone PCM cue follows an already-authorized GPIO pulse.
// The GPIO readback contract remains about the motor, not acoustic measurements.
class AudioAlert {
public:
  using Permit = bool (*)();
  bool begin(Permit allow, HeadphoneStandby *headphone = nullptr);
  bool startUntil(uint64_t deadlineMs);
  void stop(); // GPIO mute + short critical section only; safe in the ESP timer task.
  bool busy();
  const char *status();
private:
  static void entry(void *context);
  static bool dacPermit(void *context);
  void run();
  bool current(uint32_t token, uint64_t &deadlineMs, bool unmute);
  void fail();
  portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED;
  TaskHandle_t worker = nullptr;
  Permit outputAllowed = nullptr;
  HeadphoneStandby *dac = nullptr;
  uint32_t workerToken = 0;
  bool configured = false, fault = false, armed = false, running = false;
  uint64_t deadline = 0;
  uint32_t generation = 0;
};
