#include <cassert>
#include <cstdio>
#include <string>
#include "command_wire.h"

#ifdef NDEBUG
#error Keep assertions enabled for the command wire test
#endif

namespace {
constexpr char Device[] = "kr-r18";
struct Verdict { bool parsedShape, accepted; };

Verdict check(const std::string &wire) {
  DynamicJsonDocument doc(8192);
  if (deserializeJson(doc, wire.c_str(), wire.size(), DeserializationOption::NestingLimit(4))) return {false, false};
  const auto command = doc.as<JsonObjectConst>();
  return {commandWire::validShape(command, Device), commandWire::valid(command, Device, wire.c_str(), wire.size())};
}

std::string replace(std::string wire, const char *from, const char *to) {
  const auto position = wire.find(from);
  assert(position != std::string::npos);
  wire.replace(position, std::strlen(from), to);
  return wire;
}

void rejectedAfterParsing(const std::string &wire) {
  const auto result = check(wire);
  assert(result.parsedShape && !result.accepted);
}
}

int main() {
  const std::string hash(64, 'a');
  const std::string compact =
      R"({"version":1,"type":"command","deviceId":"kr-r18","commandId":"cmd:1","desiredState":{"state":true},)"
      R"("grantRevision":2,"ownershipEpoch":0,"payloadHash":")" + hash + R"(","remainingMs":2500})";
  assert(check(compact).accepted);
  assert(check(" \t" + compact + "\r\t ").accepted);
  assert(check(compact + std::string(4096 - compact.size(), ' ')).accepted);
  assert(check(replace(compact, R"("cmd:1")", R"("cmd\u003a1")")).accepted);
  assert(check(replace(compact, R"("deviceId")", R"("device\u0049d")")).accepted);
  assert(check(R"({"remainingMs":2500, )" + compact.substr(1, compact.find(R"(,"remainingMs")") - 1) + "}").accepted);
  std::puts("PASS compact, spaced, reordered, escaped and 4096-byte valid frames");

  rejectedAfterParsing(R"({"remainingMs":1,)" + compact.substr(1));
  rejectedAfterParsing(replace(compact, R"({"state":true})", R"({"state":false,"state":true})"));
  rejectedAfterParsing(replace(compact, R"({"state":true})", R"({"st\u0061te":false,"state":true})"));
  std::puts("PASS raw top-level and nested duplicates collapse in ArduinoJson and are rejected");

  rejectedAfterParsing(compact + " {}");
  rejectedAfterParsing(compact + " junk");
  assert(!check(replace(compact, R"("kr-r18")", R"("kr-r18\u0000other")")).accepted);
  assert(!check(replace(compact, R"("deviceId")", R"("deviceId\u0000other")")).accepted);
  std::puts("PASS concatenated values, trailing bytes and escaped NUL are rejected");

  assert(!check(replace(compact, R"("deviceId")", "deviceId")).accepted);
  assert(!check(replace(compact, R"("command")", "'command'")).accepted);
  assert(!check(replace(compact, R"("state":true)", R"("state":1)")).accepted);
  assert(!check(replace(compact, R"("grantRevision":2)", R"("grantRevision":0)")).accepted);
  assert(!check(replace(compact, R"("ownershipEpoch":0)", R"("ownershipEpoch":-1)")).accepted);
  assert(!check(replace(compact, R"("remainingMs":2500)", R"("remainingMs":30001)")).accepted);
  std::puts("PASS permissive JSON syntax and invalid command field types or limits are rejected");
}
