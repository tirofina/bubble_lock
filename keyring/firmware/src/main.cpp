#include <Arduino.h>
#include <ArduinoJson.h>
#include <BLE2902.h>
#include <BLEDevice.h>
#include <BLESecurity.h>
#include <Wire.h>
#include <driver/gpio.h>
#include <esp_bt.h>
#include <esp_gatts_api.h>
#include <esp_timer.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <nvs_flash.h>
#include <stddef.h>
#include <string>
#include "board_r18.h"
#include "button_presses.h"
#include "command_wire.h"
#include "firmware_options.h"
#include "gatt_read_value.h"
#include "motion_wake.h"
#include "power_state.h"
#include "audio_alert.h"
#include "aux_rail.h"
#include "peripherals.h"
#include "supply_monitor.h"
#include "headphone_standby.h"
#if KEYRING_R18_BRINGUP
#include <esp_ota_ops.h>
#include <esp_partition.h>
#endif

static bool journalNvsNeedsRecovery = false;
extern "C" esp_err_t __real_nvs_flash_init();
extern "C" esp_err_t __wrap_nvs_flash_init() {
  const esp_err_t status = __real_nvs_flash_init();
  if (status == ESP_ERR_NVS_NO_FREE_PAGES || status == ESP_ERR_NVS_NEW_VERSION_FOUND) {
    // Arduino init erases the default NVS partition on either of these codes.
    // The command journal in that partition must survive for manual recovery.
    journalNvsNeedsRecovery = true;
    return ESP_FAIL;
  }
  return status;
}

namespace {
#if KEYRING_R18_BRINGUP
#if KEYRING_R18_BRINGUP_DISPLAY == 1
constexpr char FirmwareRevision[] = "keyring-0.7.18-st7789-bringup";
constexpr char BringupPanelField[] = " panel=st7789";
#elif KEYRING_R18_BRINGUP_DISPLAY == 2
constexpr char FirmwareRevision[] = "keyring-0.7.18-jd9853-bringup";
constexpr char BringupPanelField[] = " panel=jd9853";
#else
constexpr char FirmwareRevision[] = "keyring-0.7.18-bringup";
constexpr char BringupPanelField[] = "";
#endif
char bringupBootRecord[320] = {};

void readRunningImageDigest(char (&hex)[65]) {
  uint8_t digest[32];
  const esp_partition_t *running = esp_ota_get_running_partition();
  if (!running || esp_partition_get_sha256(running, digest) != ESP_OK) return;
  constexpr char digits[] = "0123456789abcdef";
  for (size_t index = 0; index < sizeof(digest); ++index) {
    hex[index * 2] = digits[digest[index] >> 4];
    hex[index * 2 + 1] = digits[digest[index] & 0x0f];
  }
  hex[64] = '\0';
}
#else
constexpr char FirmwareRevision[] = "keyring-0.7.14";
#endif
constexpr bool ObservationOnly = KEYRING_R18_BRINGUP != 0;
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
constexpr char JournalTailKey[] = "journal-tail";
constexpr uint16_t LegacyRecordFormat = 1, TailRecordFormat = 2;
constexpr uint8_t Prepared = 1, Completed = 2;
enum class Result : uint8_t { Applied = 1, ReadbackMismatch = 2 };

uint64_t uptime() { return static_cast<uint64_t>(esp_timer_get_time()) / 1000; }
char deviceId[65] = {}, bootId[33] = {};
BLEServer *server = nullptr;
BLECharacteristic *identityChar = nullptr, *observationChar = nullptr, *receiptChar = nullptr;
BLECharacteristic *journalChar = nullptr;
BLECharacteristic *commandChar = nullptr;
QueueHandle_t commandQueue = nullptr;
QueueHandle_t journalRequests = nullptr;
nvs_handle_t journalNvs = 0;
bool storageHealthy = false, provisioned = false, radioSleepEnabled = false;
volatile bool connected = false, authenticated = false, disconnected = false;
volatile bool sleepPreparing = false;
volatile uint32_t connectionGeneration = 0;
uint8_t peerAddress[6] = {};
uint16_t peerConnection = 0;
uint16_t peerMtu = 23; // Protected by linkMux.
esp_gatt_if_t gattInterface = ESP_GATT_IF_NONE; // Protected by linkMux.
portMUX_TYPE linkMux = portMUX_INITIALIZER_UNLOCKED;
uint32_t maxEpoch = 0, maxGrant = 0, sequence = 0;
uint64_t motorStopAt = 0, lastObservation = 0;
bool observationDirty = true;
esp_timer_handle_t motorTimer = nullptr;
bool motorTimerFired = false, motorTimerCleaning = false; // Protected by linkMux.
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

struct Frame { char bytes[MaxFrame + 1]; uint64_t firstAt, completedAt; uint32_t generation, subscription; };
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
struct JournalTail { uint32_t count, crc; };
bool journalTailPresent = false;
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
bool identifier(const char *value);
bool hashValid(const char *hash);
bool validRecord(const Record &record) {
  if (record.magic != JournalMagic || (record.format != LegacyRecordFormat && record.format != TailRecordFormat) ||
      record.crc != crc32(&record, offsetof(Record, crc)) ||
      record.commandId[64] != '\0' || record.hash[64] != '\0' || record.bootId[32] != '\0' ||
      !identifier(record.commandId) || !hashValid(record.hash) || !identifier(record.bootId) ||
      record.epoch > INT32_MAX || record.grant == 0 || record.grant > INT32_MAX ||
      record.desired > 1 || record.readback > 1) return false;
  if (record.phase == Prepared) return record.result == 0 && record.appliedAt == 0 && record.readback == 0;
  const Result expected = record.desired == record.readback ? Result::Applied : Result::ReadbackMismatch;
  return record.phase == Completed && record.appliedAt >= record.acceptedAt &&
      record.result == static_cast<uint8_t>(expected);
}
template <typename Value>
bool commitJournalValue(const char *key, const Value &value) {
  if (nvs_set_blob(journalNvs, key, &value, sizeof(value)) != ESP_OK || nvs_commit(journalNvs) != ESP_OK) {
    storageHealthy = false;
    return false;
  }
  Value stored;
  size_t size = sizeof(stored);
  if (nvs_get_blob(journalNvs, key, &stored, &size) != ESP_OK || size != sizeof(stored) ||
      memcmp(&stored, &value, sizeof(stored)) != 0) {
    storageHealthy = false;
    return false;
  }
  return true;
}
bool storeJournalTail(uint32_t count) {
  JournalTail tail = {count, 0};
  tail.crc = crc32(&tail, offsetof(JournalTail, crc));
  journalTailPresent = commitJournalValue(JournalTailKey, tail);
  return journalTailPresent;
}
bool storeRecord(unsigned slot, Record &record) {
  const bool append = !occupied[slot];
  if (append) {
    // Preserve the legacy prefix before the first tail-checked record is written.
    if (!journalTailPresent && !storeJournalTail(slot)) return false;
    record.format = TailRecordFormat;
  }
  record.crc = crc32(&record, offsetof(Record, crc));
  char key[8]; slotKey(slot, key);
  if (!commitJournalValue(key, record) || (append && !storeJournalTail(slot + 1))) return false;
  journal[slot] = record;
  occupied[slot] = true;
  return true;
}
void loadJournal() {
  storageHealthy = nvs_open("keyring-v1", NVS_READWRITE, &journalNvs) == ESP_OK;
  if (!storageHealthy) return;
  journalTailPresent = false;
  unsigned count = 0;
  bool tailFormatSeen = false;
  for (unsigned slot = 0; slot < JournalSlots; ++slot) {
    char key[8]; slotKey(slot, key);
    Record &r = journal[slot];
    size_t size = sizeof(r);
    const esp_err_t status = nvs_get_blob(journalNvs, key, &r, &size);
    if (status == ESP_ERR_NVS_NOT_FOUND) continue;
    // Every writer appends at the first free slot and never lowers either fence.
    if (slot != count || status != ESP_OK || size != sizeof(r) || !validRecord(r) ||
        (tailFormatSeen && r.format != TailRecordFormat) ||
        (slot > 0 && (r.epoch < journal[slot - 1].epoch || r.grant < journal[slot - 1].grant))) {
      storageHealthy = false;
      return; // A corrupt slot is never silently erased or reused.
    }
    for (unsigned prior = 0; prior < slot; ++prior) {
      if (occupied[prior] && strcmp(journal[prior].commandId, r.commandId) == 0) {
        storageHealthy = false;
        return;
      }
    }
    occupied[slot] = true;
    ++count;
    tailFormatSeen = r.format == TailRecordFormat;
    maxEpoch = max(maxEpoch, r.epoch);
    maxGrant = max(maxGrant, r.grant);
  }
  JournalTail tail;
  size_t size = sizeof(tail);
  const esp_err_t status = nvs_get_blob(journalNvs, JournalTailKey, &tail, &size);
  if (status == ESP_ERR_NVS_NOT_FOUND) {
    storageHealthy = !tailFormatSeen;
    return;
  }
  if (status != ESP_OK || size != sizeof(tail) || tail.count > JournalSlots ||
      tail.crc != crc32(&tail, offsetof(JournalTail, crc))) {
    storageHealthy = false;
    return;
  }
  journalTailPresent = true;
  if (tail.count == count) return;
  // A reset can leave one verified PREPARED append ahead of the tail. Preserve
  // that command as indeterminate and advance only the metadata, never the GPIO.
  if (count == tail.count + 1 && tailFormatSeen && journal[count - 1].phase == Prepared) {
    storeJournalTail(count);
  } else {
    storageHealthy = false;
  }
}

void output(int pin, int level) { digitalWrite(pin, level); pinMode(pin, OUTPUT); }
bool readState() { return gpio_get_level(static_cast<gpio_num_t>(board::Motor)) != 0; }
void stopMotor() {
  gpio_set_level(static_cast<gpio_num_t>(board::Motor), 0);
  audio.stop();
  auxRail::alert(false);
  motorStopAt = 0;
  if (motorTimer) esp_timer_stop(motorTimer);
  observationDirty = true;
}
void motorExpired(void *) {
  // Serialize motor disable with the final enable check. Driver/rail cleanup follows.
  portENTER_CRITICAL(&linkMux);
  gpio_set_level(static_cast<gpio_num_t>(board::Motor), 0);
  motorTimerFired = true;
  motorTimerCleaning = true;
  portEXIT_CRITICAL(&linkMux);
  audio.stop();
  auxRail::alert(false);
  portENTER_CRITICAL(&linkMux);
  motorTimerCleaning = false;
  portEXIT_CRITICAL(&linkMux);
}
bool commandChannelOpen(uint32_t generation, uint32_t subscription);
bool motorGateOpen(uint32_t generation, uint32_t subscription, uint64_t stopAtUs) {
  // Caller holds linkMux, shared with disconnect and timer expiry.
  return commandChannelOpen(generation, subscription) && !motorTimerFired &&
      gpio_get_level(static_cast<gpio_num_t>(board::MainFaultN)) != 0 &&
      !auxRail::alertInterrupted() &&
      static_cast<uint64_t>(esp_timer_get_time()) < stopAtUs;
}
bool startMotor(uint64_t commandDeadlineUs, uint32_t generation, uint32_t subscription) {
  if (!motorTimer) return false;
  portENTER_CRITICAL(&linkMux);
  const bool idle = !motorTimerCleaning;
  if (idle) motorTimerFired = false;
  portEXIT_CRITICAL(&linkMux);
  if (!idle) return false;
  const uint64_t now = esp_timer_get_time();
  if (now >= commandDeadlineUs) return false;
  const uint64_t stopAtUs = min(commandDeadlineUs, now + static_cast<uint64_t>(board::MotorMaxOnMs) * 1000);
  if (esp_timer_start_once(motorTimer, stopAtUs - now) != ESP_OK) return false;

  portENTER_CRITICAL(&linkMux);
  // Enabling the rail may consume some of the remaining budget.
  const bool started = motorGateOpen(generation, subscription, stopAtUs) && auxRail::alert(true) &&
      motorGateOpen(generation, subscription, stopAtUs) && gpio_set_level(static_cast<gpio_num_t>(board::Motor), 1) == ESP_OK;
  portEXIT_CRITICAL(&linkMux);
  if (started) motorStopAt = stopAtUs / 1000;
  return started;
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
ButtonPresses buttonPresses;
#if KEYRING_R18_BRINGUP_DISPLAY
enum class DisplayTestButton { None, Confirm, Panic };
DisplayTestButton displayTestButton = DisplayTestButton::None;
#endif

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
void initSensors() {
  Wire.begin(board::I2cSda, board::I2cScl, 100000);
  Wire.setTimeOut(20);
}
constexpr uint64_t AccelRetryMs = 5000;
bool accelReady = false;
uint64_t nextAccelRetry = 0;
bool configureAccelerometer() {
  uint8_t id = 0;
  if (!readRegisters(board::AccelAddress, 0x0f, &id, 1) || id != 0x44) return false;
  // CTRL2: BDU + address increment; CTRL6: +/-2g; CTRL1: 12.5Hz, LP mode1.
  return writeRegister(board::AccelAddress, 0x21, 0x0c) &&
         writeRegister(board::AccelAddress, 0x25, 0x00) &&
         writeRegister(board::AccelAddress, 0x20, 0x20);
}
struct Sensors {
  bool fuel = false, accel = false, batteryLow = false;
  float battery = 0, volts = 0, xyz[3] = {};
} sensors;
void recoverAccelerometer(uint64_t now) {
  if ((accelReady && motion.ready()) || now < nextAccelRetry) return;
  const bool configureAxes = !accelReady;
  if (configureAxes) accelReady = configureAccelerometer();
  const bool motionRestored = motion.begin(accelReady, readRegisters, writeRegister);
  nextAccelRetry = uptime() + AccelRetryMs;
  if ((configureAxes && accelReady) || motionRestored) observationDirty = true;
}
void sampleSensors() {
  uint8_t data[6] = {};
  sensors.fuel = readRegisters(board::FuelAddress, 0x02, data, 4);
  if (sensors.fuel) {
    uint16_t v = (data[0] << 8) | data[1], soc = (data[2] << 8) | data[3];
    sensors.volts = v * 0.000078125f;
    sensors.battery = min(100.0f, soc / 256.0f);
    sensors.batteryLow = sensors.battery <= KEYRING_BATTERY_WARN_PERCENT ||
        (sensors.batteryLow && sensors.battery < KEYRING_BATTERY_RECOVER_PERCENT);
  }
  sensors.accel = accelReady && readRegisters(board::AccelAddress, 0x28, data, 6);
  if (sensors.accel) {
    for (unsigned i = 0; i < 3; ++i) {
      int16_t raw = static_cast<int16_t>((data[i * 2 + 1] << 8) | data[i * 2]);
      sensors.xyz[i] = (raw / 16) * 0.000976f; // 12-bit left-aligned, +/-2g LP1, units g.
    }
  } else if (accelReady) {
    accelReady = false;
    motion.invalidate();
    nextAccelRetry = uptime() + AccelRetryMs;
  }
  lastSensorRead = uptime();
}

std::string jsonText(JsonDocument &doc) {
  std::string output; serializeJson(doc, output); output.push_back('\n'); return output;
}
void setGattReadValue(GattReadValue &value, const std::string &frame) {
  portENTER_CRITICAL(&linkMux);
  value.replace(frame.data(), frame.size());
  portEXIT_CRITICAL(&linkMux);
}
GattReadValue identityRead, journalRead;

struct Tx {
  explicit Tx(bool scoped = false) : scopedReceipt(scoped) {}
  const bool scopedReceipt;
  BLECharacteristic *characteristic = nullptr;
  BLE2902 *cccd = nullptr;
  bool subscribed = false; // Protected by linkMux.
  uint32_t subscription = 0, activeSubscription = 0;
  uint32_t queuedGeneration = 0, queuedSubscription = 0;
  std::string pending, active;
  GattReadValue readValue;
  std::string sections[3];
  uint64_t sectionOrder[3] = {}, enqueueOrder = 0;
  size_t offset = 0;
  uint64_t nextAt = 0;
  void setSubscribed(bool enabled) { // Caller holds linkMux.
    if (subscribed != enabled) {
      subscribed = enabled; ++subscription;
      if (scopedReceipt) readValue.reset();
    }
  }
  void queueReceipt(const std::string &frame, uint32_t generation, uint32_t subscriptionId) {
    portENTER_CRITICAL(&linkMux);
    const bool current = commandChannelOpen(generation, subscriptionId);
    if (current) readValue.replace(frame.data(), frame.size());
    portEXIT_CRITICAL(&linkMux);
    if (!current) return;
    pending = frame; queuedGeneration = generation; queuedSubscription = subscriptionId;
  }
  void queueSection(uint8_t section, const std::string &frame) {
    sections[section] = frame; sectionOrder[section] = ++enqueueOrder;
    setGattReadValue(readValue, frame);
  }
  void clear() {
    pending.clear(); active.clear(); offset = 0; nextAt = 0;
    for (unsigned i = 0; i < 3; ++i) { sections[i].clear(); sectionOrder[i] = 0; }
    setGattReadValue(readValue, {});
  }
  void tick(uint64_t now) {
    portENTER_CRITICAL(&linkMux);
    const bool ready = connected && authenticated && subscribed;
    const uint16_t connection = peerConnection;
    const auto interfaceId = gattInterface;
    const uint32_t generation = connectionGeneration;
    const uint32_t currentSubscription = subscription;
    portEXIT_CRITICAL(&linkMux);
    if (scopedReceipt && (queuedGeneration != generation || queuedSubscription != currentSubscription)) {
      pending.clear(); active.clear(); offset = 0;
    }
    if (activeSubscription != currentSubscription) { offset = 0; activeSubscription = currentSubscription; }
    if (!ready || now < nextAt) return;
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
    const auto count = static_cast<uint16_t>(min(static_cast<size_t>(20), active.size() - offset));
    if (scopedReceipt) {
      portENTER_CRITICAL(&linkMux);
      const bool current = commandChannelOpen(queuedGeneration, queuedSubscription);
      portEXIT_CRITICAL(&linkMux);
      if (!current) return;
    }
    nextAt = now + 15;
    if (interfaceId == ESP_GATT_IF_NONE ||
        esp_ble_gatts_send_indicate(interfaceId, connection, characteristic->getHandle(), count,
                                  reinterpret_cast<uint8_t *>(&active[offset]), false) != ESP_OK) return;
    offset += count;
    if (offset == active.size()) active.clear();
  }
};
Tx observationTx, receiptTx(true);

bool commandChannelOpen(uint32_t generation, uint32_t subscription) { // Caller holds linkMux.
  return connected && authenticated && generation == connectionGeneration &&
      receiptTx.subscribed && subscription == receiptTx.subscription;
}
bool commandChannelReady(const Frame &frame) {
  portENTER_CRITICAL(&linkMux);
  const bool ready = commandChannelOpen(frame.generation, frame.subscription);
  portEXIT_CRITICAL(&linkMux);
  return ready;
}

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
    values["journal"] = ObservationOnly ? "disabled" : storageHealthy ? "ready" : "error";
    if (sensors.fuel) values["batteryAlert"] = sensors.batteryLow; else values["batteryAlert"] = nullptr;
    buttonPresses.append(values);
    return values;
  };
  auto appendWake = [](JsonObject values) {
    values["wake"] = powerState::wakeCause();
    values["wakePins"] = powerState::wakePins();
    values["power"] = powerState::status();
  };
#if KEYRING_R18_BRINGUP_DISPLAY
  auto appendDisplayTest = [](JsonObject values) {
    const auto display = peripherals.displayTest();
    values["display"] = display.status;
    JsonArray presses = values.createNestedArray("displayDrawnPresses");
    presses.add(display.confirmPress);
    presses.add(display.panicPress);
  };
#endif
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
#if KEYRING_R18_BRINGUP_DISPLAY
    appendWake(values);
    appendDisplayTest(values);
#else
    unsigned used = 0, prepared = 0;
    for (unsigned slot = 0; slot < JournalSlots; ++slot) if (occupied[slot]) {
      ++used; if (journal[slot].phase == Prepared) ++prepared;
    }
    if (storageHealthy) { values["journalUsed"] = used; values["journalPrepared"] = prepared; }
    else { values["journalUsed"] = nullptr; values["journalPrepared"] = nullptr; }
    values["journalCapacity"] = ObservationOnly ? 0 : JournalSlots;
    appendWake(values);
    values["audio"] = headphone.speakerAllowed() ? audio.status() : "blocked_headphone";
    values["headphone"] = headphone.status();
    values["display"] = peripherals.displayStatus(); values["sd"] = peripherals.sdStatus();
    values["sdDropped"] = peripherals.droppedLogs();
#endif
  }
  std::string frame = jsonText(doc);
  if (frame.size() > 512 && !doc.overflowed()) {
    // Sensor detail is optional; identity/battery/button/output stay in every frame.
    values.remove("accelerationG"); values.remove("voltage");
    values.remove("batteryStatus"); values.remove("accelStatus");
#if !KEYRING_R18_BRINGUP_DISPLAY
    if (section == 2) {
      values.remove("audio"); values.remove("display"); values.remove("sdDropped");
    }
#endif
    values["truncated"] = true;
    frame = jsonText(doc);
  }
  if (frame.size() > 512 || doc.overflowed()) {
    // Keep identity, sequence, buttons, state and uptime. Do not invent readings
    // when the full sensor object exceeds the READ attribute budget.
    values = base(); values["status"] = "payload_too_large";
    if (section == 2) {
      appendWake(values);
#if KEYRING_R18_BRINGUP_DISPLAY
      appendDisplayTest(values);
#endif
    }
    frame = jsonText(doc);
  }
  // Enforce the wire bound at runtime even if a future identity/field expansion
  // also makes the minimal observation too large.
  if (frame.size() <= 512 && !doc.overflowed()) observationTx.queueSection(section, frame);
  observationDirty = false; lastObservation = uptime();
}

void publishReceipt(const Frame &request, const char *commandId, const char *hash, const char *code,
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
  receiptTx.queueReceipt(frame, request.generation, request.subscription);
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
void processCommand(const Frame &frame) {
  if (!provisioned || !commandChannelReady(frame)) return;
  DynamicJsonDocument doc(8192);
  const size_t length = strlen(frame.bytes);
  DeserializationError error = deserializeJson(doc, frame.bytes, length, DeserializationOption::NestingLimit(4));
  // Without trustworthy correlation fields, drop malformed traffic instead of inventing an ID/hash.
  if (error || !doc.is<JsonObject>()) return;
  const char *id = doc["commandId"], *hash = doc["payloadHash"];
  if (!identifier(id) || !hashValid(hash)) return;
  if (!commandWire::valid(doc.as<JsonObjectConst>(), deviceId, frame.bytes, length)) {
    publishReceipt(frame, id, hash, "INVALID"); return;
  }
  if (!storageHealthy) { publishReceipt(frame, id, hash, "STORAGE_ERROR"); return; }
  uint32_t epoch = doc["ownershipEpoch"], grant = doc["grantRevision"], remaining = doc["remainingMs"];
  bool desired = doc["desiredState"]["state"];
  int freeSlot = -1;
  for (unsigned slot = 0; slot < JournalSlots; ++slot) {
    if (!occupied[slot]) { if (freeSlot < 0) freeSlot = slot; continue; }
    const Record &r = journal[slot];
    if (strcmp(id, r.commandId) != 0) continue;
    if (strcmp(hash, r.hash) != 0 || desired != (r.desired != 0) || epoch != r.epoch || grant != r.grant) {
      publishReceipt(frame, id, hash, "CONFLICT"); return;
    }
    const char *result = r.phase == Prepared ? "INDETERMINATE" :
      r.result == static_cast<uint8_t>(Result::Applied) ? "DUPLICATE" : "READBACK_MISMATCH";
    publishReceipt(frame, id, hash, result, &r); return;
  }
  if (epoch < maxEpoch) { publishReceipt(frame, id, hash, "REJECTED_EPOCH"); return; }
  if (grant < maxGrant) { publishReceipt(frame, id, hash, "REJECTED_GRANT"); return; }
  if (uptime() - frame.firstAt >= remaining) { publishReceipt(frame, id, hash, "EXPIRED"); return; }
  if (freeSlot < 0) { publishReceipt(frame, id, hash, "JOURNAL_FULL"); return; }
  if (desired && (digitalRead(board::MainFaultN) == LOW || !motorTimer)) {
    publishReceipt(frame, id, hash, "READBACK_MISMATCH"); return;
  }
  if (!commandChannelReady(frame)) return;
  Record r = {};
  r.magic = JournalMagic; r.phase = Prepared;
  strlcpy(r.commandId, id, sizeof(r.commandId)); strlcpy(r.hash, hash, sizeof(r.hash));
  strlcpy(r.bootId, bootId, sizeof(r.bootId)); r.epoch = epoch; r.grant = grant;
  r.desired = desired; r.acceptedAt = frame.completedAt;
  // Durable intent before GPIO. A reset after this point must never repeat the actuation.
  if (!storeRecord(freeSlot, r)) { stopMotor(); publishReceipt(frame, id, hash, "STORAGE_ERROR"); return; }
  maxEpoch = max(maxEpoch, epoch); maxGrant = max(maxGrant, grant);
  if (!commandChannelReady(frame) || uptime() - frame.firstAt >= remaining) {
    stopMotor(); publishReceipt(frame, id, hash, "INDETERMINATE", &r); return;
  }
  stopMotor();
  if (desired && !startMotor((frame.firstAt + remaining) * 1000, frame.generation, frame.subscription)) {
    stopMotor(); publishReceipt(frame, id, hash, "INDETERMINATE", &r); return;
  }
  r.appliedAt = uptime(); r.readback = readState();
  if (desired && auxRail::alertInterrupted()) {
    stopMotor(); publishReceipt(frame, id, hash, "INDETERMINATE", &journal[freeSlot]); return;
  }
  r.phase = Completed;
  r.result = static_cast<uint8_t>(r.readback == r.desired ? Result::Applied : Result::ReadbackMismatch);
  if (r.readback != r.desired) stopMotor();
  if (!storeRecord(freeSlot, r)) {
    stopMotor();
    // Keep the last verified PREPARED copy in RAM. The flash result is uncertain.
    publishReceipt(frame, id, hash, "INDETERMINATE", &journal[freeSlot]); return;
  }
  if (desired && commandChannelReady(frame) && !auxRail::alertInterrupted() &&
      r.result == static_cast<uint8_t>(Result::Applied) && readState())
    audio.startUntil(motorStopAt);
  publishReceipt(frame, id, hash, r.result == static_cast<uint8_t>(Result::Applied) ? "APPLIED" : "READBACK_MISMATCH", &r);
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
  setGattReadValue(journalRead, frame);
}

void receiveJournalSelector(const uint8_t *bytes, size_t size, uint32_t generation) {
  if (size != 8 || bytes[0] != 1) return;
  const uint8_t op = bytes[1], index = bytes[6], part = bytes[7];
  if (op < 1 || op > 3 || part > 1 || index >= JournalSlots ||
      (op != 2 && (index || part))) return;
  JournalRequest request = {};
  request.operation = op; request.index = index; request.part = part;
  request.generation = generation;
  for (unsigned byte = 0; byte < 4; ++byte) request.id |= static_cast<uint32_t>(bytes[2 + byte]) << (byte * 8);
  // Selector writes affect only volatile capture state; never NVS or an output.
  setGattReadValue(journalRead, {});
  xQueueSend(journalRequests, &request, 0);
}

class CommandInput {
  Frame assembled = {}; // BLE task stack is too small for a 4KiB automatic frame.
  uint64_t last = 0;
  size_t used = 0;
  bool discarding = false;
 public:
  void receive(const uint8_t *bytes, size_t size, uint32_t generation, uint32_t currentSubscription) {
    const uint64_t now = uptime();
    if (assembled.generation != generation || assembled.subscription != currentSubscription || now - last > 5000) {
      used = 0; discarding = false; assembled.generation = generation; assembled.subscription = currentSubscription;
    }
    last = now;
    if (!size || size > 20) { used = 0; discarding = true; return; }
    for (size_t index = 0; index < size; ++index) {
      const uint8_t value = bytes[index];
      if (value == '\n') {
        if (!discarding && used) {
          assembled.bytes[used] = '\0'; assembled.completedAt = now;
          // Full queue is fail-closed; sender observes a timeout and may retry the same ID.
          xQueueSend(commandQueue, &assembled, 0);
        }
        used = 0; discarding = false; continue;
      }
      if (discarding) continue;
      if (!used) assembled.firstAt = now;
      if (value == '\0' || used >= MaxFrame) { used = 0; discarding = true; continue; }
      assembled.bytes[used++] = static_cast<char>(value);
    }
  }
} commandInput;

void onGattsEvent(esp_gatts_cb_event_t event, esp_gatt_if_t, esp_ble_gatts_cb_param_t *param) {
  if (event == ESP_GATTS_MTU_EVT) {
    portENTER_CRITICAL(&linkMux);
    if (connected && peerConnection == param->mtu.conn_id && param->mtu.mtu >= 23)
      peerMtu = param->mtu.mtu;
    portEXIT_CRITICAL(&linkMux);
    return;
  }
  if (event != ESP_GATTS_WRITE_EVT || param->write.is_prep || param->write.offset != 0) return;
  const auto &write = param->write;
  portENTER_CRITICAL(&linkMux);
  const bool accepted = provisioned && connected && authenticated && peerConnection == write.conn_id;
  if (accepted) {
    const bool notify = write.len == 2 && write.value[0] == 1 && write.value[1] == 0;
    if (observationTx.cccd && write.handle == observationTx.cccd->getHandle()) observationTx.setSubscribed(notify);
    if (receiptTx.cccd && write.handle == receiptTx.cccd->getHandle()) receiptTx.setSubscribed(notify);
  }
  const uint32_t generation = connectionGeneration;
  const bool receiptSubscribed = receiptTx.subscribed;
  const uint32_t subscription = receiptTx.subscription;
  portEXIT_CRITICAL(&linkMux);
  if (!accepted || !write.need_rsp) return;
  if (commandChar && write.handle == commandChar->getHandle() && receiptSubscribed)
    commandInput.receive(write.value, write.len, generation, subscription);
  if (journalChar && write.handle == journalChar->getHandle())
    receiveJournalSelector(write.value, write.len, generation);
}

bool handleProtectedGattRead(esp_gatt_if_t interfaceId, const esp_ble_gatts_cb_param_t &event) {
  const auto &request = event.read;
  GattReadValue *value = nullptr;
  if (identityChar && identityChar->getHandle() == request.handle) value = &identityRead;
  else if (observationChar && observationChar->getHandle() == request.handle) value = &observationTx.readValue;
  else if (receiptChar && receiptChar->getHandle() == request.handle) value = &receiptTx.readValue;
  else if (journalChar && journalChar->getHandle() == request.handle) value = &journalRead;
  if (!value) return false;
  if (!request.need_rsp) return true;

  esp_gatt_rsp_t response = {};
  response.attr_value.handle = request.handle;
  response.attr_value.offset = request.offset;
  response.attr_value.auth_req = ESP_GATT_AUTH_REQ_NONE;
  esp_gatt_status_t status = ESP_GATT_INSUF_AUTHORIZATION;
  portENTER_CRITICAL(&linkMux);
  if (provisioned && connected && authenticated && peerConnection == request.conn_id) {
    const bool ok = value->chunk(connectionGeneration, request.offset, peerMtu - 1,
                                 response.attr_value.value, response.attr_value.len);
    status = ok ? ESP_GATT_OK : ESP_GATT_INVALID_OFFSET;
  }
  portEXIT_CRITICAL(&linkMux);
  esp_ble_gatts_send_response(interfaceId, request.conn_id, request.trans_id, status, &response);
  return true;
}

esp_gatts_cb_t arduinoGattEvents = nullptr;
void dispatchGattEvents(esp_gatts_cb_event_t event, esp_gatt_if_t interfaceId, esp_ble_gatts_cb_param_t *param) {
  if (event == ESP_GATTS_REG_EVT && param->reg.status == ESP_GATT_OK) {
    // The firmware creates one GATT server. Its public registration event carries the interface.
    portENTER_CRITICAL(&linkMux);
    if (gattInterface == ESP_GATT_IF_NONE) gattInterface = interfaceId;
    portEXIT_CRITICAL(&linkMux);
  }
  if (event == ESP_GATTS_READ_EVT && handleProtectedGattRead(interfaceId, *param)) return;
  arduinoGattEvents(event, interfaceId, param);
}

class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer *instance, esp_ble_gatts_cb_param_t *param) override {
    portENTER_CRITICAL(&linkMux);
    const bool reject = connected || disconnected || sleepPreparing;
    if (reject) {
      portEXIT_CRITICAL(&linkMux);
      instance->disconnect(param->connect.conn_id); return;
    }
    connected = true; authenticated = false; ++connectionGeneration;
    peerConnection = param->connect.conn_id; peerMtu = 23;
    memcpy(peerAddress, param->connect.remote_bda, sizeof(peerAddress));
    portEXIT_CRITICAL(&linkMux);
    if (esp_ble_set_encryption(param->connect.remote_bda, ESP_BLE_SEC_ENCRYPT_MITM) != ESP_OK)
      instance->disconnect(param->connect.conn_id);
  }
  void onDisconnect(BLEServer *, esp_ble_gatts_cb_param_t *param) override {
    portENTER_CRITICAL(&linkMux);
    const bool current = connected && peerConnection == param->disconnect.conn_id;
    if (current) {
      connected = false; authenticated = false; disconnected = true; ++connectionGeneration;
      observationTx.setSubscribed(false); receiptTx.setSubscribed(false);
      gpio_set_level(static_cast<gpio_num_t>(board::Motor), 0);
    }
    portEXIT_CRITICAL(&linkMux);
    if (current) audio.stop();
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
    const bool current = connected && memcmp(peerAddress, result.bd_addr, sizeof(peerAddress)) == 0;
    const uint16_t connection = peerConnection;
    if (current) {
      authenticated = trusted;
      if (!trusted) gpio_set_level(static_cast<gpio_num_t>(board::Motor), 0);
    }
    portEXIT_CRITICAL(&linkMux);
    if (current && !trusted && server) server->disconnect(connection);
  }
};
void initBle() {
  BLEDevice::setCustomGattsHandler(onGattsEvent);
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
  // Keep the inert receipt subscription for existing observation clients.
  receiptChar = service->createCharacteristic(ReceiptUuid, BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
  if (!ObservationOnly) {
    commandChar = service->createCharacteristic(CommandUuid, BLECharacteristic::PROPERTY_WRITE);
    journalChar = service->createCharacteristic(JournalUuid, BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_WRITE);
    commandChar->setAccessPermissions(ESP_GATT_PERM_WRITE_ENC_MITM);
    journalChar->setAccessPermissions(ESP_GATT_PERM_READ_ENC_MITM | ESP_GATT_PERM_WRITE_ENC_MITM);
  }
  identityChar->setAccessPermissions(ESP_GATT_PERM_READ_ENC_MITM);
  observationChar->setAccessPermissions(ESP_GATT_PERM_READ_ENC_MITM);
  receiptChar->setAccessPermissions(ESP_GATT_PERM_READ_ENC_MITM);
  observationTx.characteristic = observationChar; receiptTx.characteristic = receiptChar;
  for (Tx *stream : {&observationTx, &receiptTx}) {
    stream->cccd = new BLE2902();
    stream->cccd->setAccessPermissions(ESP_GATT_PERM_READ_ENC_MITM | ESP_GATT_PERM_WRITE_ENC_MITM);
    stream->characteristic->addDescriptor(stream->cccd);
  }
  StaticJsonDocument<512> doc;
  doc["version"] = 1; doc["deviceId"] = deviceId; doc["firmwareRevision"] = FirmwareRevision;
  doc["boardRevision"] = board::Revision; doc["bootId"] = bootId;
  setGattReadValue(identityRead, jsonText(doc));
  service->start();
  BLEAdvertising *advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(ServiceUuid); advertising->setScanResponse(true);
  advertising->setMinInterval(400); advertising->setMaxInterval(800);
  advertising->start();
  radioSleepEnabled = esp_bt_sleep_enable() == ESP_OK;
}
} // namespace

extern "C" esp_err_t __real_esp_ble_gatts_register_callback(esp_gatts_cb_t callback);
extern "C" esp_err_t __wrap_esp_ble_gatts_register_callback(esp_gatts_cb_t callback) {
  if (!callback) return __real_esp_ble_gatts_register_callback(callback);
  // Arduino responds to long reads before its custom handler runs.
  // Keep its dispatcher for every other event and handle protected reads first.
  arduinoGattEvents = callback;
  return __real_esp_ble_gatts_register_callback(dispatchGattEvents);
}

namespace {
void considerSleep(uint64_t now) {
  if (!powerState::idle(now) || connected || !storageHealthy || !motion.ready() || !sensors.accel ||
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
  if (journalNvsNeedsRecovery) {
    Serial.println("KEYRING LOCKED: default NVS needs recovery; command journal preserved.");
    return;
  }
  uint64_t mac = ESP.getEfuseMac();
#ifdef KEYRING_DEVICE_ID
  strlcpy(deviceId, KEYRING_DEVICE_ID, sizeof(deviceId));
#else
  snprintf(deviceId, sizeof(deviceId), "keyring-%012llx", static_cast<unsigned long long>(mac & 0xffffffffffffULL));
#endif
  snprintf(bootId, sizeof(bootId), "%08lx%08lx%08lx%08lx", static_cast<unsigned long>(esp_random()),
      static_cast<unsigned long>(esp_random()), static_cast<unsigned long>(esp_random()), static_cast<unsigned long>(esp_random()));
  if (!ObservationOnly) loadJournal();
  initSensors();
  headphone.begin(readRegisters, writeRegister);
  supply.begin(readRegisters, writeRegister16);
  recoverAccelerometer(uptime());
  if (!ObservationOnly) {
    esp_timer_create_args_t timerArgs = {};
    timerArgs.callback = motorExpired; timerArgs.name = "motor-stop";
    if (esp_timer_create(&timerArgs, &motorTimer) != ESP_OK) motorTimer = nullptr;
    commandQueue = xQueueCreate(4, sizeof(Frame));
    journalRequests = xQueueCreate(4, sizeof(JournalRequest));
  }
  provisioned = KEYRING_PASSKEY >= 100000 && KEYRING_PASSKEY <= 999999 && identifier(deviceId)
      && (ObservationOnly || (commandQueue && journalRequests));
  if (!provisioned) {
    Serial.println("KEYRING LOCKED: set a per-device passkey and valid identity before enabling BLE.");
    return;
  }
  initializeAudioWhenQuiet(); // I2S installation also waits for the other receiver's quiet state.
  if (!ObservationOnly || KEYRING_R18_BRINGUP_DISPLAY) auxRail::begin();
  peripherals.begin();
  initBle(); sampleSensors(); publishObservation();
  Serial.printf("KEYRING ready: %s, storage=%s, radioSleep=%s\n", deviceId,
      ObservationOnly ? "disabled" : storageHealthy ? "ready" : "error",
      radioSleepEnabled ? "enabled" : "unavailable");
#if KEYRING_R18_BRINGUP
  // Retain the initial readbacks even if the USB console attaches after setup.
  const int motor = readState();
  const int aux = gpio_get_level(static_cast<gpio_num_t>(board::AuxEnable));
  const int fault = digitalRead(board::MainFaultN) == LOW;
  char imageDigest[65] = "unavailable";
  readRunningImageDigest(imageDigest);
  const int length = snprintf(bringupBootRecord, sizeof(bringupBootRecord),
      "KEYRING bringup: board=%s firmware=%s boot=%s motor=%d aux=%d fault=%d fuel=%s accel=%s motion=%s%s appSha256=%s",
      board::Revision, FirmwareRevision, bootId, motor, aux, fault, sensors.fuel ? "ok" : "unavailable",
      sensors.accel ? "ok" : "unavailable", motion.ready() ? "ready" : "unavailable", BringupPanelField, imageDigest);
  if (length > 0 && static_cast<size_t>(length) < sizeof(bringupBootRecord)) {
    Serial.println(bringupBootRecord);
  } else {
    bringupBootRecord[0] = '\0';
  }
#endif
}
void loop() {
  if (!provisioned) { delay(100); return; }
#if KEYRING_R18_BRINGUP
  if (Serial.available() > 0 && Serial.read() == '?' && bringupBootRecord[0] != '\0') {
    Serial.println(bringupBootRecord);
  }
#endif
  uint64_t now = uptime();
  if (headphone.poll(now)) observationDirty = true;
  if (!headphone.speakerAllowed()) audio.stop();
  initializeAudioWhenQuiet();
  if (connected) powerState::activity(now);
  if (disconnected) {
    stopMotor(); observationTx.clear(); receiptTx.clear();
    if (!ObservationOnly) {
      xQueueReset(commandQueue);
      xQueueReset(journalRequests); memset(&journalCapture, 0, sizeof(journalCapture));
      setGattReadValue(journalRead, {});
    }
    publishObservation(); // The next authenticated peer reads before it subscribes.
    portENTER_CRITICAL(&linkMux); disconnected = false; portEXIT_CRITICAL(&linkMux);
    BLEDevice::startAdvertising();
  }
  portENTER_CRITICAL(&linkMux);
  const bool motorExpiredNow = motorTimerFired;
  motorTimerFired = false;
  portEXIT_CRITICAL(&linkMux);
  if (motorExpiredNow || (motorStopAt && now >= motorStopAt) ||
      (!ObservationOnly && auxRail::alertInterrupted()) ||
      (!authenticated && readState()) || (digitalRead(board::MainFaultN) == LOW && readState())) {
    stopMotor();
  }
  bool changedConfirm = confirm.update(now), changedPanic = panic.update(now);
  buttonPresses.record(changedConfirm && confirm.pressed, changedPanic && panic.pressed, panic.pressed);
#if KEYRING_R18_BRINGUP_DISPLAY
  if (changedPanic && panic.pressed) displayTestButton = DisplayTestButton::Panic;
  else if (changedConfirm && confirm.pressed && !panic.pressed) displayTestButton = DisplayTestButton::Confirm;
#endif
  const bool showScreen = (changedConfirm && confirm.pressed) || (changedPanic && panic.pressed);
  const bool requestDisplay = KEYRING_R18_BRINGUP_DISPLAY && showScreen && digitalRead(board::MainFaultN) != LOW;
  if (showScreen && !KEYRING_R18_BRINGUP_DISPLAY) peripherals.show();
  if (changedConfirm || changedPanic) observationDirty = true;
  if (confirm.pressed || panic.pressed || changedConfirm || changedPanic) powerState::activity(now);
  if (motion.poll(now)) { powerState::activity(now); observationDirty = true; }
  if (!ObservationOnly) {
    // Preserve every receipt notification frame. A new command waits until its predecessor drains.
    if (receiptTx.active.empty() && receiptTx.pending.empty()) {
      if (xQueueReceive(commandQueue, &processingFrame, 0) == pdTRUE) processCommand(processingFrame);
    }
    JournalRequest journalRequest = {};
    if (xQueueReceive(journalRequests, &journalRequest, 0) == pdTRUE) processJournalRequest(journalRequest);
    if (journalCapture.active && uptime() - journalCapture.capturedAt >= 120000) {
      memset(&journalCapture, 0, sizeof(journalCapture));
      setGattReadValue(journalRead, {});
    }
  }
  supply.poll(uptime());
  recoverAccelerometer(uptime());
  if (uptime() - lastSensorRead >= board::ObserveMs) { sampleSensors(); observationDirty = true; }
  if (uptime() - lastObservation >= board::ObserveMs) observationDirty = true;
  if (observationDirty) publishObservation();
  if (!ObservationOnly || KEYRING_R18_BRINGUP_DISPLAY) auxRail::service();
  if (requestDisplay || now >= nextScreenAt) {
    KeyringScreen screen;
    screen.linked = connected; screen.authenticated = authenticated;
    screen.batteryValid = sensors.fuel; screen.battery = sensors.battery; screen.batteryLow = sensors.batteryLow;
    screen.confirm = confirm.pressed; screen.panic = panic.pressed;
#if KEYRING_R18_BRINGUP_DISPLAY
    screen.confirm = displayTestButton == DisplayTestButton::Confirm;
    screen.panic = displayTestButton == DisplayTestButton::Panic;
    screen.confirmPress = buttonPresses.confirm;
    screen.panicPress = buttonPresses.panic;
#endif
    screen.motor = readState(); screen.fault = digitalRead(board::MainFaultN) == LOW;
    screen.journal = storageHealthy; screen.motionEvents = motion.events();
    screen.supplyValid = supply.valid(uptime()); screen.supplyCurrentMa = supply.reading().currentUa / 1000.0f;
    screen.supplyReadAt = supply.reading().readAt;
    peripherals.update(screen, requestDisplay); nextScreenAt = now + 250;
  }
  if (!ObservationOnly) receiptTx.tick(now);
  observationTx.tick(now);
  if (!ObservationOnly) considerSleep(now);
  // Yield to BLE and idle tasks. Manual light-sleep is deliberately not entered with active BLE.
  delay(5);
}
