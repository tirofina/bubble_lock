#!/usr/bin/env bash
# Build the oneM2M MEC IPE image on the sandbox VM and push it to the sandbox registry
# (meep-docker-registry:30001/pb-onem2m-ipe). Run from the repository root in Git Bash on the PC.
# The build context lives in .local/mec-sandbox/ipe-build (gitignored) because it holds the lab CA certificate.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
VM="${VM:-mec@192.0.2.103}"
KEY="${VM_KEY:-$HOME/VMs/mec-sandbox/id_ed25519}"
KNOWN="${VM_KNOWN_HOSTS:-$HOME/VMs/mec-sandbox/known_hosts}"
IMAGE="meep-docker-registry:30001/pb-onem2m-ipe"
CTX="$ROOT/.local/mec-sandbox/ipe-build"
# Public lab CA certificate of the sandbox ingress only. Server CSE certificates and keys never enter the
# image; deploy/mec-sandbox/ipe/attach-server-cse.sh mounts them from a Kubernetes secret.
MEC_CA="${MEC_CA_PEM:-$ROOT/.local/mec-sandbox/ca.pem}"
rm -rf "$CTX" "$CTX.tgz"; mkdir -p "$CTX/integration/src" "$CTX/scripts"
cp "$ROOT/deploy/mec-sandbox/ipe/Dockerfile" "$CTX/"
printf '{ "name": "pb-onem2m-ipe", "private": true, "type": "module" }\n' > "$CTX/package.json"
for f in mec-ipe.mjs mec-ipe-relocatable.mjs integration-utils.mjs integration-store.mjs mec-state.mjs mec-platform-client.mjs onem2m-http-client.mjs; do
  cp "$ROOT/pc-mobius/integration/src/$f" "$CTX/integration/src/"
done
cp "$ROOT/pc-mobius/scripts/run-mec-ipe-pod.mjs" "$CTX/scripts/"
cp "$MEC_CA" "$CTX/ca.pem"
if grep -rqs "PRIVATE KEY" "$CTX"; then echo "refusing: the build context holds a private key" >&2; exit 1; fi
TAG="${TAG:-$(date -u +%Y%m%dT%H%M%S)}"
tar -C "$CTX" -czf "$CTX.tgz" .
scp -q -i "$KEY" -o UserKnownHostsFile="$KNOWN" -o BatchMode=yes "$CTX.tgz" "$VM:pb-ipe-build.tgz"
ssh -i "$KEY" -o UserKnownHostsFile="$KNOWN" -o BatchMode=yes "$VM" "set -e; rm -rf ~/pb-ipe-build; mkdir ~/pb-ipe-build; tar -C ~/pb-ipe-build -xzf ~/pb-ipe-build.tgz; cd ~/pb-ipe-build; docker build -q -t $IMAGE:latest -t $IMAGE:$TAG . >/dev/null; docker push -q $IMAGE:latest >/dev/null; docker push -q $IMAGE:$TAG >/dev/null; echo tag=$TAG; docker image inspect --format 'image={{.Id}} repoDigest={{index .RepoDigests 0}}' $IMAGE:latest"
