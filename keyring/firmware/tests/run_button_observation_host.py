"""Exercise r18 observation framing and screen requests on a host without BLE."""
import argparse
from pathlib import Path
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--arduinojson", type=Path, required=True, help="ArduinoJson 6.21.5 src directory")
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir()
    test = Path(__file__).resolve().with_name("button_observation_host.cpp")
    firmware = test.parents[1]
    source = (firmware / "src" / "main.cpp").read_text(encoding="utf-8")
    production = source[source.index("std::string jsonText("):source.index("void publishReceipt(")]
    (output / "button_observation_subject.inc").write_text(production, encoding="utf-8")
    lcd = (firmware / "src" / "peripherals.cpp").read_text(encoding="utf-8")
    screen = lcd[lcd.index("void Peripherals::update("):lcd.index("void Peripherals::logReceipt(")]
    (output / "button_screen_subject.inc").write_text(screen, encoding="utf-8")
    subprocess.run(["cl", "/nologo", "/utf-8", "/std:c++14", "/EHsc", "/W4", "/I" + str(output),
                    "/I" + str(firmware / "include"), "/I" + str(args.arduinojson.resolve()), str(test),
                    "/Fe:button_observation_host.exe"], cwd=output, check=True)
    subprocess.run([str(output / "button_observation_host.exe")], cwd=output, check=True)


if __name__ == "__main__":
    main()
