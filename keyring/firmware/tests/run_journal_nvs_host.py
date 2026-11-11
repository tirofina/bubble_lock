"""Build the r18 journal routines against host NVS fault injection."""
import argparse
from pathlib import Path
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir()
    test = Path(__file__).resolve().with_name("journal_nvs_host.cpp")
    source = (test.parents[1] / "src" / "main.cpp").read_text(encoding="utf-8")
    ranges = (
        ("static bool journalNvsNeedsRecovery", "namespace {"),
        ("constexpr unsigned JournalSlots", "uint64_t uptime()"),
        ("struct Record {", "struct JournalRequest {"),
        ("uint32_t crc32(", "void output("),
        ("bool identifier(const char *value) {", "void processCommand("),
    )
    sections = []
    for marker, end in ranges:
        start = source.index(marker)
        sections.append(source[start:source.index(end, start)])
    (output / "journal_nvs_subject.inc").write_text("".join(sections), encoding="utf-8")
    subprocess.run(["cl", "/nologo", "/utf-8", "/std:c++14", "/EHsc", "/W4", "/I" + str(output),
                    str(test), "/Fe:journal_nvs_host.exe"], cwd=output, check=True)
    subprocess.run([str(output / "journal_nvs_host.exe")], cwd=output, check=True)


if __name__ == "__main__":
    main()
