#pragma once
#include <stdint.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

// Optional MAX98357A speaker cue. Only an already-authorized GPIO pulse calls startUntil.
// The GPIO readback contract remains about the motor, not acoustic measurements.
class AudioAlert {
public:
  using Permit = bool (*)();
  bool begin(Permit allow);
  bool startUntil(uint64_t deadlineMs);
  void stop(); // GPIO mute + short critical section only; safe in the ESP timer task.
  bool busy();
  const char *status();
private:
  static void entry(void *context);
  void run();
  bool current(uint32_t token, uint64_t &deadlineMs, bool unmute);
  void fail();
  portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED;
  TaskHandle_t worker = nullptr;
  Permit outputAllowed = nullptr;
  bool configured = false, fault = false, armed = false, running = false;
  uint64_t deadline = 0;
  uint32_t generation = 0;
};
