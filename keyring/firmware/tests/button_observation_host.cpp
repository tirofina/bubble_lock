#include <ArduinoJson.h>
#include <algorithm>
#include <cassert>
#include <cstdio>
#include <cstring>
#include <string>
#include "board_r18.h"
#include "button_presses.h"

#ifdef NDEBUG
#error Keep assertions enabled for the button observation test
#endif

using std::min;
constexpr int LOW = 0;
constexpr unsigned JournalSlots = 32;
constexpr int Prepared = 1;
struct { int phase = 0; } journal[JournalSlots];
bool occupied[JournalSlots] = {};
char deviceId[65] = {}, bootId[33] = {};
uint32_t sequence = UINT32_MAX - 10;
uint8_t detailSection = 0;
uint64_t lastObservation = 0;
bool connected = true, authenticated = true, storageHealthy = true, observationDirty = true;
struct { bool pressed = false; } confirm, panic;
ButtonPresses buttonPresses;
struct { bool fuel = true, accel = true; float battery = 99.12345f, volts = 4.2f, xyz[3] = {1, 2, 3}; } sensors;
struct BLECharacteristic {
  void setValue(const std::string &) {}
  void setValue(uint8_t *, size_t) {}
  void notify() {}
} attribute;
uint64_t uptime() { return UINT64_C(9007199254740991); }
bool readState() { return false; }
int digitalRead(int) { return 1; }
struct {
  bool ready() const { return true; }
  uint32_t events() const { return UINT32_MAX; }
} motion;
struct {
  struct Reading {
    int32_t busMv = 32000, currentUa = -32767000, loadPowerUw = -1048544000, shuntUv = -327680;
    uint64_t readAt = uptime();
  } value;
  const Reading &reading() const { return value; }
  const char *status(uint64_t) const { return "ok"; }
  bool valid(uint64_t) const { return true; }
} supply;
namespace powerState {
const char *wakeCause() { return "button"; }
uint64_t wakePins() { return UINT64_MAX; }
const char *status() { return "disabled"; }
}
struct {
  const char *status() const { return "playing"; }
} audio;
struct {
  std::string state = "configured_off";
  bool speakerAllowed() const { return true; }
  const char *status() const { return state.c_str(); }
} headphone;
struct {
  const char *displayStatus() const { return "jd9853_unverified"; }
  const char *sdStatus() const { return "ready"; }
  uint32_t droppedLogs() const { return UINT32_MAX; }
} peripherals;

#include "button_observation_subject.inc"

DynamicJsonDocument readFrame(unsigned section) {
  const auto &frame = observationTx.sections[section];
  assert(!frame.empty() && frame.size() <= 512 && frame.back() == '\n');
  DynamicJsonDocument doc(2048);
  assert(!deserializeJson(doc, frame));
  return doc;
}

int main() {
  std::memset(deviceId, 'k', sizeof(deviceId) - 1);
  std::memset(bootId, 'b', sizeof(bootId) - 1);
  observationTx.characteristic = &attribute;
  assert(buttonPresses.confirm == 0 && buttonPresses.panic == 0);
  confirm.pressed = true;
  buttonPresses.record(true, false, false);
  publishObservation();
  assert(readFrame(0)["buttonState"] == "confirm");
  confirm.pressed = false;
  buttonPresses.record(false, false, false);
  detailSection = 0; // Replace the unsent detail after a release.
  publishObservation();
  auto released = readFrame(0);
  assert(released["buttonState"] == "released");
  assert(released["sensorValues"]["buttonPresses"][0].as<uint32_t>() == 1);
  assert(released["sensorValues"]["buttonPresses"][1].as<uint32_t>() == 0);
  std::puts("PASS released replacement frame retains the earlier press count");

  buttonPresses.record(true, true, true);
  buttonPresses.record(true, false, true);
  buttonPresses.record(false, false, false);
  assert(buttonPresses.confirm == 1 && buttonPresses.panic == 1);
  std::puts("PASS panic wins simultaneous presses, a held panic suppresses confirm, and release adds no press");

  buttonPresses.confirm = buttonPresses.panic = UINT32_MAX;
  buttonPresses.record(true, false, false);
  buttonPresses.record(false, true, true);
  assert(buttonPresses.confirm == UINT32_MAX && buttonPresses.panic == UINT32_MAX);
  detailSection = 1;
  publishObservation();
  auto energy = readFrame(1);
  assert(energy["sensorValues"]["ina219"]["status"] == "ok");
  assert(energy["sensorValues"]["buttonPresses"][0].as<uint32_t>() == UINT32_MAX);
  assert(energy["sensorValues"]["buttonPresses"][1].as<uint32_t>() == UINT32_MAX);
  std::printf("PASS saturated counters and INA219 fit in %zu bytes\n", observationTx.sections[1].size());

  headphone.state.assign(600, 'x'); // Force the real bounded-frame fallback.
  detailSection = 2;
  publishObservation();
  auto fallback = readFrame(2);
  assert(fallback["sensorValues"]["status"] == "payload_too_large");
  assert(fallback["sensorValues"]["buttonPresses"][0].as<uint32_t>() == UINT32_MAX);
  assert(fallback["sensorValues"]["buttonPresses"][1].as<uint32_t>() == UINT32_MAX);
  assert(fallback["sensorValues"]["wake"] == "button");
  assert(fallback["sensorValues"]["wakePins"].as<uint64_t>() == UINT64_MAX);
  assert(fallback["sensorValues"]["power"] == "disabled");
  std::puts("PASS minimal fallback keeps both press counts and wake fields");
}
