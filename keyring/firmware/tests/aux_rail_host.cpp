#include <cassert>
#include <cstdint>
#include <cstdio>
#include <utility>
#include <vector>
#include "aux_rail.h"
#include "board_r18.h"

using portMUX_TYPE = bool;
constexpr bool portMUX_INITIALIZER_UNLOCKED = false;
using gpio_num_t = int;
using esp_timer_handle_t = void *;
constexpr int ESP_OK = 0;
struct esp_timer_create_args_t {
    void (*callback)(void *);
    const char *name;
};

uint64_t timeUs = 100000;
bool faultHealthy = true;
bool motorHigh;
std::vector<std::pair<int, int>> writes;
void (*timerCallback)(void *);

void portENTER_CRITICAL(portMUX_TYPE *lock) { assert(!*lock); *lock = true; }
void portEXIT_CRITICAL(portMUX_TYPE *lock) { assert(*lock); *lock = false; }
uint64_t esp_timer_get_time() { return timeUs; }
int esp_timer_create(const esp_timer_create_args_t *args, esp_timer_handle_t *) {
    timerCallback = args->callback;
    return ESP_OK;
}
int esp_timer_start_periodic(esp_timer_handle_t, uint64_t period) {
    assert(period == 10000);
    return ESP_OK;
}
int gpio_get_level(gpio_num_t pin) {
    assert(pin == board::MainFaultN || pin == board::Motor);
    return pin == board::MainFaultN ? faultHealthy : motorHigh;
}
int gpio_set_level(gpio_num_t pin, int level) {
    writes.emplace_back(pin, level);
    return ESP_OK;
}

#include "aux_rail_subject.inc"

void tick() {
    timeUs += 10000;
    timerCallback(nullptr);
}

int main() {
    const std::vector<std::pair<int, int>> displayOn{{board::AuxEnable, 1}, {board::LcdBacklight, 0}};
    const std::vector<std::pair<int, int>> railOff{{board::LcdBacklight, 1}, {board::AuxEnable, 0}};
    assert(auxRail::begin());
    assert(auxRail::displayFor(100));
    writes.clear();
    tick();
    assert(auxRail::displayVisible() && writes == displayOn);
    std::puts("PASS display refresh keeps backlight on");

    assert(auxRail::alert(true));
    motorHigh = true;
    assert(!auxRail::displayVisible());
    faultHealthy = false;
    writes.clear();
    tick();
    assert(auxRail::alertInterrupted() && writes == railOff);
    faultHealthy = true;
    writes.clear();
    assert(auxRail::displayFor(100) && !auxRail::displayVisible() && writes == railOff);
    assert(!auxRail::alert(true));
    assert(auxRail::alert(false) && auxRail::alertInterrupted());
    assert(auxRail::busy() && !auxRail::displayVisible());
    writes.clear();
    motorHigh = false;
    assert(auxRail::alert(false) && !auxRail::alertInterrupted());
    assert(auxRail::displayVisible() && writes == displayOn);
    std::puts("PASS transient fault keeps shared rail off until motor GPIO is low");

    faultHealthy = false;
    tick();
    faultHealthy = true;
    writes.clear();
    tick();
    assert(!auxRail::busy() && !auxRail::displayVisible() && writes == railOff);
    std::puts("PASS display-only fault cancels the previous display window");
}
