#pragma once
#include <stdint.h>

// Shared TPS2553 rail: motor, speaker and LCD backlight, not LCD/SD logic power.
namespace auxRail {
bool begin();
bool alert(bool enabled); // Alert preempts backlight. Caller separately controls motor/mute.
bool displayFor(uint32_t durationMs);
bool displayVisible();
bool busy();
void service(); // Also called by an independent ESP timer; GPIO-only, no SPI/I2S.
}
