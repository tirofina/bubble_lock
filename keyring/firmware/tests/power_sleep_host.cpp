#include <algorithm>
#include <array>
#include <cassert>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include "board_r18.h"
#include "power_state.h"

#define KEYRING_ENABLE_SLEEP 1
#define KEYRING_IDLE_SLEEP_MS 60000
#define KEYRING_SLEEP_POLL_MS 30000

using gpio_num_t = int;
constexpr int ESP_OK = 0;
constexpr int LOW = 0, HIGH = 1, INPUT = 0, INPUT_PULLUP = 1;
constexpr int ESP_SLEEP_WAKEUP_ALL = 0, ESP_SLEEP_WAKEUP_EXT0 = 1, ESP_SLEEP_WAKEUP_EXT1 = 2;
constexpr int ESP_SLEEP_WAKEUP_TIMER = 3, ESP_SLEEP_WAKEUP_UNDEFINED = 4;
constexpr int ESP_EXT1_WAKEUP_ANY_LOW = 0;
constexpr int ESP_PD_DOMAIN_RTC_PERIPH = 0, ESP_PD_OPTION_ON = 1, ESP_PD_OPTION_AUTO = 2;

std::array<bool, 49> held{};
std::array<int, 49> levels{}, inputModes{};
int failedWrite = -1, failedHold = -1;
bool auxStuckHigh, pressWhileHolding, failPull, deepHold, bleDeinitialized, sleepStarted, wakeArmed;

int esp_sleep_get_wakeup_cause() { return ESP_SLEEP_WAKEUP_UNDEFINED; }
uint64_t esp_sleep_get_ext1_wakeup_status() { return 0; }
bool esp_sleep_is_valid_wakeup_gpio(gpio_num_t) { return true; }
int esp_sleep_disable_wakeup_source(int) { wakeArmed = false; return ESP_OK; }
int esp_sleep_enable_ext0_wakeup(gpio_num_t, int) { wakeArmed = true; return ESP_OK; }
int esp_sleep_enable_ext1_wakeup(uint64_t, int) { return ESP_OK; }
int esp_sleep_enable_timer_wakeup(uint64_t) { return ESP_OK; }
int esp_sleep_pd_config(int, int) { return ESP_OK; }
int rtc_gpio_pullup_en(gpio_num_t) { return failPull ? -1 : ESP_OK; }
int rtc_gpio_pulldown_dis(gpio_num_t) { return ESP_OK; }
int rtc_gpio_deinit(gpio_num_t) { return ESP_OK; }
int digitalRead(int pin) { return levels[pin]; }
void pinMode(int pin, int mode) { inputModes[pin] = mode; }
int gpio_get_level(gpio_num_t pin) { return pin == board::AuxEnable && auxStuckHigh ? HIGH : levels[pin]; }
int gpio_set_level(gpio_num_t pin, uint32_t level) {
    assert(!held[pin]);
    if (pin == failedWrite) return -1;
    levels[pin] = static_cast<int>(level);
    return ESP_OK;
}
int gpio_hold_en(gpio_num_t pin) {
    if (pin == failedHold) return -1;
    held[pin] = true;
    if (pressWhileHolding) levels[board::Confirm] = LOW;
    return ESP_OK;
}
int gpio_hold_dis(gpio_num_t pin) { held[pin] = false; return ESP_OK; }
void gpio_deep_sleep_hold_en() { deepHold = true; }
void gpio_deep_sleep_hold_dis() { deepHold = false; }
void esp_deep_sleep_start() { assert(bleDeinitialized && deepHold && wakeArmed); sleepStarted = true; }

struct BLEDevice {
    static void deinit(bool) {
        assert(deepHold && std::count(held.begin(), held.end(), true) == 8);
        bleDeinitialized = true;
    }
};

#include "power_sleep_subject.inc"

void assertAwake(const char *expected) {
    assert(!powerState::enter());
    assert(std::strcmp(powerState::status(), expected) == 0);
    assert(!bleDeinitialized && !deepHold && !sleepStarted && !wakeArmed);
    assert(std::none_of(held.begin(), held.end(), [](bool value) { return value; }));
    assert(inputModes[board::Confirm] == INPUT_PULLUP && inputModes[board::Panic] == INPUT_PULLUP);
    assert(inputModes[board::AccelInterrupt] == INPUT);
}

int main() {
    levels[board::Confirm] = levels[board::Panic] = levels[board::MainFaultN] = HIGH;
    failedWrite = board::Motor;
    assertAwake("output_error");
    failedWrite = -1;
    failedHold = board::LcdCs;
    assertAwake("hold_error");
    failedHold = -1;
    auxStuckHigh = true;
    assertAwake("output_error");
    auxStuckHigh = false;
    failPull = true;
    assertAwake("pull_error");
    failPull = false;
    pressWhileHolding = true;
    assertAwake("active");
    pressWhileHolding = false;
    levels[board::Confirm] = HIGH;
    powerState::enter();
    assert(sleepStarted && levels[board::Motor] == LOW && levels[board::AuxEnable] == LOW);
    std::puts("PASS sleep failures leave BLE available and successful sleep holds safe outputs first");
}
