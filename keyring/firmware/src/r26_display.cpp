#include "firmware_options.h"

#if defined(KEYRING_R26_FRONT) && KEYRING_DISPLAY_PROFILE
#include <Arduino_GFX_Library.h>
#include "peripherals.h"
#include "r26_display.h"
#include "r26_logo.h"
#include "r26_text_masks.h"

namespace {
constexpr uint16_t rgb565(uint8_t red, uint8_t green, uint8_t blue) {
  return static_cast<uint16_t>(((red & 0xf8) << 8) | ((green & 0xfc) << 3) | (blue >> 3));
}

constexpr auto Background = rgb565(12, 20, 27);
constexpr auto Surface = rgb565(23, 36, 46);
constexpr auto Border = rgb565(48, 70, 82);
constexpr auto Badge = rgb565(34, 52, 63);
constexpr auto Text = rgb565(241, 249, 249);
constexpr auto Muted = rgb565(172, 194, 204);
constexpr auto Mint = rgb565(100, 233, 202);
constexpr auto Lime = rgb565(188, 240, 133);
constexpr auto Coral = rgb565(255, 136, 124);

constexpr int16_t Center = 120;
constexpr int16_t BadgeY = 90;

uint16_t blend565(uint16_t foreground, uint16_t background, uint8_t alpha) {
  const unsigned inverse = 15 - alpha;
  const unsigned red = ((foreground >> 11) * alpha + (background >> 11) * inverse + 7) / 15;
  const unsigned green = (((foreground >> 5) & 63) * alpha + ((background >> 5) & 63) * inverse + 7) / 15;
  const unsigned blue = ((foreground & 31) * alpha + (background & 31) * inverse + 7) / 15;
  return static_cast<uint16_t>((red << 11) | (green << 5) | blue);
}

void label(Arduino_GFX &panel, int16_t x, int16_t middleY, const r26text::Mask &mask,
    uint16_t foreground, uint16_t background) {
  uint16_t palette[16], row[240];
  for (uint8_t alpha = 0; alpha < 16; ++alpha) palette[alpha] = blend565(foreground, background, alpha);
  const int16_t top = middleY - mask.height / 2;
  unsigned pixel = 0;
  for (int16_t y = 0; y < mask.height; ++y) {
    for (int16_t i = 0; i < mask.width; ++i, ++pixel) {
      const uint8_t packed = mask.alpha[pixel / 2];
      row[i] = palette[pixel % 2 ? packed & 15 : packed >> 4];
    }
    panel.draw16bitRGBBitmap(x, top + y, row, mask.width, 1);
  }
}

void drawFrame(Arduino_GFX &panel) {
  panel.fillScreen(Background);
  static_assert(r26logo::Background == Background, "The logo must match the display background");
  panel.draw16bitRGBBitmap(Center - r26logo::Width / 2, 31 - r26logo::Height / 2,
      r26logo::Pixels, r26logo::Width, r26logo::Height);
  panel.drawFastHLine(14, 58, 212, Border);

  panel.fillRoundRect(14, 68, 212, 108, 16, Surface);
  panel.drawRoundRect(14, 68, 212, 108, 16, Border);

  // Fixed five-bar demo artwork for the front assembly without a fuel gauge.
  panel.fillRoundRect(14, 187, 212, 39, 11, Surface);
  panel.drawRoundRect(14, 187, 212, 39, 11, Border);
  label(panel, 28, 206, r26text::Battery, Text, Surface);
  panel.drawRoundRect(138, 197, 70, 19, 4, Muted);
  panel.fillRoundRect(209, 203, 3, 7, 1, Muted);
  for (int16_t bar = 0; bar < 5; ++bar) {
    panel.fillRoundRect(144 + bar * 12, 201, 9, 11, 2, Mint);
  }
}
}

void drawR26Display(Arduino_GFX &panel, const KeyringScreen &screen, bool fullDraw) {
  if (fullDraw) drawFrame(panel);
  else panel.fillRect(23, 73, 194, 92, Surface);

  const auto accent = screen.panic ? Coral : screen.confirm ? Lime : Mint;
  panel.fillCircle(Center, BadgeY, 15, Badge);
  panel.drawCircle(Center, BadgeY, 15, accent);
  if (screen.panic) {
    panel.fillRoundRect(Center - 2, BadgeY - 10, 5, 13, 2, accent);
    panel.fillCircle(Center, BadgeY + 8, 2, accent);
  } else if (screen.confirm) {
    for (int16_t offset = -1; offset <= 1; ++offset) {
      panel.drawLine(Center - 9, BadgeY + offset, Center - 3, BadgeY + 6 + offset, accent);
      panel.drawLine(Center - 3, BadgeY + 6 + offset, Center + 9, BadgeY - 7 + offset, accent);
    }
  } else {
    panel.drawCircle(Center, BadgeY, 8, accent);
    panel.fillCircle(Center, BadgeY, 3, accent);
  }

  const auto &title = screen.panic ? r26text::Panic : screen.confirm ? r26text::Confirm : r26text::Ready;
  const auto &hint = screen.panic ? r26text::PanicHint : screen.confirm ? r26text::ConfirmHint : r26text::ReadyHint;
  label(panel, Center - title.width / 2, 123, title, accent, Surface);
  label(panel, Center - hint.width / 2, 151, hint, Text, Surface);
}
#endif
