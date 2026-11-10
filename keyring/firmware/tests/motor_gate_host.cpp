#include <algorithm>
#include <cassert>
#include <cstdint>
#include <cstdio>
#include <functional>
#include <initializer_list>
#include <string>
#include <vector>
#include "board_r18.h"

using std::min;
using gpio_num_t = int;
constexpr int ESP_OK = 0;
bool connected, authenticated, disconnected, motorTimerFired, motorTimerCleaning;
bool padHigh, railOn, faultHealthy, observationDirty;
uint32_t connectionGeneration;
uint64_t nowUs, motorStopAt, timerDelay;
int timerHandle, *motorTimer, timerResult;
bool linkMux;
std::vector<std::string> events;
std::function<void()> duringTimerArm, duringRailEnable, duringAudioStop;

void portENTER_CRITICAL(bool *lock) { assert(!*lock); *lock = true; }
void portEXIT_CRITICAL(bool *lock) { assert(*lock); *lock = false; }
int64_t esp_timer_get_time() { return nowUs; }
int esp_timer_stop(int *) { return ESP_OK; }
int esp_timer_start_once(int *, uint64_t delay) {
    assert(!linkMux && !padHigh && !railOn);
    timerDelay = delay;
    events.push_back("arm");
    if (duringTimerArm) duringTimerArm();
    return timerResult;
}
int gpio_get_level(gpio_num_t pin) {
    assert(pin == board::MainFaultN);
    return faultHealthy;
}
int gpio_set_level(gpio_num_t pin, int level) {
    assert(pin == board::Motor);
    if (level) assert(linkMux && railOn && timerResult == ESP_OK);
    padHigh = level;
    events.push_back(level ? "motor-on" : "motor-off");
    return ESP_OK;
}
struct FakeAudio {
    void stop() { if (duringAudioStop) duringAudioStop(); }
} audio;
namespace auxRail {
bool alert(bool enabled) {
    if (enabled) {
        assert(linkMux);
        if (duringRailEnable) duringRailEnable();
    }
    railOn = enabled;
    events.push_back(enabled ? "rail-on" : "rail-off");
    return true;
}
}

#include "motor_gate_subject.inc"
struct BLEServer {};
struct BleCallbacks {
    virtual void onDisconnect(BLEServer *) = 0;
};
struct ServerCallbacks : BleCallbacks {
#include "motor_disconnect_subject.inc"
};

void reset() {
    connected = authenticated = faultHealthy = true;
    disconnected = motorTimerFired = motorTimerCleaning = padHigh = railOn = observationDirty = linkMux = false;
    connectionGeneration = 7;
    nowUs = 100000;
    motorStopAt = timerDelay = 0;
    motorTimer = &timerHandle;
    timerResult = ESP_OK;
    events.clear();
    duringTimerArm = duringRailEnable = duringAudioStop = {};
}

int main() {
    reset();
    timerResult = 1;
    assert(!startMotor(120000, 7));
    assert(events == std::vector<std::string>{"arm"} && !padHigh && !railOn);
    std::puts("PASS timer failure leaves rail and motor off");

    reset();
    assert(startMotor(120000, 7));
    assert((events == std::vector<std::string>{"arm", "rail-on", "motor-on"}));
    assert(timerDelay == 20000 && motorStopAt == 120 && padHigh);
    motorExpired(nullptr);
    assert(!padHigh && !railOn && motorTimerFired);
    reset();
    assert(startMotor(3000000, 7));
    assert(timerDelay == board::MotorMaxOnMs * 1000 && motorStopAt == 1100);
    std::puts("PASS timer precedes rail and motor, obeys the shorter bound, and clears output");

    reset();
    assert(!startMotor(nowUs, 7) && events.empty());
    duringTimerArm = [] { nowUs = 120000; };
    assert(!startMotor(120000, 7) && !padHigh && !railOn);
    reset();
    duringRailEnable = [] { nowUs = 120000; };
    assert(!startMotor(120000, 7) && !padHigh);
    stopMotor();
    assert(!railOn);
    std::puts("PASS elapsed deadline blocks GPIO before or after rail preparation");

    reset();
    duringTimerArm = [] { ServerCallbacks{}.onDisconnect(nullptr); };
    assert(!startMotor(120000, 7) && disconnected && connectionGeneration == 8 && !padHigh && !railOn);
    reset();
    assert(startMotor(120000, 7) && padHigh);
    ServerCallbacks{}.onDisconnect(nullptr);
    assert(!padHigh && disconnected);
    std::puts("PASS disconnect blocks stale starts and turns an active GPIO off immediately");

    reset();
    duringRailEnable = [] { faultHealthy = false; };
    assert(!startMotor(120000, 7) && !padHigh);
    stopMotor();
    assert(!railOn);
    std::puts("PASS fault is rechecked after rail preparation");

    reset();
    duringTimerArm = [] { motorExpired(nullptr); };
    duringAudioStop = [] {
        assert(motorTimerCleaning && !startMotor(120000, 7));
    };
    assert(!startMotor(120000, 7) && !padHigh && !railOn);
    std::puts("PASS expiration fences reactivation during callback cleanup");
}
