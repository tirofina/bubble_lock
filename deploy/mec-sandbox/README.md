# Local ETSI MEC Sandbox for Privacy Bubble Keyring

This folder records how the project runs the ETSI MEC Sandbox (STF_685 branch)
on a local VM next to the oneM2M Mobius4 CSE, so that the oneM2M MEC IPE
(`pc-mobius/integration/src/mec-ipe.mjs`) consumes real MEC services instead of
the local simulator. It follows the local-installation path described for
oneM2M-MEC interworking (oneM2M TR-0086, Annex B; cited by number only).

## Topology

| Host | Role | Address |
|---|---|---|
| Development PC (Windows 11) | Mobius4 4.24.5 CSE, PostgreSQL 17 + PostGIS, MEC IPE (oneM2M AE), policy and handover consumers | <PC_IP> (LAN) |
| VM `mec-sandbox` (VirtualBox, Ubuntu 22.04.5, 6 vCPU, 16 GiB, 120 GB, bridged LAN) | Single-node Kubernetes v1.35.1 (kubeadm, Calico pod pool 10.244.0.0/16, Helm 3.22.1) running the ETSI MEC Sandbox | <VM_IP> |

Sandbox `bubble` runs scenario `dep-opt-b`: four zones, each with one MEP
(`mep1`..`mep4`) hosting MEC011, MEC012 (RNIS), MEC013 (Location), MEC021,
MEC033, MEC040, MEC046 and the official `meep-ipe`, plus 16 UEs on 4G/5G POAs.
The scenario matches the project's deployment option B (oneM2M and MEC on
separate edge nodes).

Endpoints used by the IPE (MEP `mep1` shown):

| Service | Path |
|---|---|
| MEC011 service management | `https://<VM_IP>/bubble/mep1/mec_service_mgmt/v1/services` |
| MEC011 app support | `https://<VM_IP>/bubble/mep1/mec_app_support/v2` |
| MEC013 Location | `https://<VM_IP>/bubble/mep1/location/v3` (v2 is not served) |
| MEC012 RNIS | `https://<VM_IP>/bubble/mep1/rni/v2` |
| Scenario control | `https://<VM_IP>/bubble/sandbox-ctrl/v1` |

## Sources

| Repository | Branch | Commit |
|---|---|---|
| `https://labs.etsi.org/rep/mec/etsi-mec-sandbox` | STF_685 | `8c66f08` |
| `https://labs.etsi.org/rep/mec/etsi-mec-sandbox-frontend` | STF_685 | `df11a72` |

Both were cloned with `--depth 1` into the VM user's home.

## Install steps

1. Create the VM with VirtualBox unattended install (Ubuntu 22.04.5 server).
   The VirtualBox template ran `usermod -G vboxsf` before the user existed, so
   the installer reported a failure at the end; the target disk was complete
   and a manual reboot finished the install.
2. Bootstrap: clone both repositories, write a Calico custom-resources
   manifest with pod pool `10.244.0.0/16`, create the Ansible virtualenv.
3. Ansible pass 1 (`install_mec_sandbox: false`): base packages, containerd,
   Docker, kubeadm, Calico, Helm, Go, Node. Result: ok=73, failed=0; node Ready.
4. Create a GitHub OAuth app for the sandbox UI with redirect URI
   `https://<VM_IP>/platform-ctrl/v1/authorize`. Its client ID and secret
   live only in the VM's `config/secrets.yaml` files (mode 600) and in a local
   credentials file outside the repository.
5. Ansible pass 2 (`install_mec_sandbox: true`): MEC configuration, `meepctl`
   install, frontend build and deploy, dependency charts, build, dockerize,
   core deploy, scenario import.
6. Finish the deploy by hand (see fixes 5 to 7 below): `meepctl dockerize all`
   without `sg docker`, then `meepctl deploy core all`, then import the network
   scenarios to platform-ctrl. Result: 30 images in the local registry, all
   core pods Running, 12 scenarios imported.
7. Replace the ingress certificate (fix 8) and create the sandbox (fix 9).

## Local fixes to upstream files

| # | File or object | Change | Reason |
|---|---|---|---|
| 1 | `deploy/ansible/roles/helm/tasks/main.yml` | snap channel `3.7/stable` to `3/stable` | The `3.7/stable` channel no longer exists |
| 2 | `deploy/ansible/inventories/dev/hosts.ini` | `ansible_user` set to the VM user | Inventory default user differs |
| 3 | VM `/etc/apt/sources.list` | security mirror switched to a regional archive (backup `.bak`) | `security.ubuntu.com` timed out from this network |
| 4 | Backend `config/secrets.yaml` | GitHub OAuth values written directly | The config role writes only the frontend secrets file, while the deploy role applies the backend one |
| 5 | `go-apps/meepctl/install.sh` line 43 | `golangci-lint run \|\| echo "lint skipped ..."` (original kept as `install.sh.orig`) | golangci-lint v1.46.0 panics under Go 1.25 (`load embedded ruleguard rules: can't load fmt`); later builds already use `--nolint` |
| 6 | Backend `.meepctl-repocfg.yaml` | `meep-edgeapp` set to `build/dockerize/deploy: false` and its chart removed from the virt-engine data list (backup `.meepctl-repocfg.yaml.bak-edgeapp`) | Frontend commit `df11a72` adds `meep-edgeapp` to the repo config, but backend commit `8c66f08` has no `go-apps/meep-edgeapp` or chart, so `dockerize all` stopped there. Location and RNIS do not need it; scenario `edgeapp-dual-mep` is the only one that fails to import |
| 7 | Playbook task "Dockerize all" | run `meepctl dockerize all` directly as the VM user | The task wraps the command in `sg docker -c`, which changes the effective GID to `docker` (997); `meepctl` then rejects the configured GID 1000 (`repo.deployment.permissions.gid mismatch`) |
| 8 | Ingress TLS | cert-manager `ClusterIssuer bubble-local-ca` (local CA) and `Certificate meep-ingress-local` with `ipAddresses: [<VM_IP>]`, written to the secret `meep-ingress` used by `--default-ssl-certificate`; annotation `cert-manager.io/cluster-issuer` removed from `Ingress meep-ingress-certs` (original saved as `~/meep-ingress-certs.ingress.orig.yaml`) | Let's Encrypt cannot issue for a private IP, so the ingress served the controller's "Fake Certificate" (SAN `ingress.local`) and strict clients failed |
| 9 | Sandbox creation | `POST /platform-ctrl/v1/sandboxes/bubble` with `{"scenarioName":"dep-opt-b"}` sent to the platform-ctrl ClusterIP from inside the VM | Creating a sandbox through the ingress requires an admin session; the VM-internal call is the same path the playbook uses for scenario import |

Two sandbox service fixes were needed for the IPE run and are applied only to
this local install (rebuilt and restarted on the VM). The diffs are in
`docs/verification-evidence/2026-11-20/mec-sandbox-patches/`:

| # | Service | Problem seen | Local fix |
|---|---|---|---|
| 10 | `meep-rnis` | The first subscription that reaches its expiry time crashes the service (nil pointer) and all RNIS state is lost; a PUT renewal keeps the old expiry entry, so renewed subscriptions are still deleted at the original time | Skip expiry entries older than the subscription's current `expiryDeadline` and guard the nil path (`meep-rnis-expiry-fix.diff`) |
| 11 | `meep-loc-serv` | User-event notifications carry the `_links` of an unrelated subscription | Use the notified subscription's own link (`meep-loc-serv-link-fix.diff`) |

Because of the restarts the MEC011 catalogue lists RNIS three times and
Location twice; the IPE publishes each catalogue entry as its own flexContainer.

The CA certificate is kept at `.local/mec-sandbox/ca.pem` on the PC
(gitignored) and passed to the IPE as `MEC_CA_FILE`; its private key stays in
`.local/mec-sandbox/` and in the VM secret `bubble-local-ca`.

Rollback of fix 8:

```bash
kubectl delete certificate meep-ingress-local
kubectl apply -f ~/meep-ingress-certs.ingress.orig.yaml
kubectl delete clusterissuer bubble-local-ca
kubectl delete secret bubble-local-ca meep-ingress
```

## Verification

| Check | Result |
|---|---|
| Ansible pass 1 | ok=73, failed=0 |
| Ansible pass 2 | ok=109, failed=0, ignored=3: the UID and GID updates of `.meepctl-repocfg.yaml`, and the scenario import, which ran before platform-ctrl had images. The dockerize GID error (fix 7) printed an error inside a task that still returned success |
| Images in local registry after fix 7 | 30 |
| Pods | All system and core pods Running; sandbox `bubble` 37 pods Running |
| MEC011 service list through ingress | HTTP 200 |
| MEC013 Location v3 `queries/users` | HTTP 200 (v2 path returns 404) |
| MEC012 RNIS v2 `queries/rab_info` | HTTP 200 |
| Strict TLS from the PC with the pinned CA (`createMecFetch({ caFile })`) | 200 on all three paths; without the CA Node rejects the certificate (`UNABLE_TO_VERIFY_LEAF_SIGNATURE`) |
| Callback path from a sandbox pod to the PC (`busybox wget` to `http://<PC_IP>:18090`) | Delivered; source address <VM_IP> (node SNAT). Windows Firewall already allows `node.exe` inbound |
| Day-of-care relocation run (`npm --prefix pc-mobius run integration:mec-day-of-care`, sandbox `dayofcare`) | 25/25 checks PASS; IPE relocated mep1 to mep2 on a MEC021 `INTERHOST_MOVEOUT_TRIGGERED`; receipt `docs/verification-evidence/2026-11-20/mec-day-of-care.json` (see the day-of-care section below) |
| IPE run against the sandbox (`npm --prefix pc-mobius run integration:mec-ipe-sandbox`) | 33/33 checks PASS. The IPE registered as a USER app instance (`confirm_ready` 204) and as MEC011 service `pb-onem2m-ipe`; 3 oneM2M request cin created Location periodic, Location user-event and RNIS cell-change subscriptions; 19 real sandbox notifications became oneM2M cin; zone entry triggered handover edge-a to edge-b; 2 renewals per subscription; DELETE 204 for all three. Details: `docs/rubric-work/R15-R16.md`, receipt `docs/verification-evidence/2026-11-20/mec-ipe-sandbox.json` |

## Day-of-care scenario and the IPE as a MEC application (R13)

A second sandbox, `dayofcare`, runs the project scenario
`scenarios/day-of-care.yaml` (scenario name `day-of-care`). It models one
afternoon of an elderly resident who lives alone in Les Moneghetti, Monaco,
with real OpenStreetMap coordinates (lon, lat):

| Place | Location | Coordinates |
|---|---|---|
| Home | residential block on upper Boulevard de Belgique, Les Moneghetti | 7.417915, 43.736945 |
| Walk | Boulevard de Belgique down to the park's east gate (Chemin des Revoires) | gate 7.416042, 43.733948 |
| Park | Parc Princesse Antoinette (OSM way 221351810) | centre 7.414608, 43.733407 |
| Trail fork | main footway (OSM way 939530791) meets the east branch (OSM way 688744018) | 7.415336, 43.733392 |
| Bench | south bench group (OSM nodes 6459866593 to 6459866598) | 7.414478, 43.732648 |
| Office | Fontvieille, near Avenue Albert II | 7.417963, 43.730843 |

Topology (operator domain `monaco-operator`, MCC/MNC 001/001):

| Zone | MEP | MEC013/MEC012 locality | POAs (cell id, radius) |
|---|---|---|---|
| `home-district` | `mep1` (Edge-A), capacity 1.0 CPU / 1024 MiB | home-district | `home-wifi` (Wi-Fi, 40 m), `moneghetti-5g-small` (1A0000001, 140 m), `moneghetti-4g-macro` (1A00001, 600 m, covers the walk route) |
| `park-district` | `mep2` (Edge-B), capacity 0.5 CPU / 512 MiB | park-district, office-district | `park-5g-entrance` (2B0000001, 80 m), `park-5g-fork` (2B0000002, 80 m), `park-5g-bench` (2B0000003, 80 m) |
| `office-district` | none (MEC021 maps it to mep2) | served by mep2 | `fontvieille-5g-office` (3C0000001, 90 m), `fontvieille-4g-macro` (3C00001, 450 m) |

Each MEP runs only MEC011, MEC012, MEC013 and MEC021 (lean for the shared VM).
MEC021 uses `MEEP_MEP_COVERAGE=mep1:home-district/mep2:park-district:office-district`.
UEs: `resident-relay` (the phone the resident carries; the keyring talks BLE to
it, so it is her network location; path home, Boulevard de Belgique, park gate,
trail, fork, bench at 0.9 m/s), `caregiver` (street to the front door, 1.3 m/s)
and `guardian` (office to the bench, 4 m/s). Scenario automations stay off;
the run script moves UEs through the GIS API with MOBILITY automation on.

Import and sandbox creation (VM-internal platform-ctrl ClusterIP path, same as
fix 9):

```bash
scp deploy/mec-sandbox/scenarios/day-of-care.yaml mec@<VM_IP>:~/day-of-care.yaml
ssh mec@<VM_IP> 'bash -s' < deploy/mec-sandbox/import-day-of-care.sh
# after a yaml change: ssh mec@<VM_IP> 'REACTIVATE=1 bash -s' < deploy/mec-sandbox/import-day-of-care.sh
```

### oneM2M MEC IPE image and placement

`ipe/Dockerfile` packages the IPE (`pc-mobius/integration/src/mec-ipe*.mjs`)
with the entry point `pc-mobius/scripts/run-mec-ipe-pod.mjs` on
`node:22-alpine`. `ipe/publish-image.sh` (Git Bash on the PC) assembles the
build context in `.local/mec-sandbox/ipe-build` (it holds the lab CA
certificate, public part only), builds on the VM and pushes
`meep-docker-registry:30001/pb-onem2m-ipe`.

- The scenario declares `pb-ipe-mep1` as an `EDGE-APP` process on `mep1`
  (fixed app instance id, `serviceConfig` NodePort 31881, `meSvcName:
  pb-onem2m-ipe`, CPU 0.1 to 0.5, memory 64 to 256 MiB). The virt-engine
  deploys it as a pod; the sandbox app store lists it as an app instance on
  `mep1`, so MEC011 `confirm_ready` and MEC021 accept its id.
- The orchestrator adds `pb-ipe-mep2` (NodePort 31882) with a sandbox-ctrl
  `SCENARIO-UPDATE` event (`ADD`, parent `mep2`) and removes an instance with
  `REMOVE` plus `gracePeriod`; the app store then sends the MEC011
  AppTermination notification and the IPE answers with `confirm_termination`.
  The same `meSvcName` makes both instances adjacent app instances for MEC021.
- `virt-engine` splits the process `environment` string on `,` and `=`; values
  therefore hold neither (the pod also accepts `;` as a list separator).
- oneM2M side: the PC Mobius4 (`/pb-cse`) listens with HTTPS on
  `<PC_IP>:17599` (server certificate from the same lab CA,
  `.local/mec-sandbox/pc-cse-server.*`) and on loopback HTTP for the PC AEs.
  Pods reach it through node SNAT; Mobius4 reaches each pod through its
  NodePort (`http://<VM_IP>:3188x`). MEC callbacks from the sandbox
  services use the same NodePort URL.
- MEC side inside the pod: the ingress `https://<VM_IP>/dayofcare/<mep>`
  with the pinned lab CA, as on the PC (`MEC_*` settings of
  `mec-platform-client.mjs`).
- A pod waits for the CSE, and exits for a restart when its AE disappears or
  the CSE stays unreachable for 30 s, so each run starts from fresh state. On
  start it removes MEC011 services and MEC021 registrations left by an earlier
  container with the same app instance id.

`kubectl logs -f` fails on this VM (`failed to create fsnotify watcher: too
many open files`); the run script polls `kubectl logs` over SSH instead.

### Relocation run

`npm --prefix pc-mobius run integration:mec-day-of-care` (with
`MOBIUS4_ROOT`) replays the afternoon with story minutes compressed to
seconds and writes `docs/verification-evidence/2026-11-20/mec-day-of-care.json`
and `mec-day-of-care-trace.jsonl`. Sequence:

1. Declared placement check (`pb-ipe-mep1` only) and an eligibility record for
   the resident's zone (MEC013 sighting); ownership epoch 1 goes to the mep1
   instance as a cin in `/Mobius/pb-mec-ipe/ownership`.
2. The guardian app writes Location periodic, Location user-event and RNIS
   cell-change request cins; the mep1 instance creates the MEC013/MEC012
   subscriptions and writes observations under `/Mobius/resident-keyring`.
3. Caregiver visit: MEC013 on mep1 lists caregiver and resident on `home-wifi`.
4. Walk: each oneM2M observation from Edge-A makes the orchestrator read the
   serving access point from MEC013; the 4G macro borders park-district
   coverage, so it pre-places `pb-ipe-mep2` on the eligible host.
5. Zone entry: MEC021 sends `INTERHOST_MOVEOUT_TRIGGERED` with the mep2
   instance as target to the mep1 instance, which records it as a lifecycle
   cin; the orchestrator re-checks eligibility and writes ownership epoch 2.
   The mep1 instance deletes its MEC subscriptions and reports the context
   transfer to MEC021; the mep2 instance rebuilds the request set from the CSE
   and re-creates the subscriptions on its own MEP. Observations continue in
   the same oneM2M containers, each carrying `servedBy {mep, appInstanceId, epoch}`.
6. Fork stop at dusk; the orchestrator removes `pb-ipe-mep1` with a 30 s grace
   period (MEC011 AppTermination, `confirm_termination`).
7. Guardian approach; MEC013 on mep2 shows both UEs on `park-5g-bench`; a
   oneM2M geo-query over the park returns the resident's location container.
8. Unsubscribe, removal of `pb-ipe-mep2`, declared placement restored.

The run refuses to start (`SANDBOX_IN_USE`) when a UE it drives moves during a
6 s idle check, because other experiments share the `dayofcare` sandbox. With
`PB_UE_PREFIX=r13-` it adds run-time copies of the three UEs (`r13-resident`,
`r13-carer`, `r13-guardian`, same POA parents and radio settings) through
`SCENARIO-UPDATE` and removes them at the end, leaving the declared UEs to the
other experiment. Keep copy names at 12 characters or fewer: this GIS build
answers 400 (`duplicate key "ue_pkey"`, then `varchar(36)`) for a run-time UE
named `r13-resident-relay`; the script re-creates the geodata entry once on a
duplicate-key answer.

Result of the run on 2026-11-20 (UE copies, R17 was driving the declared UEs):
25/25 checks PASS. Pre-placement started at walk point 9 (attach to
`moneghetti-4g-macro`, 83 s before park-district at 0.9 m/s); the mep2 pod was
Ready 6.7 s after the `ADD`. MEC021 notified the zone entry once, 0.6 s after
the GIS update; decision 210 ms, epoch 2 written, mep2 resumed all three
requests 511 ms later, mep1 deleted its three subscriptions (204). The periodic
source gap at hand-over equals one measured period (4 s); 0 missed, 0
duplicate, 0 interleaved observations across 25 reports. MEC011 removal of the
mep1 instance: `confirm_termination` 204, node gone 0.9 s after `REMOVE`.
Receipt `docs/verification-evidence/2026-11-20/mec-day-of-care.json`, trace
`mec-day-of-care-trace.jsonl`; details in `docs/rubric-work/R13.md`.

## Connecting the IPE to the server CSE

The IPE pod can serve the team's server CSE (Mobius4 `/bubble-cse`, Docker compose project
`bubblelock-nocert` on the same VM) instead of a PC CSE. It reaches the CSE through the nginx
originator-binding route `https://<SERVER_DOMAIN>:8443/onem2m/Mobius` with mutual TLS; nginx sets
`X-M2M-Origin: Cpb-mec-ipe` and admits only `pb-mec-ipe(/...)`, AE registration and
`bubble-household-1/<x>/(location|rnis)(/...)`.

This section records the run on 2026-11-20, when the relay containers lived under the legacy AE
`bubble-household-1`. The team server now keeps them under the service AE as
`/Mobius/BubbleLock/resident-relay/{location,rnis}` with ACP `resident-relay-access`;
`provision-server-cse.sh` (`HOUSEHOLD_AE`) and `run-mec-ipe-server-cse.mjs` still default to
`bubble-household-1`.

| Step | Tool | Result |
|---|---|---|
| 1. Device containers and ACP | `ssh mec@<VM_IP> 'bash -s' < ipe/provision-server-cse.sh` (docker exec inside the cse container, admin originator from that container's environment) | `/Mobius/bubble-household-1/resident-relay` with `location` and `rnis`, all with ACP `resident-relay-mec-access`: `Cpb-mec-ipe` 7, `Cpb-dash-guardian` 50, `Cpb-dash-operator` 34. The household AE and its acpi stay as they are |
| 2. Image | `ipe/publish-image.sh` (`MEC_CA_PEM` overrides the lab CA path) | Only the public lab CA is baked in; the script refuses a build context that holds a private key |
| 3. Pod wiring | `ssh mec@<VM_IP> 'bash -s' < ipe/attach-server-cse.sh` | Secret `pb-ipe-server-cse` (client certificate, key, server trust bundle) created on the VM from the server deployment files; every `pb-ipe-mep*` deployment gets the secret volume, `hostAliases` `<SERVER_DOMAIN>` -> <VM_IP>, `ONEM2M_CSE_URL=https://<SERVER_DOMAIN>:8443/onem2m`, `ONEM2M_CSE_ID=/bubble-cse`, `ONEM2M_CA_FILE`, `ONEM2M_CLIENT_CERT_FILE`, `ONEM2M_CLIENT_KEY_FILE` and the requester, reader and orchestrator lists |
| 4. Ownership and requests | `npm --prefix pc-mobius run integration:mec-ipe-server-cse` | `Cpb-orchestrator` writes the ownership epoch, `Cguardian-app` writes Location and RNIS request cins with `deviceAe: bubble-household-1/resident-relay` |

Code: `createMecFetch` takes `cert`/`key` (or files) and `servername` (SNI, certificate name check and
Host); `onem2mCseConfig` reads `ONEM2M_CSE_URL` (path prefix allowed), `ONEM2M_CSE_BASE`, `ONEM2M_CSE_ID`,
`ONEM2M_CA_FILE`, `ONEM2M_CLIENT_CERT_FILE`, `ONEM2M_CLIENT_KEY_FILE` and `ONEM2M_SERVERNAME` (default: the
URL host). A request `deviceAe` is an AE name or `<ae>/<container>`. The pod retries a refused start every
15 s (`MEC_IPE_START_RETRY_MS`) instead of exiting.

The CSE sends notifications only to the origins in its `NOTIFICATION_ALLOWED_ORIGINS`
(`http://<VM_IP>:31881`, `:31882` and the PC listener `http://<PC_IP>:18096`); with an empty
list every subscription answers 4000 `notification target origin denied`.

Run on 2026-11-20 (receipt `docs/verification-evidence/2026-11-20/mec-ipe-server-cse.json`, status
PARTIAL, stopped during the walk on request): the IPE registered `/Mobius/pb-mec-ipe` (2001) through mTLS,
both request cins became MEC013 and MEC012 subscriptions on mep1 (201), 9 Location notifications became
cins under `/Mobius/bubble-household-1/resident-relay/location` (first cin `rijtgz1eax`), the
`Cpb-dash-guardian` subscription notified the PC listener, and each subscription was renewed once (PUT
200). The IPE pod and both MEC subscriptions stay active. The device-deletion watch on
`bubble-household-1/resident-relay` gets 403 from nginx, which the IPE records as `DEVICE_WATCH_REVIEW`.

The `pb-ipe-mep*` deployments are Helm releases of the virt-engine. A scenario re-activation or a
`SCENARIO-UPDATE ADD` (for example `pb-ipe-mep2` during R13 relocation) renders them from the scenario
yaml again, so `attach-server-cse.sh` is re-run afterwards (`ONLY=pb-ipe-mep2`). The scenario yaml keeps
the PC CSE defaults because the R13 runner starts its own CSE; the server CSE settings live in the attach
script.

## Operating notes

- Two sandboxes share the VM: `bubble` (dep-opt-b, 37 pods) and `dayofcare`
  (day-of-care, 4 core pods, 8 MEC service pods and the IPE pods). Load average
  stayed between about 10 and 25 on 6 vCPU during the runs; free memory stayed
  above 9 GiB.
- SSH to the VM uses a dedicated key pair and a pinned `known_hosts` entry
  kept outside the repository. VirtualBox guest control does not work on this
  VM; use SSH.
- After changing backend secrets, apply them with
  `python3 config/configure-secrets.py set config/secrets.yaml` and restart
  `meep-auth-svc`.
- The VM does not use the PC's PostgreSQL port 55432.
- oneM2M TR-0077 and TR-0086 are referenced by document number only.
