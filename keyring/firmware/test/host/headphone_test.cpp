#include <cassert>
#include <cstdio>
#include <cstring>
#include <vector>
#include <utility>
#include "headphone_standby.h"

static uint8_t regs[12];
static int64_t ticks;
static bool allowed, ready, readMismatch;
static int failRegister, cancelAt;
static std::vector<std::pair<uint8_t, uint8_t>> writes;
int64_t esp_timer_get_time() { return ticks; }
void delay(unsigned long ms) { ticks += ms * 1000; }
void delayMicroseconds(unsigned int us) { ticks += us; }
static bool permit(void *) { return allowed; }
static bool read(uint8_t address, uint8_t reg, uint8_t *value, size_t count) {
  assert(address == 0x10 && count == 1 && reg < 12);
  *value = reg == 0 ? (ready ? 0x30 : 0x10) : reg == 1 ? (ready ? 0 : 0x0d) : regs[reg];
  if (readMismatch && reg == 9) *value ^= 1;
  return true;
}
static bool write(uint8_t address, uint8_t reg, uint8_t value) {
  assert(address == 0x10 && reg < 12);
  writes.emplace_back(reg, value);
  if (static_cast<int>(writes.size()) == cancelAt) allowed = false;
  if (reg == failRegister) return false;
  regs[reg] = value;
  return true;
}
static void reset() {
  memset(regs, 0, sizeof(regs)); ticks = 0; writes.clear();
  allowed = ready = true; readMismatch = false; failRegister = cancelAt = -1;
}
static void quiet() { assert(regs[2] == 0xbf && regs[3] == 0 && regs[5] == 0); }
static bool unmuted() { for (const auto &entry : writes) if (entry.first == 2 && entry.second == 0x20) return true; return false; }
int main() {
  reset(); HeadphoneStandby driver; driver.begin(read, write); quiet(); assert(driver.speakerAllowed());
  writes.clear(); assert(driver.beginPlayback(permit, nullptr));
  assert(regs[5] == 0xfd && regs[6] == 0 && regs[7] == 0 && regs[8] == 0x80 && regs[9] == 16 && regs[10] == 8);
  assert(unmuted() && driver.checkPlayback() && !driver.speakerAllowed() && driver.audioAllowed());
  const auto count = writes.size(); assert(!driver.poll(10000)); assert(writes.size() == count);
  assert(!driver.prepareSleep()); assert(!driver.beginPlayback(permit, nullptr));
  assert(driver.finishPlayback()); quiet(); assert(driver.speakerAllowed());

  reset(); HeadphoneStandby cancel; cancel.begin(read, write); writes.clear(); cancelAt = 6;
  assert(!cancel.beginPlayback(permit, nullptr)); quiet(); assert(!unmuted());
  allowed = true; cancelAt = -1; assert(cancel.beginPlayback(permit, nullptr)); assert(cancel.finishPlayback());

  reset(); HeadphoneStandby mismatch; mismatch.begin(read, write); writes.clear(); readMismatch = true;
  assert(!mismatch.beginPlayback(permit, nullptr)); quiet(); assert(!unmuted());

  reset(); HeadphoneStandby timeout; timeout.begin(read, write); writes.clear(); ready = false;
  assert(!timeout.beginPlayback(permit, nullptr)); quiet(); assert(ticks >= 50000 && ticks < 52000); assert(!unmuted());

  reset(); HeadphoneStandby nack; nack.begin(read, write); writes.clear(); failRegister = 6;
  assert(!nack.beginPlayback(permit, nullptr)); quiet(); assert(!unmuted());

  reset(); HeadphoneStandby fault; fault.begin(read, write); assert(fault.beginPlayback(permit, nullptr));
  regs[5] = 0; assert(!fault.checkPlayback()); assert(fault.finishPlayback()); quiet();
  allowed = false; writes.clear(); assert(!fault.beginPlayback(permit, nullptr)); assert(writes.empty());
  std::puts("PASS: boot, register sequence, exclusive control, cancel, retry, readback, readiness timeout, NACK, drift and permission");
}
