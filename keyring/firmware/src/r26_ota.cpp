#include "firmware_options.h"

#if defined(KEYRING_R26_OTA)
#include <Arduino.h>
#include <ArduinoOTA.h>
#include <WiFi.h>
#include <esp_ota_ops.h>
#include <cstring>
#include "r26_ota.h"

// Arduino normally accepts a new image before setup. Keep it pending until
// this firmware has initialized its display and joined a configured network.
extern "C" bool verifyRollbackLater() { return true; }

namespace {
struct Network {
  const char *ssid;
  const char *password;
};

// These values come from a device-specific header outside the repository.
const Network networks[] = KEYRING_OTA_NETWORKS;
static_assert(sizeof(KEYRING_OTA_PASSWORD) >= 13, "OTA password must contain at least 12 characters");
static_assert(sizeof(networks) / sizeof(networks[0]) > 0, "Configure at least one Wi-Fi network");
bool (*displayIsReady)() = nullptr;

bool pendingImage() {
  esp_ota_img_states_t state;
  const esp_partition_t *running = esp_ota_get_running_partition();
  return running && esp_ota_get_state_partition(running, &state) == ESP_OK &&
      state == ESP_OTA_IMG_PENDING_VERIFY;
}

void run(void *) {
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(false);
  ArduinoOTA.setHostname(KEYRING_OTA_HOSTNAME);
  ArduinoOTA.setPassword(KEYRING_OTA_PASSWORD);
  ArduinoOTA.setRebootOnSuccess(true);

  size_t next = 0;
  bool started = false;
  const uint32_t verificationStarted = millis();
  for (;;) {
    if (pendingImage()) {
      if (WiFi.status() == WL_CONNECTED && displayIsReady && displayIsReady()) {
        if (esp_ota_mark_app_valid_cancel_rollback() != ESP_OK) ESP.restart();
      } else if (millis() - verificationStarted >= 120000) {
        esp_ota_mark_app_invalid_rollback_and_reboot();
        ESP.restart();
      }
    }
    if (WiFi.status() != WL_CONNECTED) {
      if (started) {
        ArduinoOTA.end();
        started = false;
      }
      WiFi.disconnect(false, false);
      const Network &network = networks[next];
      next = (next + 1) % (sizeof(networks) / sizeof(networks[0]));
      WiFi.begin(network.ssid, network.password);
      const uint32_t startedAt = millis();
      while (WiFi.status() != WL_CONNECTED && millis() - startedAt < 15000) {
        vTaskDelay(pdMS_TO_TICKS(250));
      }
      if (WiFi.status() != WL_CONNECTED) {
        vTaskDelay(pdMS_TO_TICKS(2000));
        continue;
      }
    }
    if (!started) {
      ArduinoOTA.begin();
      started = true;
      Serial.print("KEYRING OTA ready at ");
      Serial.println(WiFi.localIP());
    }
    ArduinoOTA.handle();
    vTaskDelay(pdMS_TO_TICKS(20));
  }
}
}

namespace r26ota {
void rejectPending() {
  if (pendingImage()) esp_ota_mark_app_invalid_rollback_and_reboot();
}

void begin(bool (*displayReady)()) {
  displayIsReady = displayReady;
  if (xTaskCreate(run, "r26-ota", 8192, nullptr, 1, nullptr) != pdPASS) {
    Serial.println("KEYRING OTA task unavailable");
    rejectPending();
  }
}
}
#endif
