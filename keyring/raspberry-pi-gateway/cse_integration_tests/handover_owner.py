"""Opt-in mTLS rehearsal of the team handover API and KEYRING ownership guard."""
import os
from pathlib import Path
import subprocess

from tls_fixture import TestPki


def main():
    pki = TestPki()
    try:
        pki.leaf("gateway-b", "trusted", 7, "clientAuth", subject="gw-b-test")
        pki.leaf("guardian", "trusted", 8, "clientAuth", subject="guardian-test")
        subprocess.run(["node", str(Path(__file__).with_suffix(".mjs")),
                        os.environ["KEYRING_TEST_CENTRAL_TREE"], str(pki.root)], check=True, timeout=45)
    finally:
        pki.close()


if __name__ == "__main__":
    main()
