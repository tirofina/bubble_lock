#!/usr/bin/env bash
# Attach every oneM2M MEC IPE deployment (pb-ipe-mep*) of sandbox "dayofcare" to the team's server CSE
# (Mobius4 /bubble-cse behind the nginx originator-binding route https://<SERVER_DOMAIN>:8443/onem2m).
# Runs on the sandbox VM as the VM user (kubectl). Re-run it after a relocation adds pb-ipe-mep2, or after
# a scenario re-activation re-creates pb-ipe-mep1 from the scenario yaml:
#   ssh mec@<VM_IP> 'bash -s' < deploy/mec-sandbox/ipe/attach-server-cse.sh
#   ssh mec@<VM_IP> 'ONLY=pb-ipe-mep2 bash -s' < deploy/mec-sandbox/ipe/attach-server-cse.sh
# What it does:
#   1. Secret pb-ipe-server-cse in the namespace, created on the VM from the server deployment files
#      (client certificate CN pb-mec-ipe, its key, the server trust bundle). Nothing is copied off the VM
#      and nothing enters the image or the repository.
#   2. For each deployment: secret volume (mode 0440, fsGroup 1000 for the image's node user), mount at
#      /etc/pb-ipe/server-cse, hostAliases <SERVER_DOMAIN> -> the VM address (SNI and Host must carry
#      the DNS name of the server certificate), and the ONEM2M_* / MEC_IPE_* environment; then a rollout.
# The deployments are Helm releases of the sandbox virt-engine; a scenario re-activation or a new
# SCENARIO-UPDATE ADD renders them again from the scenario yaml, so this script is re-run afterwards.
set -euo pipefail
NS="${NAMESPACE:-dayofcare}"
SRC="${IPE_CERT_DIR:-$HOME/bubblelock-nocert/repo/.local/deployment/ipe}"
SECRET="${SECRET:-pb-ipe-server-cse}"
MOUNT="${MOUNT:-/etc/pb-ipe/server-cse}"
CSE_URL="${CSE_URL:?set CSE_URL, for example https://<SERVER_DOMAIN>:8443/onem2m}"
CSE_HOST="${CSE_HOST:?set CSE_HOST to the server domain in the server certificate SAN}"
CSE_IP="${CSE_IP:-192.0.2.103}"
CSE_ID="${CSE_ID:-/bubble-cse}"
CSE_BASE="${CSE_BASE:-/Mobius}"
REQUESTERS="${REQUESTERS:-Cguardian-app}"
READERS="${READERS:-Cguardian-app;Cpb-orchestrator;Cpb-dash-guardian;Cpb-dash-operator}"
ORCHESTRATORS="${ORCHESTRATORS:-Cpb-orchestrator}"
ONLY="${ONLY:-}"

for file in ipe.pem ipe.key trust-bundle.pem; do [ -r "$SRC/$file" ] || { echo "missing $SRC/$file" >&2; exit 2; }; done
# 1. Secret (server-side apply keeps no last-applied copy of the data in an annotation).
kubectl -n "$NS" create secret generic "$SECRET" \
  --from-file=client.pem="$SRC/ipe.pem" --from-file=client.key="$SRC/ipe.key" --from-file=trust-bundle.pem="$SRC/trust-bundle.pem" \
  --dry-run=client -o json \
  | python3 -c 'import json,sys; s=json.load(sys.stdin); s["metadata"]["labels"]={"app.kubernetes.io/part-of":"pb-onem2m-ipe","pb.bubble/role":"server-cse-client"}; json.dump(s,sys.stdout)' \
  | kubectl apply --server-side --force-conflicts --field-manager=pb-ipe-attach -f - >/dev/null
SECRET_VERSION="$(kubectl -n "$NS" get secret "$SECRET" -o jsonpath='{.metadata.resourceVersion}')"
echo "secret $NS/$SECRET resourceVersion $SECRET_VERSION (keys: client.pem client.key trust-bundle.pem)"

# 2. Deployments.
deployments="$(kubectl -n "$NS" get deploy -o name | sed -n 's#^deployment.apps/##p' | grep -E '^pb-ipe-mep[0-9]+$' || true)"
[ -n "$ONLY" ] && deployments="$(printf '%s\n' $deployments | grep -x -F "$ONLY" || true)"
[ -n "$deployments" ] || { echo "no pb-ipe-mep* deployment in namespace $NS"; exit 0; }
for name in $deployments; do
  containers="$(kubectl -n "$NS" get deploy "$name" -o jsonpath='{.spec.template.spec.containers[*].name}')"
  case " $containers " in *" $name "*) ;; *) echo "$name: container $name not found ($containers)" >&2; continue ;; esac
  patch="$(python3 - "$name" <<PY
import json, sys
name = sys.argv[1]
env = {
  "ONEM2M_CSE_URL": "$CSE_URL", "ONEM2M_CSE_ID": "$CSE_ID", "ONEM2M_CSE_BASE": "$CSE_BASE",
  "ONEM2M_CA_FILE": "$MOUNT/trust-bundle.pem", "ONEM2M_CLIENT_CERT_FILE": "$MOUNT/client.pem", "ONEM2M_CLIENT_KEY_FILE": "$MOUNT/client.key",
  "MEC_IPE_REQUESTERS": "$REQUESTERS", "MEC_IPE_READERS": "$READERS", "MEC_IPE_ORCHESTRATORS": "$ORCHESTRATORS",
}
print(json.dumps({"spec": {"template": {
  "metadata": {"annotations": {"pb.bubble/server-cse-secret-version": "$SECRET_VERSION", "pb.bubble/server-cse": "$CSE_URL"}},
  "spec": {
    "hostAliases": [{"ip": "$CSE_IP", "hostnames": ["$CSE_HOST"]}],
    "securityContext": {"fsGroup": 1000},
    "volumes": [{"name": "pb-server-cse", "secret": {"secretName": "$SECRET", "defaultMode": 0o440}}],
    "containers": [{"name": name, "volumeMounts": [{"name": "pb-server-cse", "mountPath": "$MOUNT", "readOnly": True}],
                    "env": [{"name": k, "value": v} for k, v in env.items()]}]}}}}))
PY
)"
  kubectl -n "$NS" patch deploy "$name" --type strategic -p "$patch" >/dev/null
  kubectl -n "$NS" rollout status deploy "$name" --timeout=180s
  pod="$(kubectl -n "$NS" get pods -l "meepAppId=$(kubectl -n "$NS" get deploy "$name" -o jsonpath='{.spec.selector.matchLabels.meepAppId}')" --field-selector=status.phase=Running --sort-by=.metadata.creationTimestamp -o jsonpath='{.items[-1:].metadata.name}')"
  echo "$name: pod $pod, image $(kubectl -n "$NS" get pod "$pod" -o jsonpath="{.status.containerStatuses[?(@.name==\"$name\")].imageID}")"
done
