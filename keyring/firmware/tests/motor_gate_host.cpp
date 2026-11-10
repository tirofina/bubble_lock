#include <algorithm>
#include <cassert>
#include <cstdint>
#include <cstdio>
#include <cstring>
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

constexpr unsigned JournalSlots = 32, MaxFrame = 4096;
using esp_gatt_if_t = uint8_t;
constexpr esp_gatt_if_t ESP_GATT_IF_NONE = 255;
enum esp_gatts_cb_event_t { ESP_GATTS_WRITE_EVT };
struct esp_ble_gatts_cb_param_t {
    struct { uint16_t conn_id; } disconnect;
    struct {
        uint16_t conn_id, handle, offset, len;
        const uint8_t *value;
        bool is_prep, need_rsp;
    } write;
};
struct BLEServer { uint16_t getGattsIf() const { return 4; } };
struct BLECharacteristic {
    uint16_t handle = 0;
    std::string readValue;
    uint16_t getHandle() const { return handle; }
    void setValue(const std::string &value) { readValue = value; }
};
struct BLE2902 {
    uint16_t handle = 0;
    uint16_t getHandle() const { return handle; }
};
struct Frame { char bytes[MaxFrame + 1]; uint64_t firstAt, completedAt; uint32_t generation; };
struct JournalRequest { uint32_t id, generation; uint8_t operation, index, part; };
BLEServer fixtureServer, *server = &fixtureServer;
BLECharacteristic fixtureCommand, fixtureJournal, fixtureReceipt;
BLECharacteristic *commandChar = &fixtureCommand, *journalChar = &fixtureJournal;
BLE2902 fixtureCccd;
uint16_t peerConnection = 7;
bool provisioned = true;
Frame queuedCommand;
unsigned commandCount = 0, journalCount = 0;
int commandQueue = 1, journalRequests = 2, notifyResult = ESP_OK;
std::vector<std::string> notifications;
uint64_t uptime() { return nowUs / 1000; }
void xQueueSend(int queue, const void *value, int) {
    if (queue == commandQueue) {
        queuedCommand = *static_cast<const Frame *>(value);
        ++commandCount;
    } else {
        assert(queue == journalRequests);
        ++journalCount;
    }
}
int esp_ble_gatts_send_indicate(esp_gatt_if_t interfaceId, uint16_t connection, uint16_t attribute,
                               uint16_t length, uint8_t *bytes, bool confirm) {
    assert(interfaceId == 4 && connection == peerConnection && attribute == fixtureReceipt.handle && !confirm);
    notifications.emplace_back(reinterpret_cast<const char *>(bytes), length);
    return notifyResult;
}
#include "motor_session_subject.inc"

struct BleCallbacks {
    virtual void onDisconnect(BLEServer *, esp_ble_gatts_cb_param_t *) = 0;
};
struct ServerCallbacks : BleCallbacks {
#include "motor_disconnect_subject.inc"
};

void disconnect(uint16_t connection) {
    esp_ble_gatts_cb_param_t event{};
    event.disconnect.conn_id = connection;
    ServerCallbacks{}.onDisconnect(nullptr, &event);
}

void write(uint16_t connection, uint16_t handle, const std::string &bytes, bool prepared = false) {
    esp_ble_gatts_cb_param_t event{};
    event.write = {connection, handle, 0, static_cast<uint16_t>(bytes.size()),
                   reinterpret_cast<const uint8_t *>(bytes.data()), prepared, true};
    onGattsEvent(ESP_GATTS_WRITE_EVT, 4, &event);
}

void reset() {
    connected = authenticated = faultHealthy = true;
    disconnected = motorTimerFired = motorTimerCleaning = padHigh = railOn = observationDirty = linkMux = false;
    connectionGeneration = 7;
    peerConnection = 7;
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
    duringTimerArm = [] { disconnect(peerConnection); };
    assert(!startMotor(120000, 7) && disconnected && connectionGeneration == 8 && !padHigh && !railOn);
    reset();
    assert(startMotor(120000, 7) && padHigh);
    disconnect(8);
    assert(padHigh && connected && authenticated && connectionGeneration == 7 && !disconnected);
    disconnect(peerConnection);
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

    reset();
    fixtureCommand.handle = 1; fixtureJournal.handle = 2; fixtureReceipt.handle = 3; fixtureCccd.handle = 4;
    receiptTx.characteristic = &fixtureReceipt;
    receiptTx.cccd = &fixtureCccd;
    receiptTx.clear();
    const std::string enable("\1\0", 2);
    write(8, fixtureCccd.handle, enable);
    write(peerConnection, fixtureCommand.handle, "before subscribe\n");
    assert(!receiptTx.subscribed && commandCount == 0);
    write(peerConnection, fixtureCccd.handle, enable);
    write(peerConnection, fixtureCommand.handle, "prepared\n", true);
    write(peerConnection, fixtureCommand.handle, "good");
    write(8, fixtureCommand.handle, "foreign\n");
    write(8, fixtureJournal.handle, std::string("\1\1\0\0\0\0\0\0", 8));
    write(peerConnection, fixtureCommand.handle, " frame\n");
    assert(commandCount == 1 && journalCount == 0 && queuedCommand.generation == 7 &&
           std::strcmp(queuedCommand.bytes, "good frame") == 0);

    receiptTx.queue(std::string(22, 'a'));
    notifyResult = 1;
    receiptTx.tick(100);
    assert(notifications.size() == 1 && receiptTx.offset == 0);
    notifyResult = ESP_OK;
    receiptTx.tick(115);
    assert(notifications.back() == notifications.front() && receiptTx.offset == 20);
    write(peerConnection, fixtureCommand.handle, "before re-subscribe");
    write(peerConnection, fixtureCccd.handle, std::string(2, '\0'));
    write(peerConnection, fixtureCccd.handle, enable);
    write(peerConnection, fixtureCommand.handle, "after\n");
    assert(commandCount == 2 && std::strcmp(queuedCommand.bytes, "after") == 0);
    receiptTx.tick(130);
    assert(notifications.back() == notifications.front() && receiptTx.offset == 20);
    receiptTx.clear();
    assert(fixtureReceipt.readValue.empty());

    write(peerConnection, fixtureCommand.handle, "stale");
    disconnect(peerConnection);
    connected = authenticated = true;
    disconnected = false;
    ++connectionGeneration;
    peerConnection = 9;
    write(peerConnection, fixtureCccd.handle, enable);
    write(peerConnection, fixtureCommand.handle, "fresh\n");
    assert(commandCount == 3 && queuedCommand.generation == 9 &&
           std::strcmp(queuedCommand.bytes, "fresh") == 0);
    std::puts("PASS command and receipt streams stay bound to the current subscribed connection");
}
