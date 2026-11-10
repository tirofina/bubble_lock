#pragma once
#include <stdint.h>
#include <stddef.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/task.h>

struct KeyringScreen {
  bool linked = false, authenticated = false, batteryValid = false;
  bool confirm = false, panic = false, motor = false, fault = false, journal = false;
  float battery = 0;
  bool supplyValid = false;
  float supplyCurrentMa = 0;
  uint64_t supplyReadAt = 0;
  uint32_t motionEvents = 0;
};

// One worker owns every LCD and microSD SPI operation, including initialization.
// No SPI/filesystem work takes place in BLE callbacks or the actuator timer.
class Peripherals {
public:
  void begin();
  void update(const KeyringScreen &screen);
  void show();
  void logReceipt(const char *jsonLine, size_t length);
  bool busy();
  bool prepareSleep(); // Freeze new worker I/O only when no I/O or queued receipt exists.
  void resume();
  const char *displayStatus();
  const char *sdStatus();
  uint32_t droppedLogs();
private:
  struct LogLine { uint16_t length; char bytes[1024]; };
  static void entry(void *context);
  void run();
  void draw(const KeyringScreen &screen);
  void append(const LogLine &line);
  bool setIo(bool active);
  void drop();
  void setSd(const char *status);
  portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED;
  TaskHandle_t worker = nullptr;
  QueueHandle_t logs = nullptr;
  KeyringScreen snapshot;
  const char *displayState = "disabled", *sdState = "disabled";
  bool ioActive = false, sleeping = false, displayReady = false, sdReady = false;
  uint32_t drops = 0;
};
