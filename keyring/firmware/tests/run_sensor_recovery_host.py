"""Compile the r18 sensor recovery and motion logic against a mock I2C bus."""
import argparse
from pathlib import Path
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    output = parser.parse_args().output.resolve()
    output.mkdir()
    test = Path(__file__).resolve().with_name("sensor_recovery_host.cpp")
    firmware = test.parents[1]
    main_source = (firmware / "src" / "main.cpp").read_text(encoding="utf-8")
    motion = (firmware / "src" / "motion_wake.cpp").read_text(encoding="utf-8")
    sampling = main_source[main_source.index("constexpr uint64_t AccelRetryMs"):main_source.index("std::string jsonText(")]
    (output / "sensor_recovery_subject.inc").write_text(motion[motion.index("namespace {"):] + "\n" + sampling,
                                                       encoding="utf-8")
    subprocess.run(["cl", "/nologo", "/utf-8", "/std:c++14", "/EHsc", "/W4", "/DKEYRING_IGNORE_PROVISIONING=1",
                    "/I" + str(output), "/I" + str(firmware / "include"), str(test),
                    "/Fe:sensor_recovery_host.exe"], cwd=output, check=True)
    subprocess.run([str(output / "sensor_recovery_host.exe")], cwd=output, check=True)


if __name__ == "__main__":
    main()
