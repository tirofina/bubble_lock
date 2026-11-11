"""실제 DAC 제어 C++를 모의 I2C/시간 경계로 컴파일해 실행한다."""
import argparse
import pathlib
import subprocess
import sys

root = pathlib.Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument("--output", type=pathlib.Path, required=True)
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
target = args.output / ("headphone-host.exe" if sys.platform == "win32" else "headphone-host")
command = [sys.executable, "-m", "ziglang", "c++", "-std=c++17", "-O1", "-DKEYRING_IGNORE_PROVISIONING=1", "-DKEYRING_ENABLE_AUDIO=1", "-DKEYRING_AUDIO_OUTPUT=2", "-I", str(root / "test/host"), "-I", str(root / "include"), str(root / "test/host/headphone_test.cpp"), str(root / "src/headphone_standby.cpp"), "-o", str(target)]
subprocess.run(command, check=True)
subprocess.run([str(target)], check=True)
