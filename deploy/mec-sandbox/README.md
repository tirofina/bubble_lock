# Local ETSI MEC Sandbox for Privacy Bubble Keyring

This folder records how the project runs the ETSI MEC Sandbox (STF_685 branch)
on a local VM next to the oneM2M Mobius4 CSE, so that the oneM2M MEC IPE
(`pc-mobius/integration/src/mec-ipe.mjs`) consumes real MEC services instead of
the local simulator. It follows the local-installation path described for
oneM2M-MEC interworking (oneM2M TR-0086, Annex B; cited by number only).

## Topology

| Host | Role | Address |
|---|---|---|
| Development PC (Windows 11) | Mobius4 4.24.5 CSE, PostgreSQL 17 + PostGIS, MEC IPE (oneM2M AE), policy and handover consumers | 192.168.0.106 (LAN) |
| VM `mec-sandbox` (VirtualBox, Ubuntu 22.04.5, 6 vCPU, 16 GiB, 120 GB, bridged LAN) | Single-node Kubernetes v1.35.1 (kubeadm, Calico pod pool 10.244.0.0/16, Helm 3.22.1) running the ETSI MEC Sandbox | 192.168.0.103 |

Sandbox `bubble` runs scenario `dep-opt-b`: four zones, each with one MEP
(`mep1`..`mep4`) hosting MEC011, MEC012 (RNIS), MEC013 (Location), MEC021,
MEC033, MEC040, MEC046 and the official `meep-ipe`, plus 16 UEs on 4G/5G POAs.
The scenario matches the project's deployment option B (oneM2M and MEC on
separate edge nodes).

Endpoints used by the IPE (MEP `mep1` shown):

| Service | Path |
|---|---|
| MEC011 service management | `https://192.168.0.103/bubble/mep1/mec_service_mgmt/v1/services` |
| MEC011 app support | `https://192.168.0.103/bubble/mep1/mec_app_support/v2` |
| MEC013 Location | `https://192.168.0.103/bubble/mep1/location/v3` (v2 is not served) |
| MEC012 RNIS | `https://192.168.0.103/bubble/mep1/rni/v2` |
| Scenario control | `https://192.168.0.103/bubble/sandbox-ctrl/v1` |

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
   `https://192.168.0.103/platform-ctrl/v1/authorize`. Its client ID and secret
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
| 8 | Ingress TLS | cert-manager `ClusterIssuer bubble-local-ca` (local CA) and `Certificate meep-ingress-local` with `ipAddresses: [192.168.0.103]`, written to the secret `meep-ingress` used by `--default-ssl-certificate`; annotation `cert-manager.io/cluster-issuer` removed from `Ingress meep-ingress-certs` (original saved as `~/meep-ingress-certs.ingress.orig.yaml`) | Let's Encrypt cannot issue for a private IP, so the ingress served the controller's "Fake Certificate" (SAN `ingress.local`) and strict clients failed |
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
| Callback path from a sandbox pod to the PC (`busybox wget` to `http://192.168.0.106:18090`) | Delivered; source address 192.168.0.103 (node SNAT). Windows Firewall already allows `node.exe` inbound |
| IPE run against the sandbox (`npm --prefix pc-mobius run integration:mec-ipe-sandbox`) | 33/33 checks PASS. The IPE registered as a USER app instance (`confirm_ready` 204) and as MEC011 service `pb-onem2m-ipe`; 3 oneM2M request cin created Location periodic, Location user-event and RNIS cell-change subscriptions; 19 real sandbox notifications became oneM2M cin; zone entry triggered handover edge-a to edge-b; 2 renewals per subscription; DELETE 204 for all three. Details: `docs/rubric-work/R15-R16.md`, receipt `docs/verification-evidence/2026-11-20/mec-ipe-sandbox.json` |

## Operating notes

- SSH to the VM uses a dedicated key pair and a pinned `known_hosts` entry
  kept outside the repository. VirtualBox guest control does not work on this
  VM; use SSH.
- After changing backend secrets, apply them with
  `python3 config/configure-secrets.py set config/secrets.yaml` and restart
  `meep-auth-svc`.
- The VM does not use the PC's PostgreSQL port 55432.
- oneM2M TR-0077 and TR-0086 are referenced by document number only.
