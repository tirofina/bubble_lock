#!/usr/bin/env bash
# Import (or update) the day-of-care scenario into platform-ctrl and run it in sandbox "dayofcare".
# Runs on the sandbox VM as the VM user (kubectl and python3 with PyYAML). Usage:
#   scp deploy/mec-sandbox/scenarios/day-of-care.yaml mec@192.168.0.103:~/day-of-care.yaml
#   ssh mec@192.168.0.103 'bash -s' < deploy/mec-sandbox/import-day-of-care.sh            # first time
#   ssh mec@192.168.0.103 'REACTIVATE=1 bash -s' < deploy/mec-sandbox/import-day-of-care.sh  # after a yaml change
# The platform-ctrl ClusterIP path is the same one the Ansible playbook uses for scenario import; creating a
# sandbox through the ingress needs an admin session, so this script stays inside the VM.
set -euo pipefail
YAML="${YAML:-$HOME/day-of-care.yaml}"
SCENARIO="${SCENARIO:-day-of-care}"
SANDBOX="${SANDBOX:-dayofcare}"
PLATFORM="$(kubectl get svc meep-platform-ctrl -o jsonpath='{.spec.clusterIP}')"
JSON="$(mktemp)"
python3 -c "import sys, yaml, json; sc = yaml.safe_load(open(sys.argv[1])); sc['name'] = sys.argv[2]; print(json.dumps(sc))" "$YAML" "$SCENARIO" > "$JSON"
echo "scenario json sha256 $(sha256sum "$JSON" | cut -d' ' -f1), yaml sha256 $(sha256sum "$YAML" | cut -d' ' -f1)"
code=$(curl -s -o /dev/null -w '%{http_code}' "http://$PLATFORM/platform-ctrl/v1/scenarios/$SCENARIO")
if [ "$code" = "200" ]; then
  curl -sf -X PUT -H 'Content-Type: application/json' -d @"$JSON" "http://$PLATFORM/platform-ctrl/v1/scenarios/$SCENARIO" >/dev/null && echo "scenario $SCENARIO updated"
else
  curl -sf -X POST -H 'Content-Type: application/json' -d @"$JSON" "http://$PLATFORM/platform-ctrl/v1/scenarios/$SCENARIO" >/dev/null && echo "scenario $SCENARIO imported"
fi
rm -f "$JSON"
if curl -s "http://$PLATFORM/platform-ctrl/v1/sandboxes" | grep -q "\"name\":\"$SANDBOX\""; then
  if [ "${REACTIVATE:-0}" = "1" ]; then
    CTRL="$(kubectl -n "$SANDBOX" get svc meep-sandbox-ctrl -o jsonpath='{.spec.clusterIP}')"
    curl -s -o /dev/null -w "terminate %{http_code}\n" -X DELETE "http://$CTRL/sandbox-ctrl/v1/active"
    for _ in $(seq 1 60); do
      [ -z "$(kubectl -n "$SANDBOX" get pods --no-headers 2>/dev/null | grep -E '^mep|^pb-ipe' || true)" ] && break
      sleep 3
    done
    curl -s -o /dev/null -w "activate %{http_code}\n" -X POST "http://$CTRL/sandbox-ctrl/v1/active/$SCENARIO"
  else
    echo "sandbox $SANDBOX exists (set REACTIVATE=1 to redeploy the scenario)"
  fi
else
  curl -sf -X POST -H 'Content-Type: application/json' -d "{\"scenarioName\":\"$SCENARIO\"}" "http://$PLATFORM/platform-ctrl/v1/sandboxes/$SANDBOX" && echo " sandbox $SANDBOX created"
fi
