#include <Arduino.h>
#include <cmath>
#include <driver/gpio.h>
#include <driver/i2s.h>
#include <esp_intr_alloc.h>
#include <esp_timer.h>
#include "audio_alert.h"
#include "board_r18.h"
#include "firmware_options.h"

namespace {
constexpr i2s_port_t Port = I2S_NUM_0;
constexpr uint32_t SampleRate = 16000;
constexpr size_t Frames = 64;
constexpr float Tau = 6.28318530718f;
uint64_t nowMs() { return static_cast<uint64_t>(esp_timer_get_time()) / 1000; }
void mute() { gpio_set_level(static_cast<gpio_num_t>(board::AmpMute), 1); }
}

bool AudioAlert::begin(Permit allow) {
  mute();
  outputAllowed = allow;
  if (!KEYRING_ENABLE_AUDIO || !allow) return false;
  i2s_config_t config = {};
  config.mode = static_cast<i2s_mode_t>(I2S_MODE_MASTER | I2S_MODE_TX);
  config.sample_rate = SampleRate;
  config.bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT;
  config.bits_per_chan = I2S_BITS_PER_CHAN_16BIT;
  config.channel_format = I2S_CHANNEL_FMT_RIGHT_LEFT;
  config.communication_format = I2S_COMM_FORMAT_STAND_I2S;
  config.intr_alloc_flags = ESP_INTR_FLAG_LEVEL1;
  config.dma_buf_count = 4;
  config.dma_buf_len = 128;
  config.use_apll = false;
  config.tx_desc_auto_clear = true;
  if (i2s_driver_install(Port, &config, 0, nullptr) != ESP_OK) { fail(); return false; }
  i2s_pin_config_t pins = {};
  pins.mck_io_num = I2S_PIN_NO_CHANGE; // MAX98357A needs no MCLK; GPIO13 belongs to headphone DAC.
  pins.bck_io_num = board::I2sBclk;
  pins.ws_io_num = board::I2sLrclk;
  pins.data_out_num = board::I2sDout;
  pins.data_in_num = I2S_PIN_NO_CHANGE;
  if (i2s_set_pin(Port, &pins) != ESP_OK || i2s_zero_dma_buffer(Port) != ESP_OK || i2s_stop(Port) != ESP_OK) {
    mute(); i2s_driver_uninstall(Port); fail(); return false;
  }
  portENTER_CRITICAL(&mux); configured = true; portEXIT_CRITICAL(&mux);
  if (xTaskCreate(entry, "speaker-cue", 4096, this, 2, &worker) != pdPASS) {
    i2s_driver_uninstall(Port); fail(); return false;
  }
  return true;
}

bool AudioAlert::startUntil(uint64_t deadlineMs) {
  const uint64_t now = nowMs();
  if (!KEYRING_ENABLE_AUDIO || !worker || deadlineMs <= now ||
      deadlineMs - now > board::MotorMaxOnMs) return false;
  portENTER_CRITICAL(&mux);
  const bool allowed = configured && !fault && outputAllowed && outputAllowed() &&
      gpio_get_level(static_cast<gpio_num_t>(board::AuxEnable)) &&
      gpio_get_level(static_cast<gpio_num_t>(board::Motor));
  if (allowed) { ++generation; deadline = deadlineMs; armed = true; }
  portEXIT_CRITICAL(&mux);
  if (allowed) xTaskNotifyGive(worker);
  return allowed;
}

void AudioAlert::stop() {
  portENTER_CRITICAL(&mux);
  armed = false; deadline = 0; ++generation;
  mute();
  portEXIT_CRITICAL(&mux);
  if (worker) xTaskNotifyGive(worker);
}

bool AudioAlert::busy() {
  portENTER_CRITICAL(&mux); const bool result = armed || running; portEXIT_CRITICAL(&mux);
  return result;
}

const char *AudioAlert::status() {
  portENTER_CRITICAL(&mux);
  const char *result = !KEYRING_ENABLE_AUDIO ? "disabled" : fault ? "error" :
      !configured ? "unavailable" : (armed || running) ? "playing" : "ready";
  portEXIT_CRITICAL(&mux);
  return result;
}

void AudioAlert::fail() {
  portENTER_CRITICAL(&mux);
  configured = false; fault = true; armed = false; ++generation; mute();
  portEXIT_CRITICAL(&mux);
}

bool AudioAlert::current(uint32_t token, uint64_t &deadlineMs, bool unmute) {
  const uint64_t now = nowMs();
  portENTER_CRITICAL(&mux);
  const bool valid = configured && !fault && armed && generation == token && now < deadline &&
      outputAllowed && outputAllowed() &&
      gpio_get_level(static_cast<gpio_num_t>(board::AuxEnable)) &&
      gpio_get_level(static_cast<gpio_num_t>(board::Motor)) &&
      gpio_get_level(static_cast<gpio_num_t>(board::MainFaultN));
  deadlineMs = deadline;
  if (valid && unmute) gpio_set_level(static_cast<gpio_num_t>(board::AmpMute), 0);
  portEXIT_CRITICAL(&mux);
  return valid;
}

void AudioAlert::entry(void *context) { static_cast<AudioAlert *>(context)->run(); }

void AudioAlert::run() {
  int16_t pcm[Frames * 2] = {};
  for (;;) {
    ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
    portENTER_CRITICAL(&mux);
    const uint32_t token = generation;
    const bool start = configured && !fault && armed;
    if (start) running = true;
    portEXIT_CRITICAL(&mux);
    if (!start) continue;
    uint64_t stopAt = 0;
    if (!current(token, stopAt, false) || i2s_zero_dma_buffer(Port) != ESP_OK || i2s_start(Port) != ESP_OK) {
      // A cancelled/expired request is ordinary; an actual driver error is sticky.
      if (current(token, stopAt, false)) fail();
    } else {
      float phase = 0;
      uint32_t frameNumber = 0;
      while (current(token, stopAt, false)) {
        const uint64_t blockStart = nowMs();
        for (size_t n = 0; n < Frames; ++n) {
          const uint64_t sampleAt = blockStart + n * 1000 / SampleRate;
          const float attack = frameNumber < 64 ? frameNumber / 64.0f : 1.0f;
          const float release = sampleAt >= stopAt ? 0.0f : stopAt - sampleAt < 4 ? (stopAt - sampleAt) / 4.0f : 1.0f;
          const int16_t value = static_cast<int16_t>(sinf(phase) * KEYRING_AUDIO_AMPLITUDE * attack * release);
          pcm[n * 2] = pcm[n * 2 + 1] = value; // Same cue in both slots; no channel ambiguity.
          phase += Tau * KEYRING_AUDIO_FREQUENCY / SampleRate;
          if (phase >= Tau) phase -= Tau;
          ++frameNumber;
        }
        size_t written = 0;
        if (i2s_write(Port, pcm, sizeof(pcm), &written, pdMS_TO_TICKS(12)) != ESP_OK || written != sizeof(pcm)) {
          fail(); break;
        }
        // A concurrent stop owns the same lock; stale DMA writes cannot unmute it.
        if (!current(token, stopAt, true)) break;
      }
    }
    portENTER_CRITICAL(&mux);
    mute();
    if (generation == token) armed = false;
    portEXIT_CRITICAL(&mux);
    // Mute precedes stopping both LRCLK/BCLK; no single-clock shutdown sequence.
    if (i2s_stop(Port) != ESP_OK || i2s_zero_dma_buffer(Port) != ESP_OK) fail();
    portENTER_CRITICAL(&mux); running = false; portEXIT_CRITICAL(&mux);
  }
}
