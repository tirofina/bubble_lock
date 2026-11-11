#include <driver/gpio.h>
#include <esp_timer.h>
#include <freertos/FreeRTOS.h>
#include "aux_rail.h"
#include "board_r18.h"

namespace {
portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED;
esp_timer_handle_t timer = nullptr;
bool timerReady = false, alertOwner = false, alertWasInterrupted = false;
bool displayDriveFault = false;
uint64_t displayUntil = 0;
uint64_t nowMs() { return static_cast<uint64_t>(esp_timer_get_time()) / 1000; }
bool healthy() { return gpio_get_level(static_cast<gpio_num_t>(board::MainFaultN)); }
bool railEnabled() { return gpio_get_level(static_cast<gpio_num_t>(board::AuxEnable)) != 0; }
bool backlightOn() { return gpio_get_level(static_cast<gpio_num_t>(board::LcdBacklight)) == 0; }
void interruptAlert() { // Caller holds mux.
  alertOwner = false;
  alertWasInterrupted = true;
  displayUntil = 0;
  gpio_set_level(static_cast<gpio_num_t>(board::AuxEnable), 0);
}
void apply(uint64_t now) { // Caller holds mux.
  if (!healthy()) {
    alertWasInterrupted = alertWasInterrupted || alertOwner;
    alertOwner = false;
    displayUntil = 0;
  }
  if (now >= displayUntil) displayUntil = 0;
  const bool light = displayUntil && !alertOwner && !alertWasInterrupted;
  const auto rail = static_cast<gpio_num_t>(board::AuxEnable);
  const auto backlight = static_cast<gpio_num_t>(board::LcdBacklight);
  if (light) {
    if (gpio_set_level(rail, 1) == ESP_OK && railEnabled() &&
        gpio_set_level(backlight, 0) == ESP_OK && backlightOn()) return;
    displayDriveFault = true;
    displayUntil = 0;
  }

  // Disconnect the backlight before turning off AUX or handing it to the alert.
  if (gpio_set_level(backlight, 1) != ESP_OK || backlightOn()) {
    displayDriveFault = true;
    if (alertOwner) {
      interruptAlert();
      return;
    }
  }
  const auto railWrite = gpio_set_level(rail, alertOwner && !alertWasInterrupted);
  if (alertOwner && (railWrite != ESP_OK || !railEnabled())) interruptAlert();
}
void expired(void *) { auxRail::service(); }
}

bool auxRail::begin() {
  esp_timer_create_args_t args = {};
  args.callback = expired; args.name = "aux-rail";
  timerReady = esp_timer_create(&args, &timer) == ESP_OK &&
      esp_timer_start_periodic(timer, 10000) == ESP_OK;
  service();
  return timerReady;
}
bool auxRail::alert(bool enabled) {
  portENTER_CRITICAL(&mux);
  if (enabled) {
    if (!alertWasInterrupted && healthy()) alertOwner = true;
  } else {
    alertOwner = false;
    // Motor shutdown precedes releasing the shared rail to another owner.
    alertWasInterrupted = gpio_get_level(static_cast<gpio_num_t>(board::Motor)) != 0;
  }
  apply(nowMs());
  const bool result = enabled ? alertOwner : true;
  portEXIT_CRITICAL(&mux);
  return result;
}
bool auxRail::alertInterrupted() {
  portENTER_CRITICAL(&mux);
  if (alertOwner) {
    const bool backlightActive = backlightOn();
    if (backlightActive) displayDriveFault = true;
    if (!healthy() || !railEnabled() || backlightActive) interruptAlert();
  }
  const bool result = alertWasInterrupted;
  portEXIT_CRITICAL(&mux);
  return result;
}
bool auxRail::displayFor(uint32_t durationMs) {
  if (!durationMs || durationMs > 30000) return false;
  portENTER_CRITICAL(&mux);
  const uint64_t now = nowMs();
  displayDriveFault = !timerReady;
  displayUntil = timerReady && healthy() ? now + durationMs : 0;
  apply(now);
  const bool result = displayUntil != 0;
  portEXIT_CRITICAL(&mux);
  return result;
}
void auxRail::service() {
  portENTER_CRITICAL(&mux); apply(nowMs()); portEXIT_CRITICAL(&mux);
}
bool auxRail::displayVisible() {
  portENTER_CRITICAL(&mux);
  const bool result = displayUntil > nowMs() && !alertOwner && !alertWasInterrupted &&
      healthy() && railEnabled() && backlightOn();
  portEXIT_CRITICAL(&mux);
  return result;
}
bool auxRail::displayOutputFault() {
  portENTER_CRITICAL(&mux);
  const bool result = displayDriveFault;
  portEXIT_CRITICAL(&mux);
  return result;
}
bool auxRail::busy() {
  portENTER_CRITICAL(&mux);
  const bool result = alertOwner || alertWasInterrupted || displayUntil > nowMs();
  portEXIT_CRITICAL(&mux);
  return result;
}
