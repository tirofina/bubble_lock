#pragma once

#include <stddef.h>
#include <stdint.h>
#include <string.h>

// Caller serializes publication and reads with the active BLE session lock.
class GattReadValue {
 public:
  void replace(const char *data, size_t size) {
    length = size <= Capacity ? static_cast<uint16_t>(size) : 0;
    if (length) memcpy(value, data, length);
  }

  void reset() {
    length = 0;
    snapshotLength = 0;
    started = false;
  }

  bool chunk(uint32_t generation, uint16_t offset, uint16_t maximum,
             uint8_t *output, uint16_t &written) {
    written = 0;
    if (offset == 0) {
      snapshotLength = length;
      if (snapshotLength) memcpy(snapshot, value, snapshotLength);
      snapshotGeneration = generation;
      started = true;
    } else if (!started || generation != snapshotGeneration || offset > snapshotLength) {
      return false;
    }
    const uint16_t remaining = snapshotLength - offset;
    written = remaining < maximum ? remaining : maximum;
    if (written) memcpy(output, snapshot + offset, written);
    return true;
  }

 private:
  static constexpr size_t Capacity = 512;
  uint8_t value[Capacity] = {}, snapshot[Capacity] = {};
  uint16_t length = 0, snapshotLength = 0;
  uint32_t snapshotGeneration = 0;
  bool started = false;
};
