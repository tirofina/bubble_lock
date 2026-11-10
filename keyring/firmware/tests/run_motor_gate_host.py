"""Exercise the r18 timer gate and disconnect callback with host-side GPIO mocks."""
import argparse
from pathlib import Path
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir()
    test = Path(__file__).resolve().with_name("motor_gate_host.cpp")
    firmware = test.parents[1]
    source = (firmware / "src" / "main.cpp").read_text(encoding="utf-8")
    # Compile the production gate unchanged, without linking the Arduino BLE runtime.
    gate = source[source.index("void stopMotor() {"):source.index("void safePins() {")]
    (output / "motor_gate_subject.inc").write_text(gate, encoding="utf-8")
    start = source.index("  void onDisconnect(BLEServer *) override {")
    end = source.index("\n};", start)
    (output / "motor_disconnect_subject.inc").write_text(source[start:end] + "\n", encoding="utf-8")
    subprocess.run(["cl", "/nologo", "/utf-8", "/std:c++14", "/EHsc", "/W4", "/I" + str(output),
                    "/I" + str(firmware / "include"), str(test), "/Fe:motor_gate_host.exe"],
                   cwd=output, check=True)
    subprocess.run([str(output / "motor_gate_host.exe")], cwd=output, check=True)


if __name__ == "__main__":
    main()
