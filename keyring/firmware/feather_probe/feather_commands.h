#pragma once

#include <ArduinoJson.h>
#include <esp_timer.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <nvs.h>
#include <stddef.h>

// Bench-only command storage. Separate NVS namespace from production firmware.
class FeatherCommands {
 public:
  static constexpr size_t ReceiptCapacity = 512;
  using ReadPin = bool (*)();
  using ApplyPin = bool (*)(uint32_t generation, bool state, uint64_t deadline,
                            uint64_t &appliedAt, bool &readback);
  using ClearPin = void (*)();

  FeatherCommands(const char *deviceId, const char *firmwareRevision, const char *bootId)
      : deviceId_(deviceId), firmwareRevision_(firmwareRevision), bootId_(bootId) {}

  bool begin() {
    queue_ = xQueueCreate(1, sizeof(Frame));
    if (!queue_) return false;
    healthy_ = nvs_open("feather-cmd-v1", NVS_READWRITE, &nvs_) == ESP_OK;
    if (!healthy_) return true;  // The peer can receive a correlated STORAGE_ERROR.
    for (unsigned i = 0; i < Slots; ++i) {
      char key[8];
      slotKey(i, key);
      auto &record = records_[i];
      size_t size = sizeof(record);
      const auto rc = nvs_get_blob(nvs_, key, &record, &size);
      if (rc == ESP_ERR_NVS_NOT_FOUND) continue;
      if (rc != ESP_OK || size != sizeof(record) || !validRecord(record)) {
        healthy_ = false;
        break;
      }
      maxEpoch_ = max(maxEpoch_, record.epoch);
      maxGrant_ = max(maxGrant_, record.grant);
    }
    return true;
  }

  static uint64_t nowMs() { return static_cast<uint64_t>(esp_timer_get_time()) / 1000; }

  void discardInput() {
    used_ = 0;
    discarding_ = false;
    xQueueReset(queue_);
  }

  // The BLE task only assembles one bounded frame. NVS and GPIO run in loop().
  void receive(const uint8_t *bytes, size_t size, uint32_t generation) {
    const auto now = nowMs();
    if (rx_.generation != generation || now - lastFragment_ > 5000) {
      used_ = 0;
      discarding_ = false;
      rx_.generation = generation;
    }
    lastFragment_ = now;
    if (!size || size > 20) {
      used_ = 0;
      discarding_ = true;
      return;
    }
    for (size_t i = 0; i < size; ++i) {
      const auto byte = bytes[i];
      if (byte == '\n') {
        if (used_ && !discarding_) {
          rx_.bytes[used_] = '\0';
          rx_.length = used_;
          rx_.completedAt = now;
          xQueueSend(queue_, &rx_, 0);
        }
        used_ = 0;
        discarding_ = false;
      } else if (!discarding_) {
        if (!byte || used_ == MaxCommand) {
          used_ = 0;
          discarding_ = true;
        } else {
          if (!used_) rx_.firstAt = now;
          rx_.bytes[used_++] = static_cast<char>(byte);
        }
      }
    }
  }

  size_t process(uint32_t generation, char (&out)[ReceiptCapacity], ReadPin readPin,
                 ApplyPin applyPin, ClearPin clearPin) {
    Frame frame{};
    if (xQueueReceive(queue_, &frame, 0) != pdTRUE || frame.generation != generation) return 0;
    StaticJsonDocument<1024> doc;
    if (deserializeJson(doc, static_cast<const char *>(frame.bytes), frame.length,
                        DeserializationOption::NestingLimit(4)) || !doc.is<JsonObject>()) return 0;
    const char *id = doc["commandId"], *hash = doc["payloadHash"];
    if (!identifier(id) || !validHash(hash)) return 0;
    auto reply = [&](const char *code, const Record *record = nullptr) {
      return receipt(out, id, hash, code, record, readPin());
    };
    const char *kind = doc["type"], *target = doc["deviceId"];
    const auto desiredState = doc["desiredState"].as<JsonObjectConst>();
    const int32_t grant = doc["grantRevision"] | int32_t{0};
    const int32_t epoch = doc["ownershipEpoch"] | int32_t{-1};
    const uint32_t remaining = doc["remainingMs"] | uint32_t{0};
    char compact[MaxCommand + 1];
    // The Gateway emits compact ASCII JSON. Round-trip comparison also rejects
    // duplicate keys, embedded escaped NUL and ignored trailing data.
    const bool exact = serializeJson(doc, compact, sizeof(compact)) == frame.length
                       && memcmp(compact, frame.bytes, frame.length) == 0;
    if (!exact || doc.size() != 9 || !doc["version"].is<int>() || doc["version"].as<int>() != 1 ||
        !kind || strcmp(kind, "command") || !target || strcmp(target, deviceId_) ||
        desiredState.size() != 1 || !desiredState["state"].is<bool>() ||
        grant < 1 || epoch < 0 || !remaining || remaining > 30000) return reply("INVALID");
    if (!healthy_) return reply("STORAGE_ERROR");
    const bool desired = desiredState["state"].as<bool>();
    unsigned freeSlot = Slots;
    for (unsigned i = 0; i < Slots; ++i) {
      const auto &prior = records_[i];
      if (!prior.magic) {
        if (freeSlot == Slots) freeSlot = i;
        continue;
      }
      if (strcmp(prior.id, id)) continue;
      if (strcmp(prior.hash, hash) || prior.epoch != static_cast<uint32_t>(epoch) ||
          prior.grant != static_cast<uint32_t>(grant) || (prior.desired != 0) != desired) return reply("CONFLICT");
      const auto code = prior.phase == Prepared ? "INDETERMINATE" :
          prior.desired == prior.readback ? "DUPLICATE" : "READBACK_MISMATCH";
      return reply(code, &prior);
    }
    if (static_cast<uint32_t>(epoch) < maxEpoch_) return reply("REJECTED_EPOCH");
    if (static_cast<uint32_t>(grant) < maxGrant_) return reply("REJECTED_GRANT");
    const uint64_t deadline = frame.firstAt + remaining;
    if (nowMs() >= deadline) return reply("EXPIRED");
    if (freeSlot == Slots) return reply("JOURNAL_FULL");

    Record record{};
    record.magic = Magic;
    record.phase = Prepared;
    strcpy(record.id, id);
    strcpy(record.hash, hash);
    strcpy(record.bootId, bootId_);
    record.epoch = epoch;
    record.grant = grant;
    record.desired = desired;
    record.acceptedAt = frame.completedAt;
    if (!save(freeSlot, record)) {
      clearPin();
      return reply("STORAGE_ERROR");
    }
    maxEpoch_ = max(maxEpoch_, record.epoch);
    maxGrant_ = max(maxGrant_, record.grant);

    bool readback = false;
    if (!applyPin(generation, desired, deadline, record.appliedAt, readback))
      return reply("INDETERMINATE", &records_[freeSlot]);
    record.phase = Completed;
    record.readback = readback;
    if (desired != readback) clearPin();
    if (!save(freeSlot, record)) {
      clearPin();
      return reply("INDETERMINATE", &records_[freeSlot]);
    }
    return reply(desired == readback ? "APPLIED" : "READBACK_MISMATCH", &records_[freeSlot]);
  }

 private:
  static constexpr unsigned Slots = 16;
  static constexpr size_t MaxCommand = 512;
  static constexpr uint32_t Magic = 0x46434d31;
  enum Phase : uint8_t { Prepared = 1, Completed = 2 };
  struct Frame {
    uint64_t firstAt, completedAt;
    uint32_t generation;
    size_t length;
    char bytes[MaxCommand + 1];
  };
  struct Record {
    uint64_t acceptedAt, appliedAt;
    uint32_t magic, epoch, grant;
    char id[65], hash[65], bootId[17];
    uint8_t phase, desired, readback;
    uint32_t crc;
  };

  static bool identifier(const char *value) {
    if (!value || !isalnum(static_cast<unsigned char>(*value)) || strlen(value) > 64) return false;
    for (const unsigned char *p = reinterpret_cast<const unsigned char *>(value); *p; ++p)
      if (*p > 127 || !(isalnum(*p) || *p == '.' || *p == '_' || *p == ':' || *p == '-')) return false;
    return true;
  }

  static bool validHash(const char *hash) {
    if (!hash || strlen(hash) != 64) return false;
    for (unsigned i = 0; i < 64; ++i)
      if (!((hash[i] >= '0' && hash[i] <= '9') || (hash[i] >= 'a' && hash[i] <= 'f'))) return false;
    return true;
  }

  static uint32_t checksum(const Record &record) {
    const auto *bytes = reinterpret_cast<const uint8_t *>(&record);
    uint32_t crc = 0xffffffff;
    for (size_t i = 0; i < offsetof(Record, crc); ++i) {
      crc ^= bytes[i];
      for (unsigned bit = 0; bit < 8; ++bit) crc = (crc >> 1) ^ (0xedb88320 & (0u - (crc & 1u)));
    }
    return ~crc;
  }

  static bool validRecord(const Record &record) {
    return record.magic == Magic && record.crc == checksum(record) &&
        !record.id[64] && identifier(record.id) && !record.hash[64] && validHash(record.hash) &&
        !record.bootId[16] && strlen(record.bootId) == 16 && identifier(record.bootId) &&
        record.epoch <= INT32_MAX && record.grant > 0 && record.grant <= INT32_MAX &&
        record.desired <= 1 && record.readback <= 1 &&
        ((record.phase == Prepared && !record.appliedAt) ||
         (record.phase == Completed && record.appliedAt >= record.acceptedAt));
  }

  static void slotKey(unsigned slot, char (&key)[8]) { snprintf(key, sizeof(key), "cmd%02u", slot); }

  bool save(unsigned slot, Record &record) {
    record.crc = checksum(record);
    char key[8];
    slotKey(slot, key);
    if (nvs_set_blob(nvs_, key, &record, sizeof(record)) != ESP_OK || nvs_commit(nvs_) != ESP_OK) {
      healthy_ = false;
      return false;
    }
    records_[slot] = record;
    return true;
  }

  size_t receipt(char (&out)[ReceiptCapacity], const char *id, const char *hash, const char *code,
                 const Record *record, bool state) const {
    StaticJsonDocument<512> doc;
    doc["version"] = 1;
    doc["deviceId"] = deviceId_;
    doc["firmwareRevision"] = firmwareRevision_;
    doc["bootId"] = record ? record->bootId : bootId_;
    doc["commandId"] = id;
    doc["payloadHash"] = hash;
    doc["ackCode"] = code;
    doc["acceptedUptimeMs"] = nullptr;
    doc["appliedUptimeMs"] = nullptr;
    if (record) doc["acceptedUptimeMs"] = record->acceptedAt;
    const bool completed = record && record->phase == Completed;
    if (completed) doc["appliedUptimeMs"] = record->appliedAt;
    doc["readback"]["state"] = completed ? record->readback != 0 : state;
    if (doc.overflowed()) return 0;
    size_t count = serializeJson(doc, out, sizeof(out));
    if (count >= sizeof(out) - 1) return 0;
    out[count++] = '\n';
    return count;
  }

  const char *deviceId_, *firmwareRevision_, *bootId_;
  QueueHandle_t queue_ = nullptr;
  nvs_handle_t nvs_ = 0;
  bool healthy_ = false;
  Record records_[Slots]{};
  uint32_t maxEpoch_ = 0, maxGrant_ = 0;
  Frame rx_{};
  size_t used_ = 0;
  uint64_t lastFragment_ = 0;
  bool discarding_ = false;
};
