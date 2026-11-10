#pragma once

#include <ArduinoJson.h>
#include <stdint.h>

struct ButtonPresses {
  uint32_t confirm = 0, panic = 0;

  void record(bool confirmRise, bool panicRise, bool panicHeld) {
    if (panicRise) {
      if (panic < UINT32_MAX) ++panic;
    } else if (confirmRise && !panicHeld && confirm < UINT32_MAX) {
      ++confirm;
    }
  }

  void append(JsonObject sensorValues) const {
    JsonArray values = sensorValues.createNestedArray("buttonPresses");
    values.add(confirm);
    values.add(panic);
  }
};
