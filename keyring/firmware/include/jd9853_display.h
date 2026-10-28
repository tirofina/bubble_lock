#pragma once
#include "firmware_options.h"
#if KEYRING_DISPLAY_PROFILE == 2
#include <Arduino_TFT.h>

// JD9853-specific RGB565/MADCTL handling; panel-specific power/gamma settings
// must come from the purchased module, never from an unrelated ST7789 panel.
class KeyringJD9853 : public Arduino_TFT {
public:
  explicit KeyringJD9853(Arduino_DataBus *bus);
  void setRotation(uint8_t rotation) override;
  void writeAddrWindow(int16_t x, int16_t y, uint16_t w, uint16_t h) override;
protected:
  void tftInit() override;
};
#endif
