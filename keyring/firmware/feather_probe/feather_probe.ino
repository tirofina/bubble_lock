// Adafruit Feather ESP32 V2 with the 240x240 ST7789 bench wiring.
// Uses the KEYRING CORE v1 GATT observation and identity contract.
#include <Arduino.h>
#include <Adafruit_ST7789.h>
#include <BLE2902.h>
#include <BLEDevice.h>
#include <BLESecurity.h>
#include <esp_timer.h>

#if !defined(ARDUINO_ADAFRUIT_FEATHER_ESP32_V2)
#error Select Adafruit Feather ESP32 V2
#endif
#if __has_include("provisioning.h")
#include "provisioning.h"
#endif
#ifndef KEYRING_FEATHER_PASSKEY
#define KEYRING_FEATHER_PASSKEY 0
#endif
static_assert(KEYRING_FEATHER_PASSKEY == 0 ||
              (KEYRING_FEATHER_PASSKEY >= 100000 && KEYRING_FEATHER_PASSKEY <= 999999),
              "Set a six digit local Feather passkey");

namespace {
constexpr char DeviceId[] = "keyring-feather-lab";
constexpr char ServiceId[] = "7f8a0001-4b6e-4f4e-9b0a-505249564255";
constexpr char ObservationId[] = "7f8a0002-4b6e-4f4e-9b0a-505249564255";
constexpr char ReceiptId[] = "7f8a0004-4b6e-4f4e-9b0a-505249564255";
constexpr char IdentityId[] = "7f8a0005-4b6e-4f4e-9b0a-505249564255";
constexpr auto ReadPermission = ESP_GATT_PERM_READ_ENC_MITM;
constexpr auto CccdPermission = ESP_GATT_PERM_READ_ENC_MITM | ESP_GATT_PERM_WRITE_ENC_MITM;
constexpr bool Provisioned = KEYRING_FEATHER_PASSKEY != 0;

Adafruit_ST7789 display(32, 33, 27);
BLEServer *server;
BLECharacteristic *observation;
char bootId[17];
char frame[320], txFrame[sizeof(frame)];
size_t frameSize, txSize, txOffset;
uint32_t sequence, lastSample, lastFragment;
bool observationPending;

enum class ButtonState { Released, Confirm, Panic };
struct Button {
  explicit Button(int gpio) : pin(gpio) {}
  const int pin;
  bool candidate = false, pressed = false;
  uint32_t changedAt = 0;
  void update(uint32_t now) {
    const bool sample = digitalRead(pin) == LOW;
    if (sample != candidate) {
      candidate = sample;
      changedAt = now;
    }
    if (now - changedAt >= 35) pressed = candidate;
  }
};
Button confirm(A0), panic(A1);

struct Link {
  uint32_t generation = 0;
  uint16_t id = 0;
  esp_gatt_if_t interfaceId = ESP_GATT_IF_NONE;
  bool connected = false, trusted = false, subscribed = false;
};
Link link;
uint8_t peerAddress[6];
portMUX_TYPE linkMux = portMUX_INITIALIZER_UNLOCKED;

Link currentLink() {
  portENTER_CRITICAL(&linkMux);
  const auto snapshot = link;
  portEXIT_CRITICAL(&linkMux);
  return snapshot;
}

void onGattsEvent(esp_gatts_cb_event_t event, esp_gatt_if_t interfaceId, esp_ble_gatts_cb_param_t *param) {
  if (event == ESP_GATTS_REG_EVT && param->reg.status == ESP_GATT_OK) {
    portENTER_CRITICAL(&linkMux);
    link.interfaceId = interfaceId;
    portEXIT_CRITICAL(&linkMux);
  }
}

class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer *instance, esp_ble_gatts_cb_param_t *event) override {
    portENTER_CRITICAL(&linkMux);
    const bool busy = link.connected;
    if (!busy) {
      ++link.generation;
      link.id = event->connect.conn_id;
      link.connected = true;
      link.trusted = link.subscribed = false;
      memcpy(peerAddress, event->connect.remote_bda, sizeof(peerAddress));
    }
    portEXIT_CRITICAL(&linkMux);
    if (busy) {
      instance->disconnect(event->connect.conn_id);
    } else if (esp_ble_set_encryption(event->connect.remote_bda, ESP_BLE_SEC_ENCRYPT_MITM) != ESP_OK) {
      instance->disconnect(event->connect.conn_id);
    }
  }
  void onDisconnect(BLEServer *, esp_ble_gatts_cb_param_t *event) override {
    portENTER_CRITICAL(&linkMux);
    if (link.connected && link.id == event->disconnect.conn_id) {
      ++link.generation;
      link.connected = link.trusted = link.subscribed = false;
    }
    portEXIT_CRITICAL(&linkMux);
  }
};

class SecurityCallbacks : public BLESecurityCallbacks {
  bool onSecurityRequest() override { return Provisioned; }
  bool onConfirmPIN(uint32_t) override { return false; }
  void onPassKeyNotify(uint32_t) override {}
  uint32_t onPassKeyRequest() override { return KEYRING_FEATHER_PASSKEY; }
  void onAuthenticationComplete(esp_ble_auth_cmpl_t event) override {
    const auto required = ESP_LE_AUTH_REQ_SC_MITM_BOND;
    const bool trusted = event.success && (event.auth_mode & required) == required;
    portENTER_CRITICAL(&linkMux);
    const bool isCurrent = link.connected && memcmp(peerAddress, event.bd_addr, sizeof(peerAddress)) == 0;
    const auto id = link.id;
    if (isCurrent) link.trusted = trusted;
    portEXIT_CRITICAL(&linkMux);
    if (isCurrent && !trusted) server->disconnect(id);
  }
};

class SubscriptionCallbacks : public BLEDescriptorCallbacks {
  void onWrite(BLEDescriptor *descriptor) override {
    const bool enabled = static_cast<BLE2902 *>(descriptor)->getNotifications();
    portENTER_CRITICAL(&linkMux);
    link.subscribed = link.connected && enabled;
    portEXIT_CRITICAL(&linkMux);
  }
};

void addCccd(BLECharacteristic *characteristic, bool observeSubscription = false) {
  auto *cccd = new BLE2902();
  cccd->setAccessPermissions(CccdPermission);
  if (observeSubscription) cccd->setCallbacks(new SubscriptionCallbacks());
  characteristic->addDescriptor(cccd);
}

void render(ButtonState button, bool trusted) {
  display.fillRect(8, 48, 224, 135, ST77XX_BLACK);
  display.setCursor(8, 55);
  display.setTextColor(trusted ? ST77XX_GREEN : ST77XX_WHITE);
  display.print(Provisioned ? (trusted ? "BLE CONNECTED" : "BLE WAITING") : "BLE LOCKED");
  display.setCursor(8, 110);
  display.setTextColor(button == ButtonState::Panic ? ST77XX_RED :
                       button == ButtonState::Confirm ? ST77XX_GREEN : ST77XX_WHITE);
  display.print(button == ButtonState::Panic ? "A1 PANIC" :
                button == ButtonState::Confirm ? "A0 CONFIRMED" : "READY");
}

void sample(ButtonState button) {
  const char *value = button == ButtonState::Panic ? "panic" :
                      button == ButtonState::Confirm ? "confirm" : "released";
  const int length = snprintf(frame, sizeof(frame),
      "{\"version\":1,\"deviceId\":\"%s\",\"bootId\":\"%s\",\"sequence\":%lu,\"uptimeMs\":%llu,"
      "\"battery\":null,\"buttonState\":\"%s\",\"sensorValues\":{},\"state\":false}\n",
      DeviceId, bootId, static_cast<unsigned long>(sequence++),
      static_cast<unsigned long long>(esp_timer_get_time() / 1000), value);
  if (length < 1 || static_cast<size_t>(length) >= sizeof(frame)) return;
  frameSize = static_cast<size_t>(length);
  if (observation) observation->setValue(reinterpret_cast<const uint8_t *>(frame), frameSize - 1);
  observationPending = true;
}

void initBle() {
  BLEDevice::init(DeviceId);
  BLEDevice::setSecurityCallbacks(new SecurityCallbacks());
  BLESecurity::setPassKey(true, KEYRING_FEATHER_PASSKEY);
  BLESecurity::setAuthenticationMode(ESP_LE_AUTH_REQ_SC_MITM_BOND);
  BLESecurity::setCapability(ESP_IO_CAP_OUT);
  BLESecurity::setEncryptionLevel(ESP_BLE_SEC_ENCRYPT_MITM);
  BLEDevice::setCustomGattsHandler(onGattsEvent);
  server = BLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());
  server->advertiseOnDisconnect(true);
  auto *service = server->createService(ServiceId);
  auto *identity = service->createCharacteristic(IdentityId, BLECharacteristic::PROPERTY_READ);
  identity->setAccessPermissions(ReadPermission);
  char identityJson[240];
  snprintf(identityJson, sizeof(identityJson),
      "{\"version\":1,\"deviceId\":\"%s\",\"boardRevision\":\"feather-esp32-v2\","
      "\"firmwareRevision\":\"feather-probe-0.1.0\",\"bootId\":\"%s\"}", DeviceId, bootId);
  identity->setValue(String(identityJson));
  constexpr auto readNotify = BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY;
  observation = service->createCharacteristic(ObservationId, readNotify);
  observation->setAccessPermissions(ReadPermission);
  observation->setValue(reinterpret_cast<const uint8_t *>(frame), frameSize - 1);
  addCccd(observation, true);
  // Gateway discovery subscribes to this characteristic. The bench has no actuator.
  auto *receipt = service->createCharacteristic(ReceiptId, readNotify);
  receipt->setAccessPermissions(ReadPermission);
  addCccd(receipt);
  service->start();
  auto *advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(ServiceId);
  advertising->setScanResponse(true);
  advertising->start();
}

void pumpObservation(Link session, uint32_t now) {
  static uint32_t generation;
  if (generation != session.generation || !session.subscribed) {
    generation = session.generation;
    txOffset = txSize = 0;
    observationPending = true;
  }
  if (!session.trusted || !session.subscribed || session.interfaceId == ESP_GATT_IF_NONE ||
      now - lastFragment < 15) return;
  if (!txSize) {
    if (!observationPending) return;
    memcpy(txFrame, frame, frameSize);
    txSize = frameSize;
    observationPending = false;
  }
  const auto count = static_cast<uint16_t>(min(size_t(20), txSize - txOffset));
  // Keep the characteristic value as a complete JSON document for GATT READ.
  const auto status = esp_ble_gatts_send_indicate(session.interfaceId,
      session.id, observation->getHandle(), count, reinterpret_cast<uint8_t *>(txFrame + txOffset), false);
  lastFragment = now;
  if (status == ESP_OK) {
    txOffset += count;
    if (txOffset == txSize) txOffset = txSize = 0;
  }
}
}  // namespace

void setup() {
  Serial.begin(115200);
  pinMode(A0, INPUT_PULLUP);
  pinMode(A1, INPUT_PULLUP);
  snprintf(bootId, sizeof(bootId), "%08lx%08lx", static_cast<unsigned long>(esp_random()),
           static_cast<unsigned long>(esp_random()));
  display.init(240, 240);
  display.setSPISpeed(10000000);
  display.setTextSize(2);
  display.setTextWrap(false);
  display.fillScreen(ST77XX_BLACK);
  display.setCursor(8, 12);
  display.setTextColor(ST77XX_WHITE);
  display.print("KEYRING FEATHER");
  render(ButtonState::Released, false);
  sample(ButtonState::Released);
  if (Provisioned) initBle();
  Serial.println(Provisioned ? "FEATHER PROBE READY" : "FEATHER PROBE READY (BLE LOCKED)");
}

void loop() {
  static ButtonState previous = ButtonState::Released;
  static bool wasTrusted = false;
  const uint32_t now = millis();
  confirm.update(now);
  panic.update(now);
  const auto button = panic.pressed ? ButtonState::Panic :
                      confirm.pressed ? ButtonState::Confirm : ButtonState::Released;
  const auto session = currentLink();
  if (button != previous || session.trusted != wasTrusted) render(button, session.trusted);
  if (button != previous || now - lastSample >= 2000) {
    sample(button);
    lastSample = now;
  }
  previous = button;
  wasTrusted = session.trusted;
  pumpObservation(session, now);
  delay(2);
}
