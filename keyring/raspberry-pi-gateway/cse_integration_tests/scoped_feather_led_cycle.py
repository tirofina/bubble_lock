"""Run the explicit Feather LED cycle against the existing scoped loopback services."""
import argparse
import asyncio
from functools import partial
from pathlib import Path

from bubble_gateway.integration_evidence import integration_settlement
from bubble_gateway.model import iso_time
from pi_led_cycle import FIRMWARE, STEPS, run_led_cycle, verify_step, write_new_json
from scoped_command_io import hash_observation, scoped_api, scoped_clients
from scoped_feather_evidence import (DISPLAY_TEXTS, GATEWAY, check_display_observation, integration_observation_event,
                                    read_json)
from scoped_feather_pi import COMMAND_FIRMWARES, DISPLAY_FIRMWARE

PARENT = "/Mobius/privacy-bubble-test-ae"
PATHS = {"observation": f"{PARENT}/command-observations-a", "receipt": f"{PARENT}/command-receipts-a",
         "health": f"{PARENT}/health"}


def record_display(output, label, screen_text):
    observed_at = iso_time()
    stage = label.lower()
    step = read_json(output / f"led-{stage}-readback.json")
    command = verify_step(step, dict(STEPS)[label], step["observation"]["bootId"],
                          gateway_id=GATEWAY, firmware=DISPLAY_FIRMWARE)
    revoked = read_json(output / f"led-{stage}-grant-revoked.json")
    if revoked.get("status") != "REVOKED":
        raise ValueError("Record the screen after the step's grant is revoked")
    if label == "ON" and (output / "led-off-intent.json").exists():
        raise ValueError("Record the ON screen before the OFF command is requested")
    observation = {"commandId": command["commandId"], "screenText": screen_text, "observedAt": observed_at}
    check_display_observation(step, observation)
    path = output / f"display-{stage}.json"
    write_new_json(path, observation)
    return path


async def record_central_observations(steps, state_path, output):
    if any("payloadHash" not in step["observation"] for step in steps):
        raise ValueError("Native observation payload hashes are incomplete for the LED cycle")
    print("LED_CYCLE_WAITING_FOR_CENTRAL_TELEMETRY", flush=True)
    try:
        async with asyncio.timeout(35):
            while not (output / "STOP").exists():
                team_state = await asyncio.to_thread(read_json, state_path)
                on, off = (integration_observation_event(step, team_state, allow_pending=True) for step in steps)
                if on is not None and off is not None:
                    if on["sequence"] >= off["sequence"]:
                        raise ValueError("Central telemetry order does not match the LED cycle")
                    keys = ("eventId", "observationId", "payloadHash", "sequence", "observedAt", "timestamp")
                    evidence = [{"commandId": step["command"]["commandId"], **{key: event[key] for key in keys}}
                                for step, event in zip(steps, (on, off))]
                    write_new_json(output / "central-telemetry.json", {"observations": evidence})
                    print("LED_CYCLE_CENTRAL_TELEMETRY_VERIFIED", flush=True)
                    return
                await asyncio.sleep(0.25)
    except TimeoutError:
        raise RuntimeError("Central telemetry did not arrive for both observations; led-cycle.json was retained") from None
    raise RuntimeError("Stopped while waiting for central telemetry; led-cycle.json was retained")


async def run(output, seconds, *, api_mode="legacy", firmware=FIRMWARE):
    api, operator_dir = scoped_api(api_mode)
    state_path = operator_dir / "runtime.json"
    integration = api_mode == "integration"
    observation_hasher = None
    if integration:
        team_utils = operator_dir / "team-source/pc-mobius/integration/src/integration-utils.mjs"
        observation_hasher = partial(hash_observation, team_utils)
        await asyncio.to_thread(observation_hasher, {})
    async with scoped_clients(api, operator_dir) as (cse, operator_post), asyncio.timeout(seconds):
        output.mkdir(mode=0o700)
        async def central_settlement(command, receipt):
            team_state = await asyncio.to_thread(read_json, state_path)
            return integration_settlement(command, receipt, team_state)

        steps = await run_led_cycle(operator_post, cse, PATHS, output, gateway_id=GATEWAY, subject_id="scoped-feather-bench",
                                    central_settlement=central_settlement if integration else None,
                                    observation_hasher=observation_hasher, firmware=firmware)
        if integration:
            await record_central_observations(steps, state_path, output)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path,
                        help="Private bench directory. It must be new when starting a cycle.")
    parser.add_argument("--seconds", type=int, default=600, choices=range(30, 1801), metavar="30..1800")
    parser.add_argument("--api-mode", choices=("legacy", "integration"), default="legacy")
    parser.add_argument("--firmware-revision", choices=COMMAND_FIRMWARES, default=FIRMWARE)
    parser.add_argument("--record-display", choices=[label for label, _ in STEPS],
                        help="Record the observed screen for a completed stage using local files")
    parser.add_argument("--screen-text", choices=(*DISPLAY_TEXTS, "NOT_VISIBLE"))
    args = parser.parse_args()
    if (args.record_display is None) != (args.screen_text is None):
        parser.error("--record-display and --screen-text must be supplied together")
    if args.record_display:
        text = None if args.screen_text == "NOT_VISIBLE" else args.screen_text
        try:
            path = record_display(args.output.resolve(), args.record_display, text)
        except (AttributeError, KeyError, OSError, TypeError, ValueError, RuntimeError) as error:
            parser.exit(1, f"Screen observation could not be recorded: {error}\n")
        print(path)
    else:
        asyncio.run(run(args.output.resolve(), args.seconds, api_mode=args.api_mode, firmware=args.firmware_revision))
