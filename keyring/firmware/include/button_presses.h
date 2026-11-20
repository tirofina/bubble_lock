#pragma once

#include <ArduinoJson.h>
#include <stdint.h>

enum class ButtonPress { None, Confirm, Panic };

struct ButtonPresses {
  uint32_t confirm = 0, panic = 0;
  ButtonPress last = ButtonPress::None;

  bool record(bool confirmRise, bool panicRise, bool panicHeld) {
    if (panicRise) {
      if (panic < UINT32_MAX) ++panic;
      last = ButtonPress::Panic;
      return true;
    }
    if (confirmRise && !panicHeld) {
      if (confirm < UINT32_MAX) ++confirm;
      last = ButtonPress::Confirm;
      return true;
    }
    return false;
  }

  void append(JsonObject sensorValues) const {
    JsonArray values = sensorValues.createNestedArray("buttonPresses");
    values.add(confirm);
    values.add(panic);
  }
};
