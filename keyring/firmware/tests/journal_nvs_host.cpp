#include <algorithm>
#include <cassert>
#include <cctype>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>

using std::max;
using esp_err_t = int;
using nvs_handle_t = unsigned;
constexpr esp_err_t ESP_OK = 0, ESP_FAIL = -1, ESP_ERR_NVS_NOT_FOUND = 1,
    ESP_ERR_NVS_NO_FREE_PAGES = 2, ESP_ERR_NVS_NEW_VERSION_FOUND = 3;
constexpr int NVS_READWRITE = 1;
esp_err_t initResult = ESP_OK, commitResult = ESP_OK;
nvs_handle_t journalNvs = 0;
bool storageHealthy = false;
uint32_t maxEpoch = 0, maxGrant = 0;
esp_err_t nvs_open(const char *, int, nvs_handle_t *);
esp_err_t nvs_get_blob(nvs_handle_t, const char *, void *, size_t *);
esp_err_t nvs_set_blob(nvs_handle_t, const char *, const void *, size_t);
esp_err_t nvs_commit(nvs_handle_t);

#include "journal_nvs_subject.inc"

Record slots[JournalSlots] = {};
esp_err_t readResults[JournalSlots] = {};
JournalTail storedTail = {}, pendingTail = {};
esp_err_t tailReadResult = ESP_ERR_NVS_NOT_FOUND;
uint32_t failTailCount = JournalSlots + 1;
bool writingTail = false;
Record pendingWrite = {};
int pendingSlot = -1;
esp_err_t committedReadResult = ESP_OK;
bool corruptCommittedBlob = false;
extern "C" esp_err_t __real_nvs_flash_init() { return initResult; }
esp_err_t nvs_open(const char *name, int mode, nvs_handle_t *handle) {
    assert(std::strcmp(name, "keyring-v1") == 0 && mode == NVS_READWRITE);
    *handle = 1;
    return ESP_OK;
}
esp_err_t nvs_get_blob(nvs_handle_t handle, const char *key, void *data, size_t *size) {
    assert(handle == 1);
    if (std::strcmp(key, JournalTailKey) == 0) {
        assert(*size == sizeof(storedTail));
        if (tailReadResult == ESP_OK) std::memcpy(data, &storedTail, sizeof(storedTail));
        return tailReadResult;
    }
    assert(key[0] == 'j' && *size == sizeof(Record));
    const auto slot = std::atoi(key + 1);
    if (readResults[slot] == ESP_OK) std::memcpy(data, &slots[slot], sizeof(Record));
    return readResults[slot];
}
esp_err_t nvs_set_blob(nvs_handle_t handle, const char *key, const void *data, size_t size) {
    assert(handle == 1 && !writingTail && pendingSlot < 0);
    if (std::strcmp(key, JournalTailKey) == 0) {
        assert(size == sizeof(pendingTail));
        std::memcpy(&pendingTail, data, size);
        writingTail = true;
        return ESP_OK;
    }
    assert(key[0] == 'j' && size == sizeof(Record));
    pendingSlot = std::atoi(key + 1);
    std::memcpy(&pendingWrite, data, size);
    return ESP_OK;
}
esp_err_t nvs_commit(nvs_handle_t handle) {
    assert(handle == 1);
    if (writingTail) {
        writingTail = false;
        if (pendingTail.count == failTailCount) return ESP_FAIL;
        storedTail = pendingTail;
        tailReadResult = ESP_OK;
        return ESP_OK;
    }
    assert(pendingSlot >= 0);
    if (commitResult == ESP_OK) {
        auto &stored = slots[pendingSlot];
        std::memcpy(&stored, &pendingWrite, sizeof(stored));
        if (corruptCommittedBlob) stored.reserved[0] ^= 1;
        readResults[pendingSlot] = committedReadResult;
    }
    pendingSlot = -1;
    return commitResult;
}

void resetLoadedJournal() {
    std::memset(occupied, 0, sizeof(occupied));
    maxEpoch = maxGrant = 0;
}

int main() {
    assert(__wrap_nvs_flash_init() == ESP_OK && !journalNvsNeedsRecovery);
    const esp_err_t recoveryErrors[] = {ESP_ERR_NVS_NO_FREE_PAGES, ESP_ERR_NVS_NEW_VERSION_FOUND};
    for (const auto error : recoveryErrors) {
        journalNvsNeedsRecovery = false;
        initResult = error;
        assert(__wrap_nvs_flash_init() == ESP_FAIL && journalNvsNeedsRecovery);
    }
    initResult = ESP_OK;
    assert(__wrap_nvs_flash_init() == ESP_OK && journalNvsNeedsRecovery);

    journalNvsNeedsRecovery = false;
    std::fill_n(readResults, JournalSlots, ESP_ERR_NVS_NOT_FOUND);
    loadJournal();
    assert(storageHealthy && !occupied[0] && maxEpoch == 0);
    Record prepared = {};
    prepared.magic = JournalMagic;
    prepared.format = LegacyRecordFormat;
    prepared.phase = Prepared;
    std::memcpy(prepared.commandId, "cmd-1", sizeof("cmd-1"));
    std::memset(prepared.hash, 'a', 64);
    std::memcpy(prepared.bootId, "boot-a", sizeof("boot-a"));
    prepared.desired = 1;
    prepared.epoch = 3;
    prepared.grant = 4;
    prepared.acceptedAt = 50;
    prepared.crc = crc32(&prepared, offsetof(Record, crc));
    slots[0] = prepared;
    readResults[0] = ESP_OK;
    loadJournal();
    assert(storageHealthy && occupied[0] && !occupied[1] && maxEpoch == 3 && maxGrant == 4);

    Record completed = prepared;
    completed.phase = Completed;
    completed.result = static_cast<uint8_t>(Result::Applied);
    completed.readback = 1;
    completed.appliedAt = 51;
    commitResult = ESP_FAIL;
    assert(!storeRecord(0, completed) && !storageHealthy && journal[0].phase == Prepared);
    commitResult = ESP_OK;

    const esp_err_t readbackResults[] = {ESP_FAIL, ESP_OK};
    for (const auto status : readbackResults) {
        resetLoadedJournal();
        slots[0] = prepared;
        readResults[0] = ESP_OK;
        loadJournal();
        assert(storageHealthy);
        committedReadResult = status;
        corruptCommittedBlob = status == ESP_OK;
        assert(!storeRecord(0, completed) && !storageHealthy && journal[0].phase == Prepared);
    }
    committedReadResult = ESP_OK;
    corruptCommittedBlob = false;

    resetLoadedJournal();
    slots[0] = prepared;
    readResults[0] = ESP_OK;
    readResults[1] = ESP_FAIL;
    loadJournal();
    assert(!storageHealthy && !occupied[1]);
    resetLoadedJournal();
    readResults[1] = ESP_OK;
    slots[1] = prepared;
    loadJournal();
    assert(!storageHealthy && !occupied[1]); // Duplicate command ID across two valid records.
    resetLoadedJournal();
    readResults[1] = ESP_ERR_NVS_NOT_FOUND;
    loadJournal();
    assert(storageHealthy && storeRecord(0, completed));
    resetLoadedJournal();
    loadJournal();
    assert(storageHealthy && occupied[0] && journal[0].phase == Completed);
    resetLoadedJournal();
    slots[0].readback = 0;
    slots[0].crc = crc32(&slots[0], offsetof(Record, crc));
    loadJournal();
    assert(!storageHealthy && !occupied[0]); // Valid CRC, contradictory applied readback.

    resetLoadedJournal();
    slots[0] = prepared;
    slots[2] = completed;
    slots[2].commandId[4] = '2';
    slots[2].crc = crc32(&slots[2], offsetof(Record, crc));
    readResults[2] = ESP_OK;
    loadJournal();
    assert(!storageHealthy && occupied[0] && !occupied[2]); // Missing key before a valid newer record.

    resetLoadedJournal();
    slots[1] = slots[2];
    readResults[1] = ESP_OK;
    readResults[2] = ESP_ERR_NVS_NOT_FOUND;
    loadJournal();
    assert(storageHealthy && occupied[1] && maxEpoch == 3 && maxGrant == 4);
    resetLoadedJournal();
    --slots[1].epoch;
    slots[1].crc = crc32(&slots[1], offsetof(Record, crc));
    loadJournal();
    assert(!storageHealthy && !occupied[1]);
    resetLoadedJournal();
    ++slots[1].epoch;
    --slots[1].grant;
    slots[1].crc = crc32(&slots[1], offsetof(Record, crc));
    loadJournal();
    assert(!storageHealthy && !occupied[1]);

    resetLoadedJournal();
    std::fill_n(readResults, JournalSlots, ESP_ERR_NVS_NOT_FOUND);
    loadJournal();
    assert(storageHealthy);
    committedReadResult = ESP_ERR_NVS_NOT_FOUND;
    assert(!storeRecord(0, prepared) && !storageHealthy && !occupied[0]);

    // Existing format-1 slots remain readable and are never rewritten on adoption.
    committedReadResult = ESP_OK;
    tailReadResult = ESP_ERR_NVS_NOT_FOUND;
    slots[0] = completed;
    readResults[0] = ESP_OK;
    resetLoadedJournal();
    loadJournal();
    assert(storageHealthy && !journalTailPresent && slots[0].format == LegacyRecordFormat);

    Record next = prepared;
    next.commandId[4] = '2';
    failTailCount = 2;
    assert(!storeRecord(1, next) && !storageHealthy && !occupied[1]);
    assert(storedTail.count == 1 && readResults[1] == ESP_OK && slots[1].format == TailRecordFormat);

    // Simulate restart between writing PREPARED and advancing the tail.
    failTailCount = JournalSlots + 1;
    resetLoadedJournal();
    loadJournal();
    assert(storageHealthy && occupied[1] && journal[1].phase == Prepared && storedTail.count == 2);
    assert(slots[0].format == LegacyRecordFormat && slots[0].crc == completed.crc);

    Record later = prepared;
    later.commandId[4] = '3';
    assert(storeRecord(2, later) && storedTail.count == 3);
    later.phase = Completed;
    later.result = static_cast<uint8_t>(Result::Applied);
    later.readback = 1;
    later.appliedAt = later.acceptedAt + 1;
    assert(storeRecord(2, later));
    resetLoadedJournal();
    loadJournal();
    assert(storageHealthy && occupied[1] && journal[1].phase == Prepared);
    assert(occupied[2] && journal[2].phase == Completed);

    readResults[2] = ESP_ERR_NVS_NOT_FOUND;
    resetLoadedJournal();
    loadJournal();
    assert(!storageHealthy && !occupied[2]); // Last slot vanished while the tail survived.

    readResults[2] = ESP_OK;
    tailReadResult = ESP_ERR_NVS_NOT_FOUND;
    resetLoadedJournal();
    loadJournal();
    assert(!storageHealthy); // A format-2 record requires a tail.

    tailReadResult = ESP_OK;
    storedTail.crc ^= 1;
    resetLoadedJournal();
    loadJournal();
    assert(!storageHealthy);

    storedTail.count = 2;
    storedTail.crc = crc32(&storedTail, offsetof(JournalTail, crc));
    resetLoadedJournal();
    loadJournal();
    assert(!storageHealthy && storedTail.count == 2); // A COMPLETED append cannot be repaired.
}
