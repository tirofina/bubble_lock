#pragma once
#include <stdint.h>

namespace powerState {
void begin();
const char *wakeCause();
uint64_t wakePins();
bool sleepEnabled();
const char *status();
void activity(uint64_t now);
bool idle(uint64_t now);
// Called only after the main loop has drained commands/receipts and gated the link.
// Success enters deep sleep and does not return. Failed arming leaves BLE intact.
bool enter();
}
