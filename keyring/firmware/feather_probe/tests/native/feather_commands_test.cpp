#include "stubs/bench_platform.h"
#include "../../feather_commands.h"

#ifdef NDEBUG
#error Keep assertions enabled for the native bench test
#endif

namespace {
constexpr char Device[] = "keyring-feather-lab";
constexpr char Firmware[] = "feather-probe-0.2.0";
constexpr char Boot[] = "0123456789abcdef", Restart[] = "fedcba9876543210";
unsigned applications;
bool pin;

bool readPin() { return pin; }
void clearPin() { pin = false; }
bool applyPin(uint32_t generation, bool state, uint64_t deadline, uint64_t &at, bool &readback) {
  if (generation != 7 || clockMs >= deadline) return false;
  assert(durable.size() > applications);
  ++applications;
  at = clockMs;
  readback = pin = state;
  return true;
}

std::string command(const std::string &id, unsigned grant = 3, unsigned epoch = 2, bool state = true,
                    unsigned budget = 2500) {
  return "{\"version\":1,\"type\":\"command\",\"deviceId\":\"" + std::string(Device)
      + "\",\"commandId\":\"" + id + "\",\"desiredState\":{\"state\":" + (state ? "true" : "false")
      + "},\"grantRevision\":" + std::to_string(grant) + ",\"ownershipEpoch\":" + std::to_string(epoch)
      + ",\"payloadHash\":\"" + std::string(64, 'a') + "\",\"remainingMs\":" + std::to_string(budget) + "}\n";
}

void send(FeatherCommands &target, const std::string &wire, uint32_t generation = 7) {
  for (size_t i = 0; i < wire.size(); i += 20)
    target.receive(reinterpret_cast<const uint8_t *>(wire.data() + i),
                   std::min(size_t{20}, wire.size() - i), generation);
}

std::string result(FeatherCommands &target, const char *code, uint32_t generation = 7) {
  char out[FeatherCommands::ReceiptCapacity];
  const size_t length = target.process(generation, out, readPin, applyPin, clearPin);
  if (!code) { assert(!length); return {}; }
  assert(length && out[length - 1] == '\n');
  StaticJsonDocument<1024> json;
  assert(!deserializeJson(json, static_cast<const char *>(out), length - 1));
  assert(json.size() == 10 && json["ackCode"] == code && json["deviceId"] == Device);
  assert(json["firmwareRevision"] == Firmware && json["readback"]["state"].is<bool>());
  return {out, length};
}

void reset() {
  durable.clear();
  queues.clear();
  clockMs = 100;
  applications = commits = failCommit = commitDelayMs = 0;
  pin = false;
}
}

int main() {
  reset();
  FeatherCommands live(Device, Firmware, Boot);
  assert(live.begin());
  send(live, command("first"));
  const auto receipt = result(live, "APPLIED");
  assert(pin && applications == 1 && commits == 2 && receipt.find("\"state\":true") != std::string::npos);
  clearPin();
  FeatherCommands restarted(Device, Firmware, Restart);
  assert(restarted.begin());
  send(restarted, command("first"));
  const auto duplicate = result(restarted, "DUPLICATE");
  assert(!pin && applications == 1 && duplicate.find(Boot) != std::string::npos &&
         duplicate.find("\"state\":true") != std::string::npos);
  send(restarted, command("first", 3, 2, false));
  result(restarted, "CONFLICT");
  send(restarted, command("stale-epoch", 3, 1));
  result(restarted, "REJECTED_EPOCH");
  send(restarted, command("stale-grant", 2, 2));
  result(restarted, "REJECTED_GRANT");
  send(restarted, "{\"version\":1," + command("duplicate-field").substr(1));
  result(restarted, "INVALID");
  send(restarted, command("old-session"), 6);
  result(restarted, nullptr);
  send(restarted, command("dropped"));
  restarted.discardInput();
  result(restarted, nullptr);
  send(restarted, command("expired", 3, 2, true, 1));
  ++clockMs;
  result(restarted, "EXPIRED");
  assert(applications == 1 && commits == 2);
  send(restarted, command("off", 3, 2, false));
  const auto off = result(restarted, "APPLIED");
  assert(!pin && applications == 2 && off.find("\"state\":false") != std::string::npos);
  puts("PASS apply, restart duplicate, conflict, fences, JSON and session rejection, deadline");

  reset();
  FeatherCommands delayed(Device, Firmware, Boot);
  assert(delayed.begin());
  commitDelayMs = 2;
  send(delayed, command("late", 3, 2, true, 1));
  result(delayed, "INDETERMINATE");
  assert(!applications && !pin && durable.size() == 1);
  FeatherCommands afterDelay(Device, Firmware, Restart);
  assert(afterDelay.begin());
  send(afterDelay, command("late"));
  result(afterDelay, "INDETERMINATE");
  assert(!applications);
  puts("PASS deadline crossed during durable intent and restart does not reapply");

  reset();
  FeatherCommands blocked(Device, Firmware, Boot);
  assert(blocked.begin());
  failCommit = 1;
  send(blocked, command("uncommitted"));
  result(blocked, "STORAGE_ERROR");
  assert(!applications && !pin && durable.empty());

  reset();
  FeatherCommands interrupted(Device, Firmware, Boot);
  assert(interrupted.begin());
  failCommit = 2;
  send(interrupted, command("uncertain"));
  result(interrupted, "INDETERMINATE");
  assert(applications == 1 && !pin);
  FeatherCommands afterFailure(Device, Firmware, Restart);
  assert(afterFailure.begin());
  send(afterFailure, command("uncertain"));
  result(afterFailure, "INDETERMINATE");
  assert(applications == 1 && !pin);
  puts("PASS intent and completion commit failures fence execution and replay");

  reset();
  FeatherCommands full(Device, Firmware, Boot);
  assert(full.begin());
  for (unsigned i = 0; i < 16; ++i) {
    send(full, command("slot-" + std::to_string(i)));
    result(full, "APPLIED");
  }
  send(full, command("overflow"));
  result(full, "JOURNAL_FULL");
  assert(applications == 16 && durable.size() == 16);
  durable.begin()->second[0] ^= 1;
  FeatherCommands corrupt(Device, Firmware, Restart);
  assert(corrupt.begin());
  send(corrupt, command("corrupt"));
  result(corrupt, "STORAGE_ERROR");
  assert(applications == 16);
  puts("PASS bounded journal and corrupt record rejection");
}
