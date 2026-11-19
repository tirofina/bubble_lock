#pragma once
#include <stdint.h>

namespace r26ota {
void begin(bool (*displayReady)());
void rejectPending();
uint8_t wifiLevel();
}
