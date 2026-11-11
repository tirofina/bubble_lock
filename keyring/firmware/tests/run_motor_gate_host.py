"""Exercise the r18 timer gate, shared rail and BLE session with host-side mocks."""
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
    tx = source[source.index("void setGattReadValue("):source.index("void publishObservation() {")]
    rx = source[source.index("void receiveJournalSelector("):source.index("class ServerCallbacks")]
    wrapper = source.index('extern "C" esp_err_t __real_esp_ble_gatts_register_callback')
    registration = source[wrapper:source.index("namespace {", wrapper)]
    (output / "motor_session_subject.inc").write_text(tx + rx + registration, encoding="utf-8")
    start = source.index("  void onDisconnect(BLEServer *, esp_ble_gatts_cb_param_t *param) override {")
    end = source.index("\n};", start)
    (output / "motor_disconnect_subject.inc").write_text(source[start:end] + "\n", encoding="utf-8")
    rail = (firmware / "src" / "aux_rail.cpp").read_text(encoding="utf-8")
    (output / "aux_rail_subject.inc").write_text(rail[rail.index("namespace {"):], encoding="utf-8")
    for subject in (test, test.with_name("aux_rail_host.cpp")):
        executable = subject.stem + ".exe"
        subprocess.run(["cl", "/nologo", "/utf-8", "/std:c++14", "/EHsc", "/W4", "/I" + str(output),
                        "/I" + str(firmware / "include"), str(subject), "/Fe:" + executable],
                       cwd=output, check=True)
        subprocess.run([str(output / executable)], cwd=output, check=True)


if __name__ == "__main__":
    main()
