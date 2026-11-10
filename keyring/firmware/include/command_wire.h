#pragma once

#include <ArduinoJson.h>
#include <cstring>

namespace commandWire {
constexpr const char *Fields[] = {"version", "type", "deviceId", "commandId", "desiredState",
    "grantRevision", "ownershipEpoch", "payloadHash", "remainingMs"};
constexpr const char *DesiredFields[] = {"state"};

inline bool whitespace(char byte) { return byte == ' ' || byte == '\t' || byte == '\r' || byte == '\n'; }

inline bool hasExpectedMembers(const char *bytes, size_t length) {
  const size_t expected = sizeof(Fields) / sizeof(Fields[0]) + sizeof(DesiredFields) / sizeof(DesiredFields[0]);
  size_t members = 0;
  unsigned depth = 0;
  bool inString = false, closed = false, needsKey = false;
  for (size_t index = 0; index < length; ++index) {
    const char byte = bytes[index];
    if (inString) {
      if (static_cast<unsigned char>(byte) < 32) return false;
      if (byte == '"') inString = false;
      else if (byte == '\\') {
        if (++index == length) return false;
        if (bytes[index] == 'u') {
          if (length - index < 5 || std::memcmp(bytes + index + 1, "0000", 4) == 0) return false;
          index += 4; // ArduinoJson has already validated the escape's hex digits.
        }
      }
      continue;
    }
    if (whitespace(byte)) continue;
    if (closed || (!depth && byte != '{') || (needsKey && byte != '"' && byte != '}')) return false;
    switch (byte) {
      case '{': if (++depth > 2) return false; needsKey = true; break;
      case '}': closed = --depth == 0; needsKey = false; break;
      case '"': inString = true; needsKey = false; break;
      case ',': needsKey = true; break;
      case ':': if (++members > expected) return false; break;
      case '\'': case '[': case ']': case '/': return false;
      default: if (static_cast<unsigned char>(byte) < 32) return false;
    }
  }
  // The parsed shape requires all distinct fields. Additional raw member
  // delimiters indicate duplicate names even when the parser collapses them.
  return closed && members == expected;
}

template <size_t Count>
bool exactFields(JsonObjectConst object, const char *const (&allowed)[Count]) {
  if (object.size() != Count) return false;
  for (JsonPairConst field : object) {
    bool found = false;
    for (const char *name : allowed) if (std::strcmp(field.key().c_str(), name) == 0) found = true;
    if (!found) return false;
  }
  return true;
}

inline bool validShape(JsonObjectConst command, const char *deviceId) {
  const char *kind = command["type"], *target = command["deviceId"];
  const auto desired = command["desiredState"].as<JsonObjectConst>();
  return exactFields(command, Fields) && command["version"].is<int>() && command["version"].as<int>() == 1 &&
      kind && std::strcmp(kind, "command") == 0 && target && std::strcmp(target, deviceId) == 0 &&
      exactFields(desired, DesiredFields) && desired["state"].is<bool>() &&
      command["grantRevision"].is<int32_t>() && command["grantRevision"].as<int32_t>() > 0 &&
      command["ownershipEpoch"].is<int32_t>() && command["ownershipEpoch"].as<int32_t>() >= 0 &&
      command["remainingMs"].is<uint32_t>() && command["remainingMs"].as<uint32_t>() >= 1 &&
      command["remainingMs"].as<uint32_t>() <= 30000;
}

inline bool valid(JsonObjectConst command, const char *deviceId, const char *bytes, size_t length) {
  return validShape(command, deviceId) && hasExpectedMembers(bytes, length);
}
}
