#include <algorithm>
#include <cassert>
#include <cstdio>
#include <cstring>
#include "board_r18.h"
#include "firmware_options.h"
#include "motion_wake.h"

using std::min;
constexpr int HIGH = 1, LOW = 0;
uint64_t nowMs = 0, lastSensorRead = 0;
bool observationDirty = false;
bool accelPresent = false, axesReadable = true, wakeReadable = true, interruptHigh = false;
unsigned idReads = 0;
uint8_t registers[256] = {};
MotionWake motion;

uint64_t uptime() { return nowMs; }
int digitalRead(int pin) {
    assert(pin == board::AccelInterrupt);
    return interruptHigh ? HIGH : LOW;
}
bool readRegisters(uint8_t address, uint8_t reg, uint8_t *data, size_t count) {
    if (address == board::FuelAddress) {
        const uint8_t fuel[] = {0xc0, 0x00, 50, 0};
        assert(reg == 0x02 && count == sizeof(fuel));
        std::memcpy(data, fuel, sizeof(fuel));
        return true;
    }
    assert(address == board::AccelAddress);
    if (reg == 0x0f) ++idReads;
    if (!accelPresent || (reg == 0x28 && !axesReadable) || (reg == 0x38 && !wakeReadable)) return false;
    std::memcpy(data, registers + reg, count);
    return true;
}
bool writeRegister(uint8_t address, uint8_t reg, uint8_t value) {
    assert(address == board::AccelAddress && accelPresent);
    registers[reg] = value;
    return true;
}

#include "sensor_recovery_subject.inc"

int main() {
    registers[0x0f] = 0x44;
    recoverAccelerometer(nowMs);
    sampleSensors();
    assert(idReads == 1 && !sensors.accel && !motion.ready());
    assert(sensors.fuel && sensors.battery == 50.0f);

    accelPresent = true;
    nowMs = 4999;
    recoverAccelerometer(nowMs);
    assert(idReads == 1 && !motion.ready());
    nowMs = 5000;
    recoverAccelerometer(nowMs);
    assert(idReads == 2 && motion.ready() && !sensors.accel);
    sampleSensors();
    assert(sensors.accel);

    interruptHigh = true;
    registers[0x38] = 0x08;
    assert(motion.poll(nowMs) && motion.events() == 1);
    interruptHigh = false;
    registers[0x38] = 0;

    nowMs = 9000;
    axesReadable = false;
    sampleSensors();
    assert(!sensors.accel && !motion.ready() && sensors.fuel);
    axesReadable = true;
    nowMs = 13999;
    recoverAccelerometer(nowMs);
    assert(idReads == 2);
    nowMs = 14000;
    recoverAccelerometer(nowMs);
    sampleSensors();
    assert(idReads == 3 && sensors.accel && motion.ready() && motion.events() == 1);

    nowMs = 19000;
    interruptHigh = true;
    wakeReadable = false;
    assert(!motion.poll(nowMs) && !motion.ready() && sensors.accel);
    recoverAccelerometer(nowMs);
    assert(idReads == 3 && !motion.ready() && sensors.accel);
    nowMs = 24000;
    interruptHigh = false;
    wakeReadable = true;
    recoverAccelerometer(nowMs);
    assert(idReads == 3 && motion.ready() && sensors.accel && motion.events() == 1);
    std::puts("PASS r18 accelerometer and motion route recover independently of fuel reads");
}
