#pragma once

#include <algorithm>
#include <cassert>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <map>
#include <memory>
#include <string>
#include <vector>

using std::max;
inline uint64_t clockMs = 100;
inline int64_t esp_timer_get_time() { return clockMs * 1000; }

struct Queue {
  std::vector<unsigned char> bytes;
  bool full = false;
};
using QueueHandle_t = Queue *;
inline std::vector<std::unique_ptr<Queue>> queues;
constexpr int pdTRUE = 1;
inline QueueHandle_t xQueueCreate(int depth, size_t size) {
  assert(depth == 1);
  queues.push_back(std::make_unique<Queue>());
  queues.back()->bytes.resize(size);
  return queues.back().get();
}
inline void xQueueReset(QueueHandle_t queue) { queue->full = false; }
inline int xQueueSend(QueueHandle_t queue, const void *source, int) {
  if (queue->full) return 0;
  memcpy(queue->bytes.data(), source, queue->bytes.size());
  queue->full = true;
  return pdTRUE;
}
inline int xQueueReceive(QueueHandle_t queue, void *destination, int) {
  if (!queue->full) return 0;
  memcpy(destination, queue->bytes.data(), queue->bytes.size());
  queue->full = false;
  return pdTRUE;
}

using nvs_handle_t = int;
constexpr int ESP_OK = 0, ESP_ERR_NVS_NOT_FOUND = 1, NVS_READWRITE = 2;
inline std::map<std::string, std::vector<unsigned char>> durable;
inline std::string stagedKey;
inline std::vector<unsigned char> stagedValue;
inline unsigned commits = 0, failCommit = 0, commitDelayMs = 0;
inline int nvs_open(const char *, int, nvs_handle_t *handle) { *handle = 1; return ESP_OK; }
inline int nvs_get_blob(nvs_handle_t, const char *key, void *target, size_t *size) {
  const auto value = durable.find(key);
  if (value == durable.end()) return ESP_ERR_NVS_NOT_FOUND;
  if (*size < value->second.size()) return -1;
  *size = value->second.size();
  memcpy(target, value->second.data(), *size);
  return ESP_OK;
}
inline int nvs_set_blob(nvs_handle_t, const char *key, const void *value, size_t size) {
  stagedKey = key;
  const auto *bytes = static_cast<const unsigned char *>(value);
  stagedValue.assign(bytes, bytes + size);
  return ESP_OK;
}
inline int nvs_commit(nvs_handle_t) {
  clockMs += commitDelayMs;
  if (++commits == failCommit) return -1;
  durable[stagedKey] = stagedValue;
  return ESP_OK;
}
