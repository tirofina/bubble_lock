#include <Arduino.h>
#include <ArduinoJson.h>
#include <BLE2902.h>
#include <BLEDevice.h>
#include <BLESecurity.h>
#include <Preferences.h>
#include <Wire.h>
#include <driver/gpio.h>
#include <esp_bt.h>
#include <esp_timer.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <stddef.h>
#include <string>
#include "board_r18.h"
#include "firmware_options.h"
#include "motion_wake.h"
#include "power_state.h"
#include "audio_alert.h"
#include "aux_rail.h"
#include "peripherals.h"
#include "supply_monitor.h"
#include "headphone_standby.h"

namespace {
constexpr char FirmwareRevision[] = "keyring-0.7.0";
#if defined(KEYRING_LEGACY_GATT) && KEYRING_LEGACY_GATT
constexpr char ServiceUuid[] = "8b8f0001-8e7a-4f36-a8c2-1c9b5d620001";
constexpr char IdentityUuid[] = "8b8f0002-8e7a-4f36-a8c2-1c9b5d620001";
constexpr char ObservationUuid[] = "8b8f0003-8e7a-4f36-a8c2-1c9b5d620001";
constexpr char CommandUuid[] = "8b8f0004-8e7a-4f36-a8c2-1c9b5d620001";
constexpr char ReceiptUuid[] = "8b8f0005-8e7a-4f36-a8c2-1c9b5d620001";
constexpr char JournalUuid[] = "8b8f0006-8e7a-4f36-a8c2-1c9b5d620001";
#else
// DOC-REV 2.0.0 / pc-mobius/contracts/raspberrypi-gateway.v1.json.
constexpr char ServiceUuid[] = "7f8a0001-4b6e-4f4e-9b0a-505249564255";
constexpr char ObservationUuid[] = "7f8a0002-4b6e-4f4e-9b0a-505249564255";
constexpr char CommandUuid[] = "7f8a0003-4b6e-4f4e-9b0a-505249564255";
constexpr char ReceiptUuid[] = "7f8a0004-4b6e-4f4e-9b0a-505249564255";
constexpr char IdentityUuid[] = "7f8a0005-4b6e-4f4e-9b0a-505249564255";
constexpr char JournalUuid[] = "7f8a0006-4b6e-4f4e-9b0a-505249564255";
#endif
constexpr size_t MaxFrame = 4096;
constexpr unsigned JournalSlots = 32;
constexpr uint32_t JournalMagic = 0x4b524731;
constexpr uint8_t Prepared = 1, Completed = 2;
enum class Result : uint8_t { Applied = 1, ReadbackMismatch = 2 };

uint64_t uptime() { return static_cast<uint64_t>(esp_timer_get_time()) / 1000; }
char deviceId[65] = {}, bootId[33] = {};
BLEServer *server = nullptr;
BLECharacteristic *identityChar = nullptr, *observationChar = nullptr, *receiptChar = nullptr;
BLECharacteristic *journalChar = nullptr;
QueueHandle_t commandQueue = nullptr;
QueueHandle_t journalRequests = nullptr;
Preferences nvs;
bool storageHealthy = false, provisioned = false, radioSleepEnabled = false;
volatile bool connected = false, authenticated = false, disconnected = false;
volatile bool sleepPreparing = false;
volatile uint32_t connectionGeneration = 0;
uint8_t peerAddress[6] = {};
uint16_t peerConnection = 0;
portMUX_TYPE linkMux = portMUX_INITIALIZER_UNLOCKED;
uint32_t maxEpoch = 0, maxGrant = 0, sequence = 0;
uint64_t motorStopAt = 0, lastObservation = 0;
bool observationDirty = true;
esp_timer_handle_t motorTimer = nullptr;
volatile bool motorTimerFired = false;
MotionWake motion;
AudioAlert audio;
Peripherals peripherals;
SupplyMonitor supply;
HeadphoneStandby headphone;
bool audioInitAttempted = false;
uint64_t nextScreenAt = 0;
uint64_t lastSensorRead = 0;
uint8_t detailSection = 0;
bool audioPermitted() { return connected && authenticated && !sleepPreparing && headphone.speakerAllowed(); }
void initializeAudioWhenQuiet() {
  if (KEYRING_ENABLE_AUDIO && !audioInitAttempted && headphone.speakerAllowed()) {
    audioInitAttempted = true;
    audio.begin(audioPermitted);
  }
}

struct Frame { char bytes[MaxFrame + 1]; uint64_t firstAt, completedAt; uint32_t generation; };
Frame processingFrame = {};
struct Record {
  uint32_t magic;
  uint16_t format;
  uint8_t phase, result;
  char commandId[65], hash[65], bootId[33];
  uint32_t epoch, grant;
  uint64_t acceptedAt, appliedAt;
  uint8_t desired, readback;
  uint8_t reserved[6];
  uint32_t crc;
};
Record journal[JournalSlots] = {};
bool occupied[JournalSlots] = {};
struct JournalRequest { uint32_t id, generation; uint8_t operation, index, part; };
struct JournalCapture {
  Record records[JournalSlots];
  char id[33];
  uint64_t capturedAt;
  uint32_t generation, epoch, grant;
  uint8_t count, prepared;
  bool active;
} journalCapture = {};

uint32_t crc32(const void *data, size_t size) {
  auto p = static_cast<const uint8_t *>(data);
  uint32_t crc = 0xffffffff;
  for (size_t n = 0; n < size; ++n) {
    crc ^= p[n];
    for (unsigned bit = 0; bit < 8; ++bit) crc = (crc >> 1) ^ (0xedb88320 & (0u - (crc & 1u)));
  }
  return ~crc;
}
void slotKey(unsigned slot, char *key) { snprintf(key, 8, "j%02u", slot); }
bool storeRecord(unsigned slot, Record &record) {
  record.crc = crc32(&record, offsetof(Record, crc));
  char key[8]; slotKey(slot, key);
  if (nvs.putBytes(key, &record, sizeof(record)) != sizeof(record)) {
    storageHealthy = false;
    return false;
  }
  journal[slot] = record;
  occupied[slot] = true;
  return true;
}
void loadJournal() {
  storageHealthy = nvs.begin("keyring-v1", false);
  if (!storageHealthy) return;
  for (unsigned slot = 0; slot < JournalSlots; ++slot) {
    char key[8]; slotKey(slot, key);
    if (!nvs.isKey(key)) continue;
    Record &r = journal[slot];
    if (nvs.getBytesLength(key) != sizeof(r) || nvs.getBytes(key, &r, sizeof(r)) != sizeof(r) ||
        r.magic != JournalMagic || r.format != 1 || (r.phase != Prepared && r.phase != Completed) ||
        r.commandId[64] != '\0' || r.hash[64] != '\0' || r.bootId[32] != '\0' ||
        r.crc != crc32(&r, offsetof(Record, crc))) {
      storageHealthy = false;
      return; // A corrupt slot is never silently erased or reused.
    }
    occupied[slot] = true;
    maxEpoch = max(maxEpoch, r.epoch);
    maxGrant = max(maxGrant, r.grant);
  }
}

void output(int pin, int level) { digitalWrite(pin, level); pinMode(pin, OUTPUT); }
bool readState() { return gpio_get_level(static_cast<gpio_num_t>(board::Motor)) != 0; }
void stopMotor() {
  audio.stop();
  gpio_set_level(static_cast<gpio_num_t>(board::Motor), 0);
  auxRail::alert(false);
  motorStopAt = 0;
  if (motorTimer) esp_timer_stop(motorTimer);
  observationDirty = true;
}
void motorExpired(void *) {
  // GPIO mute uses a short lock; no I2S, JSON, BLE, I2C, or flash operation runs here.
  audio.stop();
  gpio_set_level(static_cast<gpio_num_t>(board::Motor), 0);
  auxRail::alert(false);
  motorTimerFired = true;
}
void safePins() {
  output(board::Motor, LOW);
  gpio_set_direction(static_cast<gpio_num_t>(board::Motor), GPIO_MODE_INPUT_OUTPUT);
  output(board::AuxEnable, LOW);
  gpio_set_direction(static_cast<gpio_num_t>(board::AuxEnable), GPIO_MODE_INPUT_OUTPUT);
  output(board::AmpMute, HIGH);
  output(board::LcdBacklight, HIGH);
  output(board::UsbEn1, LOW); // USB100. This firmware never opts into USB500.
  output(board::UsbEn2, LOW);
  output(board::LcdCs, HIGH);
  output(board::SdCs, HIGH);
  pinMode(board::Confirm, INPUT_PULLUP);
  pinMode(board::Panic, INPUT_PULLUP);
  pinMode(board::MainFaultN, INPUT_PULLUP);
  pinMode(board::AccelInterrupt, INPUT);
}
struct Button {
  int pin; bool raw = false, pressed = false; uint64_t changed = 0;
  explicit Button(int inputPin) : pin(inputPin) {}
  bool update(uint64_t now) {
    bool next = digitalRead(pin) == LOW;
    if (next != raw) { raw = next; changed = now; }
    if (pressed != raw && now - changed >= board::DebounceMs) { pressed = raw; return true; }
    return false;
  }
};
Button confirm{board::Confirm}, panic{board::Panic};

bool readRegisters(uint8_t address, uint8_t reg, uint8_t *data, size_t count) {
  Wire.beginTransmission(address); Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom(address, static_cast<uint8_t>(count)) != count) {
    while (Wire.available()) Wire.read();
    return false;
  }
  for (size_t i = 0; i < count; ++i) data[i] = Wire.read();
  return true;
}
bool writeRegister(uint8_t address, uint8_t reg, uint8_t value) {
  Wire.beginTransmission(address); Wire.write(reg); Wire.write(value);
  return Wire.endTransmission() == 0;
}
bool writeRegister16(uint8_t address, uint8_t reg, uint16_t value) {
  Wire.beginTransmission(address); Wire.write(reg);
  Wire.write(static_cast<uint8_t>(value >> 8)); Wire.write(static_cast<uint8_t>(value));
  return Wire.endTransmission() == 0;
}
bool accelReady = false;
void initSensors() {
  Wire.begin(board::I2cSda, board::I2cScl, 100000);
  Wire.setTimeOut(20);
  uint8_t id = 0;
  accelReady = readRegisters(board::AccelAddress, 0x0f, &id, 1) && id == 0x44;
  if (accelReady) {
    // CTRL2: BDU + address increment; CTRL6: +/-2g; CTRL1: 12.5Hz, LP mode1.
    accelReady = writeRegister(board::AccelAddress, 0x21, 0x0c) &&
                 writeRegister(board::AccelAddress, 0x25, 0x00) &&
                 writeRegister(board::AccelAddress, 0x20, 0x20);
  }
}
struct Sensors { bool fuel = false, accel = false; float battery = 0, volts = 0, xyz[3] = {}; } sensors;
void sampleSensors() {
  uint8_t data[6] = {};
  sensors.fuel = readRegisters(board::FuelAddress, 0x02, data, 4);
  if (sensors.fuel) {
    uint16_t v = (data[0] << 8) | data[1], soc = (data[2] << 8) | data[3];
    sensors.volts = v * 0.000078125f;
    sensors.battery = min(100.0f, soc / 256.0f);
  }
  sensors.accel = accelReady && readRegisters(board::AccelAddress, 0x28, data, 6);
  if (sensors.accel) {
    for (unsigned i = 0; i < 3; ++i) {
      int16_t raw = static_cast<int16_t>((data[i * 2 + 1] << 8) | data[i * 2]);
      sensors.xyz[i] = (raw / 16) * 0.000976f; // 12-bit left-aligned, +/-2g LP1, units g.
    }
  }
  lastSensorRead = uptime();
}

std::string jsonText(JsonDocument &doc) {
  std::string output; serializeJson(doc, output); output.push_back('\n'); return output;
}
struct Tx {
  BLECharacteristic *characteristic = nullptr;
  std::string pending, active, full;
  std::string sections[3];
  uint64_t sectionOrder[3] = {}, enqueueOrder = 0;
  size_t offset = 0;
  uint64_t nextAt = 0;
  void restoreReadValue() {
    // ATT attribute values are at most 512 bytes. Oversized receipt frames remain
    // complete on NOTIFY; an empty READ means the peer must await those fragments.
    if (full.size() <= 512) characteristic->setValue(full);
    else characteristic->setValue(std::string());
  }
  void queue(const std::string &frame) { pending = frame; full = frame; restoreReadValue(); }
  void queueSection(uint8_t section, const std::string &frame) {
    sections[section] = frame; sectionOrder[section] = ++enqueueOrder;
    full = frame; restoreReadValue();
  }
  void clear() {
    pending.clear(); active.clear(); offset = 0;
    for (unsigned i = 0; i < 3; ++i) { sections[i].clear(); sectionOrder[i] = 0; }
  }
  void tick(uint64_t now) {
    if (!connected || !authenticated || now < nextAt) return;
    if (active.empty()) {
      active.swap(pending); offset = 0;
      if (active.empty()) {
        // Select by publication order, never round-robin older sequence frames
        // after newer ones. Replacements retain the newest value for each detail.
        int selected = -1;
        for (unsigned i = 0; i < 3; ++i)
          if (!sections[i].empty() && (selected < 0 || sectionOrder[i] < sectionOrder[selected])) selected = i;
        if (selected >= 0) { active.swap(sections[selected]); sectionOrder[selected] = 0; }
      }
    }
    if (active.empty()) return;
    size_t count = min(static_cast<size_t>(20), active.size() - offset);
    characteristic->setValue(reinterpret_cast<uint8_t *>(&active[offset]), count);
    characteristic->notify();
    restoreReadValue();
    offset += count; nextAt = now + 15;
    if (offset == active.size()) { active.clear(); restoreReadValue(); }
  }
};
Tx observationTx, receiptTx;

void publishObservation() {
  StaticJsonDocument<1536> doc;
  const uint32_t observationSequence = sequence++;
  const uint64_t now = uptime();
  const bool outputState = readState(), fault = digitalRead(board::MainFaultN) == LOW;
  const uint8_t section = detailSection; detailSection = (detailSection + 1) % 3;
  const char *detail = section == 0 ? "sensors" : section == 1 ? "energy" : "health";
  auto base = [&]() -> JsonObject {
    doc.clear(); // Also clears overflow state before rebuilding a minimal frame.
    doc["version"] = 1; doc["deviceId"] = deviceId; doc["bootId"] = bootId;
    doc["sequence"] = observationSequence; doc["uptimeMs"] = now;
    if (sensors.fuel) doc["battery"] = sensors.battery; else doc["battery"] = nullptr;
    doc["buttonState"] = panic.pressed ? "panic" : confirm.pressed ? "confirm" : "released";
    doc["state"] = outputState;
    JsonObject values = doc.createNestedObject("sensorValues");
    values["detail"] = detail; values["fault"] = fault;
    values["journal"] = storageHealthy ? "ready" : "error";
    return values;
  };
  JsonObject values = base();
  if (section == 0) {
    values["batteryStatus"] = sensors.fuel ? "ok" : "unavailable";
    values["accelStatus"] = sensors.accel ? "ok" : "unavailable";
    if (sensors.fuel) values["voltage"] = sensors.volts; else values["voltage"] = nullptr;
    if (sensors.accel) {
      JsonArray axes = values.createNestedArray("accelerationG");
      for (float value : sensors.xyz) axes.add(value);
    } else values["accelerationG"] = nullptr;
    values["motion"] = motion.ready() ? "ready" : "unavailable";
    values["motionEvents"] = motion.events();
  } else if (section == 1) {
    const auto &reading = supply.reading();
    JsonObject monitor = values.createNestedObject("ina219");
    monitor["status"] = supply.status(now);
    if (supply.valid(now)) {
      monitor["busVoltageMv"] = reading.busMv; monitor["currentUa"] = reading.currentUa;
      monitor["loadPowerUw"] = reading.loadPowerUw; monitor["shuntVoltageUv"] = reading.shuntUv;
      monitor["readUptimeMs"] = reading.readAt;
    } else {
      for (const char *key : {"busVoltageMv", "currentUa", "loadPowerUw", "shuntVoltageUv", "readUptimeMs"}) monitor[key] = nullptr;
    }
  } else {
    unsigned used = 0, prepared = 0;
    for (unsigned slot = 0; slot < JournalSlots; ++slot) if (occupied[slot]) {
      ++used; if (journal[slot].phase == Prepared) ++prepared;
    }
    if (storageHealthy) { values["journalUsed"] = used; values["journalPrepared"] = prepared; }
    else { values["journalUsed"] = nullptr; values["journalPrepared"] = nullptr; }
    values["journalCapacity"] = JournalSlots;
    values["wake"] = powerState::wakeCause(); values["wakePins"] = powerState::wakePins();
    values["power"] = powerState::status();
    values["audio"] = headphone.speakerAllowed() ? audio.status() : "blocked_headphone";
    values["headphone"] = headphone.status();
    values["display"] = peripherals.displayStatus(); values["sd"] = peripherals.sdStatus();
    values["sdDropped"] = peripherals.droppedLogs();
  }
  std::string frame = jsonText(doc);
  if (frame.size() > 512 && !doc.overflowed()) {
    // Sensor detail is optional; identity/battery/button/output stay in every frame.
    values.remove("accelerationG"); values.remove("voltage");
    values.remove("batteryStatus"); values.remove("accelStatus");
    if (section == 2) {
      values.remove("audio"); values.remove("display"); values.remove("sdDropped"); values.remove("wakePins");
      values.remove("wake");
    }
    values["truncated"] = true;
    frame = jsonText(doc);
  }
  if (frame.size() > 512 || doc.overflowed()) {
    // Keep identity, sequence, buttons, state and uptime. Do not invent readings
    // when the full sensor object exceeds the READ attribute budget.
    values = base(); values["status"] = "payload_too_large";
    frame = jsonText(doc);
  }
  // Enforce the wire bound at runtime even if a future identity/field expansion
  // also makes the minimal observation too large.
  if (frame.size() <= 512 && !doc.overflowed()) observationTx.queueSection(section, frame);
  observationDirty = false; lastObservation = uptime();
}

void publishReceipt(const char *commandId, const char *hash, const char *code,
                    const Record *record = nullptr, uint64_t acceptedAt = 0) {
  StaticJsonDocument<1536> doc;
  doc["version"] = 1; doc["deviceId"] = deviceId;
  doc["bootId"] = record ? record->bootId : bootId;
  doc["commandId"] = commandId; doc["payloadHash"] = hash; doc["ackCode"] = code;
  if (record) doc["acceptedUptimeMs"] = record->acceptedAt;
  else if (acceptedAt) doc["acceptedUptimeMs"] = acceptedAt;
  else doc["acceptedUptimeMs"] = nullptr;
  if (record && record->phase == Completed) doc["appliedUptimeMs"] = record->appliedAt;
  else doc["appliedUptimeMs"] = nullptr;
  doc["readback"]["state"] = record && record->phase == Completed ? record->readback != 0 : readState();
  doc["firmwareRevision"] = FirmwareRevision;
  const std::string frame = jsonText(doc);
  receiptTx.queue(frame);
  peripherals.logReceipt(frame.data(), frame.size()); // Optional best-effort copy; NVS is canonical.
}
bool identifier(const char *value) {
  if (!value || !*value || strlen(value) > 64 || !isalnum(static_cast<unsigned char>(*value))) return false;
  for (const unsigned char *p = reinterpret_cast<const unsigned char *>(value); *p; ++p) {
    if (*p > 127 || !(isalnum(*p) || *p == '.' || *p == '_' || *p == ':' || *p == '-')) return false;
  }
  return true;
}
bool hashValid(const char *hash) {
  if (!hash || strlen(hash) != 64) return false;
  for (unsigned i = 0; i < 64; ++i) if (!((hash[i] >= '0' && hash[i] <= '9') || (hash[i] >= 'a' && hash[i] <= 'f'))) return false;
  return true;
}
bool exactFields(JsonObjectConst object, const char *const *allowed, unsigned count) {
  if (object.size() != count) return false;
  for (JsonPairConst field : object) {
    bool found = false;
    for (unsigned i = 0; i < count; ++i) if (strcmp(field.key().c_str(), allowed[i]) == 0) found = true;
    if (!found) return false;
  }
  return true;
}

void processCommand(const Frame &frame) {
  if (!provisioned || !connected || !authenticated || frame.generation != connectionGeneration) return;
  DynamicJsonDocument doc(8192);
  DeserializationError error = deserializeJson(doc, frame.bytes, DeserializationOption::NestingLimit(4));
  // Without trustworthy correlation fields, drop malformed traffic instead of inventing an ID/hash.
  if (error || !doc.is<JsonObject>()) return;
  const char *id = doc["commandId"], *hash = doc["payloadHash"], *target = doc["deviceId"];
  if (!identifier(id) || !hashValid(hash)) return;
  static const char *const fields[] = {"version", "type", "deviceId", "commandId", "desiredState",
      "grantRevision", "ownershipEpoch", "payloadHash", "remainingMs"};
  static const char *const desiredFields[] = {"state"};
  bool valid = exactFields(doc.as<JsonObjectConst>(), fields, 9) && doc["version"].is<int>() &&
      doc["version"].as<int>() == 1 && doc["type"].is<const char *>() &&
      strcmp(doc["type"].as<const char *>(), "command") == 0 && identifier(target) &&
      strcmp(target, deviceId) == 0 && doc["desiredState"].is<JsonObject>() &&
      exactFields(doc["desiredState"].as<JsonObjectConst>(), desiredFields, 1) &&
      doc["desiredState"]["state"].is<bool>() && doc["grantRevision"].is<int32_t>() &&
      doc["grantRevision"].as<int32_t>() > 0 && doc["ownershipEpoch"].is<int32_t>() &&
      doc["ownershipEpoch"].as<int32_t>() >= 0 && doc["remainingMs"].is<uint32_t>() &&
      doc["remainingMs"].as<uint32_t>() >= 1 && doc["remainingMs"].as<uint32_t>() <= 30000;
  if (!valid) { publishReceipt(id, hash, "INVALID"); return; }
  uint32_t epoch = doc["ownershipEpoch"], grant = doc["grantRevision"], remaining = doc["remainingMs"];
  bool desired = doc["desiredState"]["state"];
  int freeSlot = -1;
  for (unsigned slot = 0; slot < JournalSlots; ++slot) {
    if (!occupied[slot]) { if (freeSlot < 0) freeSlot = slot; continue; }
    const Record &r = journal[slot];
    if (strcmp(id, r.commandId) != 0) continue;
    if (strcmp(hash, r.hash) != 0 || desired != (r.desired != 0) || epoch != r.epoch || grant != r.grant) {
      publishReceipt(id, hash, "CONFLICT"); return;
    }
    const char *result = r.phase == Prepared ? "INDETERMINATE" :
      r.result == static_cast<uint8_t>(Result::Applied) ? "DUPLICATE" : "READBACK_MISMATCH";
    publishReceipt(id, hash, result, &r); return;
  }
  if (!storageHealthy) { publishReceipt(id, hash, "STORAGE_ERROR"); return; }
  if (epoch < maxEpoch) { publishReceipt(id, hash, "REJECTED_EPOCH"); return; }
  if (grant < maxGrant) { publishReceipt(id, hash, "REJECTED_GRANT"); return; }
  if (uptime() - frame.firstAt >= remaining) { publishReceipt(id, hash, "EXPIRED"); return; }
  if (freeSlot < 0) { publishReceipt(id, hash, "JOURNAL_FULL"); return; }
  if (desired && (digitalRead(board::MainFaultN) == LOW || !motorTimer)) {
    publishReceipt(id, hash, "READBACK_MISMATCH"); return;
  }
  Record r = {};
  r.magic = JournalMagic; r.format = 1; r.phase = Prepared;
  strlcpy(r.commandId, id, sizeof(r.commandId)); strlcpy(r.hash, hash, sizeof(r.hash));
  strlcpy(r.bootId, bootId, sizeof(r.bootId)); r.epoch = epoch; r.grant = grant;
  r.desired = desired; r.acceptedAt = frame.completedAt;
  // Durable intent before GPIO. A reset after this point must never repeat the actuation.
  if (!storeRecord(freeSlot, r)) { stopMotor(); publishReceipt(id, hash, "STORAGE_ERROR"); return; }
  maxEpoch = max(maxEpoch, epoch); maxGrant = max(maxGrant, grant);
  if (!connected || !authenticated || frame.generation != connectionGeneration ||
      uptime() - frame.firstAt >= remaining) {
    stopMotor(); publishReceipt(id, hash, "INDETERMINATE", &r); return;
  }
  stopMotor();
  if (desired) {
    uint64_t elapsed = uptime() - frame.firstAt;
    if (elapsed >= remaining) { publishReceipt(id, hash, "INDETERMINATE", &r); return; }
    uint64_t budget = remaining - elapsed;
    uint64_t pulse = min(static_cast<uint64_t>(board::MotorMaxOnMs), budget);
    motorTimerFired = false;
    if (!auxRail::alert(true)) { publishReceipt(id, hash, "INDETERMINATE", &r); return; }
    gpio_set_level(static_cast<gpio_num_t>(board::Motor), 1);
    // A failed start immediately clears both outputs. The timer task is independent of BLE/flash.
    motorStopAt = uptime() + pulse;
    if (esp_timer_start_once(motorTimer, pulse * 1000) != ESP_OK) {
      stopMotor(); publishReceipt(id, hash, "INDETERMINATE", &r); return;
    }
  }
  r.appliedAt = uptime(); r.readback = readState(); r.phase = Completed;
  r.result = static_cast<uint8_t>(r.readback == r.desired ? Result::Applied : Result::ReadbackMismatch);
  if (r.readback != r.desired) stopMotor();
  if (!storeRecord(freeSlot, r)) {
    stopMotor();
    // Keep the durable PREPARED copy in RAM. Do not claim completed storage.
    publishReceipt(id, hash, "INDETERMINATE", &journal[freeSlot]); return;
  }
  if (desired && connected && authenticated && frame.generation == connectionGeneration &&
      r.result == static_cast<uint8_t>(Result::Applied) && readState())
    audio.startUntil(motorStopAt);
  publishReceipt(id, hash, r.result == static_cast<uint8_t>(Result::Applied) ? "APPLIED" : "READBACK_MISMATCH", &r);
  observationDirty = true;
}

void processJournalRequest(const JournalRequest &request) {
  if (!connected || !authenticated || request.generation != connectionGeneration) return;
  StaticJsonDocument<768> doc;
  char requestId[9]; snprintf(requestId, sizeof(requestId), "%08lx", static_cast<unsigned long>(request.id));
  doc["version"] = 1; doc["requestId"] = requestId; doc["status"] = "ok";
  if (request.operation == 1) {
    journalCapture.active = false;
    if (!storageHealthy) doc["status"] = "storage_error";
    else if (motorStopAt || readState() || audio.busy() || uxQueueMessagesWaiting(commandQueue)) doc["status"] = "busy";
    else {
      journalCapture.count = journalCapture.prepared = 0;
      for (unsigned slot = 0; slot < JournalSlots; ++slot) if (occupied[slot]) {
        journalCapture.records[journalCapture.count++] = journal[slot];
        if (journal[slot].phase == Prepared) ++journalCapture.prepared;
      }
      snprintf(journalCapture.id, sizeof(journalCapture.id), "%08lx%08lx%08lx%08lx",
          static_cast<unsigned long>(esp_random()), static_cast<unsigned long>(esp_random()),
          static_cast<unsigned long>(esp_random()), static_cast<unsigned long>(esp_random()));
      journalCapture.capturedAt = uptime(); journalCapture.generation = request.generation;
      journalCapture.epoch = maxEpoch; journalCapture.grant = maxGrant;
      journalCapture.active = true;
      doc["type"] = "manifest"; doc["snapshotId"] = journalCapture.id;
      doc["deviceId"] = deviceId; doc["bootId"] = bootId;
      doc["capturedUptimeMs"] = journalCapture.capturedAt;
      doc["recordCount"] = journalCapture.count; doc["preparedCount"] = journalCapture.prepared;
      doc["capacity"] = JournalSlots; doc["format"] = 1;
      doc["maxEpoch"] = journalCapture.epoch; doc["maxGrant"] = journalCapture.grant;
    }
  } else if (!journalCapture.active || journalCapture.generation != request.generation ||
             uptime() - journalCapture.capturedAt >= 120000) {
    journalCapture.active = false; doc["status"] = "expired";
  } else if (request.operation == 3) {
    memset(&journalCapture, 0, sizeof(journalCapture));
    doc["type"] = "closed";
  } else if (request.index >= journalCapture.count) doc["status"] = "invalid_index";
  else {
    const Record &r = journalCapture.records[request.index];
    doc["type"] = "record"; doc["snapshotId"] = journalCapture.id;
    doc["index"] = request.index; doc["part"] = request.part; doc["parts"] = 2;
    JsonObject data = doc.createNestedObject("data");
    if (request.part == 0) {
      data["commandId"] = r.commandId; data["payloadHash"] = r.hash; data["bootId"] = r.bootId;
      data["ownershipEpoch"] = r.epoch; data["grantRevision"] = r.grant;
    } else {
      data["phase"] = r.phase == Prepared ? "prepared" : "completed";
      data["ackCode"] = r.phase == Prepared ? "INDETERMINATE" :
          r.result == static_cast<uint8_t>(Result::Applied) ? "APPLIED" : "READBACK_MISMATCH";
      data["desiredState"] = r.desired != 0;
      if (r.phase == Completed) data["readback"] = r.readback != 0; else data["readback"] = nullptr;
      data["acceptedUptimeMs"] = r.acceptedAt;
      if (r.phase == Completed) data["appliedUptimeMs"] = r.appliedAt; else data["appliedUptimeMs"] = nullptr;
      char crc[9]; snprintf(crc, sizeof(crc), "%08lx", static_cast<unsigned long>(r.crc));
      data["storageCrc32"] = crc;
    }
  }
  std::string frame = jsonText(doc);
  if (doc.overflowed() || frame.size() > 512) {
    doc.clear(); doc["version"] = 1; doc["requestId"] = requestId; doc["status"] = "overflow";
    frame = jsonText(doc);
  }
  journalChar->setValue(frame);
}

class JournalCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *characteristic) override {
    if (!connected || !authenticated || !provisioned) return;
    const std::string bytes = characteristic->getValue();
    if (bytes.size() != 8 || static_cast<uint8_t>(bytes[0]) != 1) return;
    const uint8_t op = bytes[1], index = bytes[6], part = bytes[7];
    if (op < 1 || op > 3 || part > 1 || index >= JournalSlots ||
        (op != 2 && (index || part))) return;
    JournalRequest request = {};
    request.operation = op; request.index = index; request.part = part;
    request.generation = connectionGeneration;
    for (unsigned byte = 0; byte < 4; ++byte) request.id |= static_cast<uint32_t>(static_cast<uint8_t>(bytes[2 + byte])) << (byte * 8);
    // Selector writes affect only volatile capture state; never NVS or an output.
    xQueueSend(journalRequests, &request, 0);
  }
};

class CommandCallbacks : public BLECharacteristicCallbacks {
  std::string partial;
  Frame assembled = {}; // BLE task stack is too small for a 4KiB automatic frame.
  uint64_t started = 0, last = 0;
  uint32_t generation = 0;
  bool discarding = false;
  void onWrite(BLECharacteristic *characteristic) override {
    if (!connected || !authenticated || !provisioned) { partial.clear(); return; }
    uint64_t now = uptime();
    if (generation != connectionGeneration || now - last > 5000) {
      partial.clear(); discarding = false; generation = connectionGeneration;
    }
    std::string chunk = characteristic->getValue();
    if (chunk.size() > 20) { partial.clear(); discarding = true; return; }
    last = now;
    for (char value : chunk) {
      if (value == '\n') {
        if (!discarding && !partial.empty()) {
          memcpy(assembled.bytes, partial.data(), partial.size()); assembled.bytes[partial.size()] = '\0';
          assembled.firstAt = started; assembled.completedAt = now; assembled.generation = generation;
          // Full queue is fail-closed; sender observes a timeout and may retry the same ID.
          xQueueSend(commandQueue, &assembled, 0);
        }
        partial.clear(); discarding = false; continue;
      }
      if (discarding) continue;
      if (partial.empty()) started = now;
      if (value == '\0' || partial.size() >= MaxFrame) { partial.clear(); discarding = true; continue; }
      partial.push_back(value);
    }
  }
};
class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer *instance, esp_ble_gatts_cb_param_t *param) override {
    portENTER_CRITICAL(&linkMux);
    const bool reject = connected || sleepPreparing;
    if (reject) {
      portEXIT_CRITICAL(&linkMux);
      instance->disconnect(param->connect.conn_id); return;
    }
    connected = true; authenticated = false; ++connectionGeneration;
    peerConnection = param->connect.conn_id; memcpy(peerAddress, param->connect.remote_bda, 6);
    portEXIT_CRITICAL(&linkMux);
    esp_ble_set_encryption(param->connect.remote_bda, ESP_BLE_SEC_ENCRYPT_MITM);
  }
  void onDisconnect(BLEServer *) override {
    portENTER_CRITICAL(&linkMux);
    connected = false; authenticated = false; disconnected = true; ++connectionGeneration;
    portEXIT_CRITICAL(&linkMux);
    audio.stop();
  }
};
class SecurityCallbacks : public BLESecurityCallbacks {
  uint32_t onPassKeyRequest() override { return KEYRING_PASSKEY; }
  void onPassKeyNotify(uint32_t) override {} // Never log the per-device secret.
  bool onConfirmPIN(uint32_t) override { return false; } // No unattended numeric comparison.
  bool onSecurityRequest() override { return provisioned; }
  void onAuthenticationComplete(esp_ble_auth_cmpl_t result) override {
    bool trusted = result.success && (result.auth_mode & ESP_LE_AUTH_REQ_SC_MITM_BOND) == ESP_LE_AUTH_REQ_SC_MITM_BOND;
    portENTER_CRITICAL(&linkMux);
    if (connected && memcmp(peerAddress, result.bd_addr, 6) == 0) authenticated = trusted;
    portEXIT_CRITICAL(&linkMux);
    if (!trusted && server) server->disconnect(peerConnection);
  }
};
void initBle() {
  BLEDevice::init(deviceId);
  BLEDevice::setEncryptionLevel(ESP_BLE_SEC_ENCRYPT_MITM);
  BLEDevice::setSecurityCallbacks(new SecurityCallbacks());
  auto security = new BLESecurity();
  security->setStaticPIN(KEYRING_PASSKEY);
  security->setAuthenticationMode(ESP_LE_AUTH_REQ_SC_MITM_BOND);
  security->setCapability(ESP_IO_CAP_OUT);
  security->setInitEncryptionKey(ESP_BLE_ENC_KEY_MASK | ESP_BLE_ID_KEY_MASK);
  security->setRespEncryptionKey(ESP_BLE_ENC_KEY_MASK | ESP_BLE_ID_KEY_MASK);
  server = BLEDevice::createServer(); server->setCallbacks(new ServerCallbacks());
  BLEService *service = server->createService(ServiceUuid);
  identityChar = service->createCharacteristic(IdentityUuid, BLECharacteristic::PROPERTY_READ);
  observationChar = service->createCharacteristic(ObservationUuid, BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
  receiptChar = service->createCharacteristic(ReceiptUuid, BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
  BLECharacteristic *command = service->createCharacteristic(CommandUuid, BLECharacteristic::PROPERTY_WRITE);
  journalChar = service->createCharacteristic(JournalUuid, BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_WRITE);
  identityChar->setAccessPermissions(ESP_GATT_PERM_READ_ENC_MITM);
  observationChar->setAccessPermissions(ESP_GATT_PERM_READ_ENC_MITM);
  receiptChar->setAccessPermissions(ESP_GATT_PERM_READ_ENC_MITM);
  command->setAccessPermissions(ESP_GATT_PERM_WRITE_ENC_MITM);
  journalChar->setAccessPermissions(ESP_GATT_PERM_READ_ENC_MITM | ESP_GATT_PERM_WRITE_ENC_MITM);
  journalChar->setCallbacks(new JournalCallbacks());
  journalChar->setValue(std::string());
  for (BLECharacteristic *characteristic : {observationChar, receiptChar}) {
    auto cccd = new BLE2902();
    cccd->setAccessPermissions(ESP_GATT_PERM_READ_ENC_MITM | ESP_GATT_PERM_WRITE_ENC_MITM);
    characteristic->addDescriptor(cccd);
  }
  command->setCallbacks(new CommandCallbacks());
  StaticJsonDocument<512> doc;
  doc["version"] = 1; doc["deviceId"] = deviceId; doc["firmwareRevision"] = FirmwareRevision;
  doc["boardRevision"] = board::Revision; doc["bootId"] = bootId;
  identityChar->setValue(jsonText(doc));
  observationTx.characteristic = observationChar; receiptTx.characteristic = receiptChar;
  service->start();
  BLEAdvertising *advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(ServiceUuid); advertising->setScanResponse(true);
  advertising->setMinInterval(400); advertising->setMaxInterval(800);
  advertising->start();
  radioSleepEnabled = esp_bt_sleep_enable() == ESP_OK;
}
} // namespace

namespace {
void considerSleep(uint64_t now) {
  if (!powerState::idle(now) || connected || !storageHealthy || !motion.ready() ||
      motorStopAt || readState() || audio.busy() || auxRail::busy() || peripherals.busy() || supply.busy() ||
      uxQueueMessagesWaiting(commandQueue) != 0 || uxQueueMessagesWaiting(journalRequests) != 0 ||
      !receiptTx.active.empty() || !receiptTx.pending.empty() ||
      digitalRead(board::MainFaultN) == LOW) return;
  if (!motion.clearForSleep() || !supply.prepareSleep() || !headphone.prepareSleep()) {
    powerState::activity(now); observationDirty = true; return;
  }
  // Reserve the transition before stopping advertising. New peers are refused
  // rather than accepting a connection while the main loop arms sleep.
  portENTER_CRITICAL(&linkMux);
  const bool entering = !connected && !sleepPreparing;
  if (entering) sleepPreparing = true;
  portEXIT_CRITICAL(&linkMux);
  if (!entering) return;
  if (!peripherals.prepareSleep()) {
    portENTER_CRITICAL(&linkMux); sleepPreparing = false; portEXIT_CRITICAL(&linkMux);
    return;
  }
  BLEDevice::getAdvertising()->stop();
  stopMotor();
  powerState::enter(); // Does not return after successful deep sleep.
  peripherals.resume();
  portENTER_CRITICAL(&linkMux);
  sleepPreparing = false;
  portEXIT_CRITICAL(&linkMux);
  powerState::activity(now); observationDirty = true;
  BLEDevice::startAdvertising();
}
}

void setup() {
  safePins();
  powerState::begin(); // Release sleep holds after writing safe output latches.
  safePins();
  Serial.begin(115200); // Native USB CDC only; GPIO43 is reserved for LCD reset.
  uint64_t mac = ESP.getEfuseMac();
#ifdef KEYRING_DEVICE_ID
  strlcpy(deviceId, KEYRING_DEVICE_ID, sizeof(deviceId));
#else
  snprintf(deviceId, sizeof(deviceId), "keyring-%012llx", static_cast<unsigned long long>(mac & 0xffffffffffffULL));
#endif
  snprintf(bootId, sizeof(bootId), "%08lx%08lx%08lx%08lx", static_cast<unsigned long>(esp_random()),
      static_cast<unsigned long>(esp_random()), static_cast<unsigned long>(esp_random()), static_cast<unsigned long>(esp_random()));
  loadJournal(); initSensors();
  headphone.begin(readRegisters, writeRegister);
  supply.begin(readRegisters, writeRegister16);
  motion.begin(accelReady, readRegisters, writeRegister);
  esp_timer_create_args_t timerArgs = {};
  timerArgs.callback = motorExpired; timerArgs.name = "motor-stop";
  if (esp_timer_create(&timerArgs, &motorTimer) != ESP_OK) motorTimer = nullptr;
  commandQueue = xQueueCreate(4, sizeof(Frame));
  journalRequests = xQueueCreate(4, sizeof(JournalRequest));
  provisioned = KEYRING_PASSKEY >= 100000 && KEYRING_PASSKEY <= 999999 && identifier(deviceId) && commandQueue && journalRequests;
  if (!provisioned) {
    Serial.println("KEYRING LOCKED: set a per-device passkey and valid identity before enabling BLE.");
    return;
  }
  initializeAudioWhenQuiet(); // I2S installation also waits for the other receiver's quiet state.
  auxRail::begin();
  peripherals.begin();
  initBle(); sampleSensors(); publishObservation();
  Serial.printf("KEYRING ready: %s, storage=%s, radioSleep=%s\n", deviceId,
      storageHealthy ? "ready" : "error", radioSleepEnabled ? "enabled" : "unavailable");
}
void loop() {
  uint64_t now = uptime();
  if (headphone.poll(now)) observationDirty = true;
  if (!headphone.speakerAllowed()) audio.stop();
  if (!provisioned) { delay(100); return; }
  initializeAudioWhenQuiet();
  if (connected) powerState::activity(now);
  if (disconnected) {
    disconnected = false; stopMotor(); observationTx.clear(); receiptTx.clear();
    xQueueReset(commandQueue); BLEDevice::startAdvertising();
    xQueueReset(journalRequests); memset(&journalCapture, 0, sizeof(journalCapture));
    journalChar->setValue(std::string());
  }
  if (motorTimerFired || (motorStopAt && now >= motorStopAt) ||
      (!authenticated && readState()) || (digitalRead(board::MainFaultN) == LOW && readState())) {
    motorTimerFired = false; stopMotor();
  }
  bool changedConfirm = confirm.update(now), changedPanic = panic.update(now);
  if ((changedConfirm && confirm.pressed) || (changedPanic && panic.pressed)) peripherals.show();
  if (changedConfirm || changedPanic) observationDirty = true;
  if (confirm.pressed || panic.pressed || changedConfirm || changedPanic) powerState::activity(now);
  if (motion.poll(now)) { powerState::activity(now); observationDirty = true; }
  // Preserve every receipt notification frame. A new command waits until its predecessor drains.
  if (receiptTx.active.empty() && receiptTx.pending.empty()) {
    if (xQueueReceive(commandQueue, &processingFrame, 0) == pdTRUE) processCommand(processingFrame);
  }
  JournalRequest journalRequest = {};
  if (xQueueReceive(journalRequests, &journalRequest, 0) == pdTRUE) processJournalRequest(journalRequest);
  if (journalCapture.active && uptime() - journalCapture.capturedAt >= 120000) {
    memset(&journalCapture, 0, sizeof(journalCapture));
    journalChar->setValue(std::string());
  }
  supply.poll(uptime());
  if (uptime() - lastSensorRead >= board::ObserveMs) { sampleSensors(); observationDirty = true; }
  if (uptime() - lastObservation >= board::ObserveMs) observationDirty = true;
  if (observationDirty) publishObservation();
  auxRail::service();
  if (now >= nextScreenAt) {
    KeyringScreen screen;
    screen.linked = connected; screen.authenticated = authenticated;
    screen.batteryValid = sensors.fuel; screen.battery = sensors.battery;
    screen.confirm = confirm.pressed; screen.panic = panic.pressed;
    screen.motor = readState(); screen.fault = digitalRead(board::MainFaultN) == LOW;
    screen.journal = storageHealthy; screen.motionEvents = motion.events();
    screen.supplyValid = supply.valid(uptime()); screen.supplyCurrentMa = supply.reading().currentUa / 1000.0f;
    screen.supplyReadAt = supply.reading().readAt;
    peripherals.update(screen); nextScreenAt = now + 250;
  }
  receiptTx.tick(now); observationTx.tick(now);
  considerSleep(now);
  // Yield to BLE and idle tasks. Manual light-sleep is deliberately not entered with active BLE.
  delay(5);
}
