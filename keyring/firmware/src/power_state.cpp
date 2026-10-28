#include <Arduino.h>
#include <BLEDevice.h>
#include <driver/gpio.h>
#include <driver/rtc_io.h>
#include <esp_sleep.h>
#include <esp_system.h>
#include "board_r18.h"
#include "firmware_options.h"
#include "power_state.h"

namespace {
uint64_t lastActivity = 0, pins = 0;
const char *cause = "cold";
const char *phase = KEYRING_ENABLE_SLEEP ? "active" : "disabled";
constexpr uint64_t buttonMask = (1ULL << board::Confirm) | (1ULL << board::Panic);
void releaseHolds() {
  for (int pin : {board::Motor, board::AuxEnable, board::AmpMute, board::LcdBacklight,
                  board::LcdCs, board::SdCs, board::UsbEn1, board::UsbEn2})
    gpio_hold_dis(static_cast<gpio_num_t>(pin));
  gpio_deep_sleep_hold_dis();
  for (int pin : {board::Confirm, board::Panic, board::AccelInterrupt})
    rtc_gpio_deinit(static_cast<gpio_num_t>(pin));
}
}

void powerState::begin() {
  const auto source = esp_sleep_get_wakeup_cause();
  pins = source == ESP_SLEEP_WAKEUP_EXT1 ? esp_sleep_get_ext1_wakeup_status() : 0;
  cause = source == ESP_SLEEP_WAKEUP_EXT0 ? "motion" :
          source == ESP_SLEEP_WAKEUP_EXT1 ? "button" :
          source == ESP_SLEEP_WAKEUP_TIMER ? "timer" :
          source == ESP_SLEEP_WAKEUP_UNDEFINED ? "cold" : "other";
  releaseHolds();
  lastActivity = 0;
}
const char *powerState::wakeCause() { return cause; }
uint64_t powerState::wakePins() { return pins; }
bool powerState::sleepEnabled() { return KEYRING_ENABLE_SLEEP != 0; }
const char *powerState::status() { return phase; }
void powerState::activity(uint64_t now) { lastActivity = now; }
bool powerState::idle(uint64_t now) {
  return KEYRING_ENABLE_SLEEP && now - lastActivity >= KEYRING_IDLE_SLEEP_MS;
}

bool powerState::enter() {
  if (!KEYRING_ENABLE_SLEEP) return false;
  phase = "arming";
  // GPIOs are checked at runtime because the build target is a custom ESP32-S3.
  for (int pin : {board::Confirm, board::Panic, board::AccelInterrupt}) {
    if (!esp_sleep_is_valid_wakeup_gpio(static_cast<gpio_num_t>(pin))) {
      phase = "unsupported_pin"; return false;
    }
  }
  // Main loop already required a configured, idle motion source. Buttons must
  // remain released. A new asserted level later wakes the RTC controller.
  if (digitalRead(board::Confirm) == LOW || digitalRead(board::Panic) == LOW ||
      digitalRead(board::AccelInterrupt) == HIGH) { phase = "active"; return false; }
  esp_sleep_disable_wakeup_source(ESP_SLEEP_WAKEUP_ALL);
  // ESP-IDF 4.4 ESP32-S3 supports EXT0 high plus EXT1 ANY_LOW for the two buttons.
  if (esp_sleep_enable_ext0_wakeup(static_cast<gpio_num_t>(board::AccelInterrupt), 1) != ESP_OK ||
      esp_sleep_enable_ext1_wakeup(buttonMask, ESP_EXT1_WAKEUP_ANY_LOW) != ESP_OK ||
      esp_sleep_enable_timer_wakeup(static_cast<uint64_t>(KEYRING_SLEEP_POLL_MS) * 1000) != ESP_OK ||
      esp_sleep_pd_config(ESP_PD_DOMAIN_RTC_PERIPH, ESP_PD_OPTION_ON) != ESP_OK) {
    esp_sleep_disable_wakeup_source(ESP_SLEEP_WAKEUP_ALL);
    phase = "arm_error"; return false;
  }
  for (int pin : {board::Confirm, board::Panic}) {
    if (rtc_gpio_pullup_en(static_cast<gpio_num_t>(pin)) != ESP_OK ||
        rtc_gpio_pulldown_dis(static_cast<gpio_num_t>(pin)) != ESP_OK) {
      esp_sleep_disable_wakeup_source(ESP_SLEEP_WAKEUP_ALL);
      releaseHolds(); phase = "pull_error"; return false;
    }
  }
  // Stop the BLE stack only after wake arming succeeds. Reboot on deep wake
  // restores it from setup; no stale callback/session object survives sleep.
  BLEDevice::deinit(false);
  for (int pin : {board::Motor, board::AuxEnable, board::UsbEn1, board::UsbEn2})
    gpio_set_level(static_cast<gpio_num_t>(pin), 0);
  for (int pin : {board::AmpMute, board::LcdBacklight, board::LcdCs, board::SdCs})
    gpio_set_level(static_cast<gpio_num_t>(pin), 1);
  for (int pin : {board::Motor, board::AuxEnable, board::AmpMute, board::LcdBacklight,
                  board::LcdCs, board::SdCs, board::UsbEn1, board::UsbEn2}) {
    if (gpio_hold_en(static_cast<gpio_num_t>(pin)) != ESP_OK) {
      // Stack was deinitialized. Restart safely rather than running with a dead link.
      esp_restart();
    }
  }
  gpio_deep_sleep_hold_en();
  esp_deep_sleep_start();
  return false;
}
