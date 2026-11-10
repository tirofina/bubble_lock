#include "jd9853_display.h"
#if KEYRING_DISPLAY_PROFILE == 2
#include <Arduino.h>
#include "board_r18.h"
// Optional local module-specific function: void keyringJd9853PanelInit(Arduino_DataBus &bus).
// It runs after reset and before DCS sleep-out; function owns its SPI transactions.
#if !defined(KEYRING_IGNORE_PROVISIONING) && __has_include("jd9853_panel.h")
#include "jd9853_panel.h"
#endif

KeyringJD9853::KeyringJD9853(Arduino_DataBus *bus)
  : Arduino_TFT(bus, board::LcdReset, KEYRING_LCD_ROTATION, true,
      KEYRING_JD9853_WIDTH, KEYRING_JD9853_HEIGHT,
      KEYRING_LCD_X_OFFSET, KEYRING_LCD_Y_OFFSET,
      KEYRING_LCD_X_OFFSET, KEYRING_LCD_Y_OFFSET) {}

void KeyringJD9853::tftInit() {
  pinMode(_rst, OUTPUT);
  digitalWrite(_rst, HIGH); delay(20);
  digitalWrite(_rst, LOW); delay(20);
  digitalWrite(_rst, HIGH); delay(120);
  _bus->beginWrite(); _bus->writeCommand(0x01); _bus->endWrite(); delay(120);
#if !defined(KEYRING_IGNORE_PROVISIONING) && __has_include("jd9853_panel.h")
  keyringJd9853PanelInit(*_bus);
#endif
  _bus->beginWrite(); _bus->writeCommand(0x11); _bus->endWrite(); delay(120);
  _bus->beginWrite();
  _bus->writeC8D8(0x3a, 0x05); // JD9853 16-bit RGB565; ST7789's 0x55 is not reused.
  _bus->writeCommand(KEYRING_JD9853_INVERT ? 0x21 : 0x20);
  _bus->writeCommand(0x29);
  _bus->endWrite(); delay(20);
}
void KeyringJD9853::setRotation(uint8_t rotation) {
  Arduino_TFT::setRotation(rotation);
  static const uint8_t madctl[] = {0x00, 0xa0, 0xc0, 0x60};
  _bus->beginWrite();
  _bus->writeC8D8(0x36, madctl[rotation & 3] | (KEYRING_JD9853_BGR ? 0x08 : 0x00));
  _bus->endWrite();
}
void KeyringJD9853::writeAddrWindow(int16_t x, int16_t y, uint16_t w, uint16_t h) {
  x += _xStart; y += _yStart;
  _bus->writeC8D16D16(0x2a, x, x + w - 1);
  _bus->writeC8D16D16(0x2b, y, y + h - 1);
  _bus->writeCommand(0x2c);
}
#endif
