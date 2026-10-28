#include <driver/gpio.h>
#include <esp_timer.h>
#include <freertos/FreeRTOS.h>
#include "aux_rail.h"
#include "board_r18.h"

namespace {
portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED;
esp_timer_handle_t timer = nullptr;
bool timerReady = false, alertOwner = false;
uint64_t displayUntil = 0;
uint64_t nowMs() { return static_cast<uint64_t>(esp_timer_get_time()) / 1000; }
bool healthy() { return gpio_get_level(static_cast<gpio_num_t>(board::MainFaultN)); }
void apply(uint64_t now) { // Caller holds mux.
  if (!healthy()) { alertOwner = false; displayUntil = 0; }
  if (now >= displayUntil) displayUntil = 0;
  const bool light = displayUntil && !alertOwner;
  // Remove load before disabling the rail; enable rail before connecting a load.
  gpio_set_level(static_cast<gpio_num_t>(board::LcdBacklight), 1);
  gpio_set_level(static_cast<gpio_num_t>(board::AuxEnable), alertOwner || light);
  if (light) gpio_set_level(static_cast<gpio_num_t>(board::LcdBacklight), 0);
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
  alertOwner = enabled && healthy();
  apply(nowMs());
  const bool result = enabled ? alertOwner : true;
  portEXIT_CRITICAL(&mux);
  return result;
}
bool auxRail::displayFor(uint32_t durationMs) {
  if (!timerReady || !durationMs || durationMs > 30000) return false;
  portENTER_CRITICAL(&mux);
  displayUntil = healthy() ? nowMs() + durationMs : 0;
  apply(nowMs());
  const bool result = displayUntil != 0;
  portEXIT_CRITICAL(&mux);
  return result;
}
void auxRail::service() {
  portENTER_CRITICAL(&mux); apply(nowMs()); portEXIT_CRITICAL(&mux);
}
bool auxRail::displayVisible() {
  portENTER_CRITICAL(&mux);
  const bool result = displayUntil > nowMs() && !alertOwner && healthy();
  portEXIT_CRITICAL(&mux);
  return result;
}
bool auxRail::busy() {
  portENTER_CRITICAL(&mux);
  const bool result = alertOwner || displayUntil > nowMs();
  portEXIT_CRITICAL(&mux);
  return result;
}
