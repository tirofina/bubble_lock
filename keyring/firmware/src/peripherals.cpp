#include <Arduino.h>
#include <esp_timer.h>
#include <cstring>
#include "peripherals.h"
#include "firmware_options.h"
#include "board_r18.h"
#include "aux_rail.h"
#if KEYRING_DISPLAY_PROFILE || KEYRING_ENABLE_SD_LOG
#include <SPI.h>
#endif
#if KEYRING_DISPLAY_PROFILE
#include <Arduino_GFX_Library.h>
#include "jd9853_display.h"
#endif
#if KEYRING_ENABLE_SD_LOG
#include <SD.h>
#endif

namespace {
#if KEYRING_DISPLAY_PROFILE || KEYRING_ENABLE_SD_LOG
SPIClass sharedSpi(FSPI);
#endif
#if KEYRING_DISPLAY_PROFILE
Arduino_HWSPI displayBus(board::LcdDc, board::LcdCs, board::LcdSck,
    board::LcdMosi, board::SdMiso, &sharedSpi, true);
#if KEYRING_DISPLAY_PROFILE == 1
Arduino_ST7789 display(&displayBus, board::LcdReset, KEYRING_LCD_ROTATION, true,
    240, 240, KEYRING_LCD_X_OFFSET, KEYRING_LCD_Y_OFFSET,
    KEYRING_LCD_X_OFFSET, KEYRING_LCD_Y_OFFSET);
#else
KeyringJD9853 display(&displayBus);
#endif
constexpr uint16_t Black = 0x0000, White = 0xffff, Red = 0xf800, Cyan = 0x07ff;
#endif
#if KEYRING_ENABLE_SD_LOG
constexpr char LogPath[] = "/keyring-receipts.jsonl";
#endif
uint64_t nowMs() { return static_cast<uint64_t>(esp_timer_get_time()) / 1000; }
}

void Peripherals::begin() {
  if (!KEYRING_DISPLAY_PROFILE && !KEYRING_ENABLE_SD_LOG) return;
  if (KEYRING_ENABLE_SD_LOG) logs = xQueueCreate(8, sizeof(LogLine));
  portENTER_CRITICAL(&mux);
  displayState = KEYRING_DISPLAY_PROFILE ? "starting" : "disabled";
  sdState = KEYRING_ENABLE_SD_LOG ? (logs ? "starting" : "queue_error") : "disabled";
  ioActive = true; // Prevent sleep while worker initializes either device.
  portEXIT_CRITICAL(&mux);
  if (xTaskCreate(entry, "lcd-sd", 8192, this, 1, &worker) != pdPASS) {
    portENTER_CRITICAL(&mux);
    if (KEYRING_DISPLAY_PROFILE) displayState = "worker_error";
    if (KEYRING_ENABLE_SD_LOG) sdState = "worker_error";
    ioActive = false;
    portEXIT_CRITICAL(&mux);
    if (logs) { vQueueDelete(logs); logs = nullptr; }
  }
}
void Peripherals::update(const KeyringScreen &screen) {
  portENTER_CRITICAL(&mux); snapshot = screen; portEXIT_CRITICAL(&mux);
}
void Peripherals::show() {
  portENTER_CRITICAL(&mux); const bool ready = displayReady; portEXIT_CRITICAL(&mux);
  if (ready) { auxRail::displayFor(KEYRING_LCD_SHOW_MS); xTaskNotifyGive(worker); }
}
void Peripherals::logReceipt(const char *jsonLine, size_t length) {
  if (!KEYRING_ENABLE_SD_LOG) return;
  portENTER_CRITICAL(&mux); const bool ready = sdReady; portEXIT_CRITICAL(&mux);
  if (!ready || !logs || !length || length > sizeof(LogLine::bytes) || jsonLine[length - 1] != '\n') {
    drop(); return;
  }
  LogLine line = {};
  line.length = length;
  memcpy(line.bytes, jsonLine, length);
  if (xQueueSend(logs, &line, 0) != pdTRUE) drop();
  else xTaskNotifyGive(worker);
}
bool Peripherals::busy() {
  portENTER_CRITICAL(&mux); const bool active = ioActive; portEXIT_CRITICAL(&mux);
  return active || (logs && uxQueueMessagesWaiting(logs) != 0);
}
bool Peripherals::prepareSleep() {
  if (logs && uxQueueMessagesWaiting(logs) != 0) return false;
  portENTER_CRITICAL(&mux);
  const bool allowed = !ioActive;
  if (allowed) sleeping = true;
  portEXIT_CRITICAL(&mux);
  return allowed;
}
void Peripherals::resume() {
  portENTER_CRITICAL(&mux); sleeping = false; portEXIT_CRITICAL(&mux);
}
const char *Peripherals::displayStatus() {
  portENTER_CRITICAL(&mux); const char *result = displayState; portEXIT_CRITICAL(&mux); return result;
}
const char *Peripherals::sdStatus() {
  portENTER_CRITICAL(&mux); const char *result = sdState; portEXIT_CRITICAL(&mux); return result;
}
uint32_t Peripherals::droppedLogs() {
  portENTER_CRITICAL(&mux); const uint32_t result = drops; portEXIT_CRITICAL(&mux); return result;
}
bool Peripherals::setIo(bool active) {
  portENTER_CRITICAL(&mux);
  const bool allowed = !active || !sleeping;
  if (allowed) ioActive = active;
  portEXIT_CRITICAL(&mux);
  return allowed;
}
void Peripherals::drop() {
  portENTER_CRITICAL(&mux); if (drops != UINT32_MAX) ++drops; portEXIT_CRITICAL(&mux);
}
void Peripherals::setSd(const char *status) {
  portENTER_CRITICAL(&mux); sdState = status; sdReady = false; portEXIT_CRITICAL(&mux);
}
void Peripherals::entry(void *context) { static_cast<Peripherals *>(context)->run(); }
void Peripherals::run() {
#if KEYRING_DISPLAY_PROFILE || KEYRING_ENABLE_SD_LOG
  // Both CS pins are inactive before configuring the common SPI signals.
  digitalWrite(board::LcdCs, HIGH); digitalWrite(board::SdCs, HIGH);
  sharedSpi.begin(board::LcdSck, board::SdMiso, board::LcdMosi);
#endif
#if KEYRING_DISPLAY_PROFILE
  const bool screenStarted = display.begin(KEYRING_LCD_SPI_HZ);
  portENTER_CRITICAL(&mux);
  displayReady = screenStarted;
  // A write-only panel has no identification/readback path on this connector.
  displayState = screenStarted ? (KEYRING_DISPLAY_PROFILE == 1 ? "st7789_unverified" : "jd9853_unverified") : "bus_error";
  portEXIT_CRITICAL(&mux);
  if (screenStarted) {
    display.setTextWrap(false); display.setTextSize(2);
    auxRail::displayFor(KEYRING_LCD_SHOW_MS);
  }
#endif
#if KEYRING_ENABLE_SD_LOG
  // Never auto-format or erase a card. Detection contacts are not wired.
  const bool mounted = logs && SD.begin(board::SdCs, sharedSpi, 4000000, "/sd", 3, false);
  portENTER_CRITICAL(&mux);
  sdReady = mounted;
  sdState = mounted ? "mounted" : logs ? "mount_error" : "queue_error";
  portEXIT_CRITICAL(&mux);
#endif
  setIo(false);
  uint64_t nextDraw = 0;
  for (;;) {
    ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(100));
    const uint64_t now = nowMs();
    if (displayReady && auxRail::displayVisible() && now >= nextDraw) {
      KeyringScreen screen;
      portENTER_CRITICAL(&mux); screen = snapshot; portEXIT_CRITICAL(&mux);
      if (setIo(true)) { draw(screen); setIo(false); }
      nextDraw = nowMs() + 1000;
    }
    LogLine line = {};
    // Mark busy before dequeueing so sleep cannot slip into the queue/I/O gap.
    if (setIo(true)) {
      if (logs && xQueueReceive(logs, &line, 0) == pdTRUE) append(line);
      setIo(false);
    }
  }
}
void Peripherals::draw(const KeyringScreen &screen) {
#if KEYRING_DISPLAY_PROFILE
  display.fillScreen(Black);
  display.setTextColor(Cyan); display.setCursor(8, 8); display.print("PRIVACY BUBBLE");
  display.setTextColor(White); display.setCursor(8, 38);
  display.print(screen.authenticated ? "BLE: BONDED" : screen.linked ? "BLE: PAIRING" : "BLE: OFFLINE");
  display.setCursor(8, 64); display.print("Battery: ");
  if (screen.batteryValid) { display.print(screen.battery, 0); display.print('%'); }
  else display.print("--");
  display.setCursor(8, 90); display.print(screen.panic ? "Button: PANIC" : screen.confirm ? "Button: CONFIRM" : "Button: RELEASED");
  display.setCursor(8, 116); display.print(screen.motor ? "Motor GPIO: ON" : "Motor GPIO: OFF");
  display.setCursor(8, 142); display.print("Motion: "); display.print(screen.motionEvents);
  display.setCursor(8, 168); display.setTextColor(screen.fault || !screen.journal ? Red : White);
  display.print(screen.fault ? "POWER FAULT" : !screen.journal ? "JOURNAL ERROR" : "Journal: READY");
  display.setTextColor(White); display.setCursor(8, 194); display.print("SD: "); display.print(sdStatus());
#else
  (void)screen;
#endif
}
void Peripherals::append(const LogLine &line) {
#if KEYRING_ENABLE_SD_LOG
  portENTER_CRITICAL(&mux); const bool ready = sdReady; portEXIT_CRITICAL(&mux);
  if (!ready) { drop(); return; }
  File file = SD.open(LogPath, FILE_APPEND);
  if (!file) { setSd("open_error"); drop(); return; }
  const size_t size = file.size();
  if (size > KEYRING_SD_MAX_BYTES || line.length > KEYRING_SD_MAX_BYTES - size) {
    file.close(); setSd("full"); drop(); return;
  }
  const bool written = file.write(reinterpret_cast<const uint8_t *>(line.bytes), line.length) == line.length;
  file.flush(); file.close();
  // FAT flush/close offers no power-fail transaction guarantee; NVS remains canonical.
  if (!written) { setSd("write_error"); drop(); }
#else
  (void)line;
#endif
}
