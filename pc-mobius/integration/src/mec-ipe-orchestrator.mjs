import { approvalHash } from './integration-utils.mjs';
import { classifyMecService } from './mec-platform-client.mjs';
import { IPE_OWNERSHIP_SCHEMA } from './mec-ipe-relocatable.mjs';

/**
 * Orchestrator for the oneM2M MEC IPE as a MEC application (ETSI MEC Sandbox, STF_685).
 * - Topology and host eligibility from the active scenario (sandbox-ctrl) and live MEC011 catalogs.
 * - Placement and removal of IPE instances through sandbox-ctrl SCENARIO-UPDATE events (ADD/REMOVE of an
 *   EDGE-APP process on an EDGE node); the sandbox virt-engine deploys or deletes the pod and the app
 *   store issues MEC011 AppTermination for a graceful removal.
 * - Ownership: epoch-numbered cin records in <IPE AE>/ownership (see RelocatableMecIpe).
 * Every decision is returned as an explicit record (inputs, candidates, rule, selected host).
 */
export const MEC_API_BY_IMAGE = { 'meep-app-enablement': 'MEC011', 'meep-rnis': 'MEC012', 'meep-loc-serv': 'MEC013', 'meep-ams': 'MEC021', 'meep-wais': 'MEC028' };
const envMap = (value) => Object.fromEntries(String(value ?? '').split(',').map((item) => item.split('=')).filter(([key, val]) => key && val !== undefined).map(([key, val]) => [key.trim(), val.trim()]));
const imageName = (image) => String(image ?? '').slice(String(image ?? '').lastIndexOf('/') + 1);

/** Hosts (EDGE nodes), zones, POAs and IPE processes of an active scenario. */
export function scenarioTopology(active, { ipeImage = 'pb-onem2m-ipe' } = {}) {
  const hosts = []; const poas = {}; const zones = {}; const ipeProcesses = []; let amsCoverage = null;
  for (const domain of active?.deployment?.domains ?? []) for (const zone of domain.zones ?? []) {
    if (zone.type !== 'ZONE') continue;
    zones[zone.name] = { name: zone.name, poas: [] };
    for (const nl of zone.networkLocations ?? []) {
      if (nl.type?.startsWith('POA')) {
        const [lon, lat] = nl.geoData?.location?.coordinates ?? [];
        poas[nl.name] = { name: nl.name, type: nl.type, zone: zone.name, cellId: nl.poa4GConfig?.cellId ?? nl.poa5GConfig?.cellId ?? null, macId: nl.poaWifiConfig?.macId ?? null, lon, lat, radiusM: nl.geoData?.radius ?? null };
        zones[zone.name].poas.push(nl.name);
      }
      for (const pl of nl.physicalLocations ?? []) {
        if (pl.type !== 'EDGE') continue;
        const host = { mep: pl.name, zone: zone.name, edge: pl.meta?.['pb.edge'] ?? null, capacity: { cpu: Number(pl.meta?.['pb.capacity.cpu'] ?? NaN), memoryMi: Number(pl.meta?.['pb.capacity.memoryMi'] ?? NaN) }, mecApis: [], locality: {}, userApps: [] };
        for (const proc of pl.processes ?? []) {
          const image = imageName(proc.image); const env = envMap(proc.environment);
          const api = MEC_API_BY_IMAGE[image];
          if (api) {
            host.mecApis.push(api);
            if (env.MEEP_LOCALITY) host.locality[api] = env.MEEP_LOCALITY.split(':').filter(Boolean);
            if (api === 'MEC021' && env.MEEP_MEP_COVERAGE) amsCoverage = Object.fromEntries(env.MEEP_MEP_COVERAGE.split('/').flatMap((entry) => { const [mep, ...covered] = entry.split(':'); return covered.map((name) => [name, mep]); }));
            continue;
          }
          const app = { name: proc.name, id: proc.id, image, mep: pl.name, cpu: Number(proc.cpuConfig?.min ?? 0), memoryMi: Number(proc.memoryConfig?.min ?? 0), nodePort: proc.serviceConfig?.ports?.[0]?.externalPort ?? null, meSvcName: proc.serviceConfig?.meSvcName ?? null };
          host.userApps.push(app);
          if (image === ipeImage) ipeProcesses.push({ ...app, process: proc });
        }
        hosts.push(host);
      }
    }
  }
  return { scenario: active?.name ?? null, hosts, zones, poas, amsCoverage: amsCoverage ?? {}, ipeProcesses };
}

/**
 * Host eligibility for serving a UE in `zone`: the host's MEC013/MEC012 locality covers the zone, the
 * required MEC APIs are declared and ACTIVE in its MEC011 catalog, its MEC011 answers, and its declared
 * capacity minus the user apps already placed covers the IPE request. The AMS coverage map breaks ties.
 */
export function evaluateEligibility(topology, { zone, probes = {}, request = { cpu: 0.1, memoryMi: 64 }, requiredApis = ['MEC011', 'MEC012', 'MEC013', 'MEC021'], exclude = [] } = {}) {
  const candidates = topology.hosts.map((host) => {
    const probe = probes[host.mep] ?? null;
    const covers = (api) => !host.locality[api] || host.locality[api].includes(zone);
    const servesZone = covers('MEC013') && covers('MEC012');
    const declared = requiredApis.every((api) => host.mecApis.includes(api));
    const live = probe ? requiredApis.filter((api) => api !== 'MEC021').every((api) => api === 'MEC011' ? probe.status === 200 : probe.activeApis?.includes(api)) : false;
    const placed = host.userApps.filter((app) => !exclude.includes(app.name));
    const used = { cpu: placed.reduce((sum, app) => sum + (app.cpu || 0), 0), memoryMi: placed.reduce((sum, app) => sum + (app.memoryMi || 0), 0) };
    const free = { cpu: Math.round((host.capacity.cpu - used.cpu) * 1000) / 1000, memoryMi: host.capacity.memoryMi - used.memoryMi };
    const capacityOk = Number.isFinite(free.cpu) && Number.isFinite(free.memoryMi) && free.cpu >= request.cpu && free.memoryMi >= request.memoryMi;
    const amsPreferred = topology.amsCoverage[zone] === host.mep;
    const reasons = [];
    if (!servesZone) reasons.push(`locality ${JSON.stringify(host.locality.MEC013 ?? [])} excludes ${zone}`);
    if (!declared) reasons.push(`missing MEC APIs ${requiredApis.filter((api) => !host.mecApis.includes(api)).join(' ')}`);
    if (!live) reasons.push(probe ? `MEC011 catalog not ready (status ${probe.status})` : 'no MEC011 probe');
    if (!capacityOk) reasons.push(`capacity free cpu ${free.cpu} memoryMi ${free.memoryMi} below request`);
    return { mep: host.mep, edge: host.edge, hostZone: host.zone, servesZone, amsPreferred, mecApis: host.mecApis, liveApis: probe?.activeApis ?? [], mec011Status: probe?.status ?? null, probeMs: probe?.ms ?? null, capacity: host.capacity, used, free, capacityOk, eligible: servesZone && declared && live && capacityOk, reasons };
  });
  const eligible = candidates.filter((item) => item.eligible).sort((a, b) => Number(b.amsPreferred) - Number(a.amsPreferred) || b.free.cpu - a.free.cpu);
  return { zone, request, requiredApis, rule: 'eligible = MEC013/MEC012 locality covers zone AND required MEC APIs declared AND MEC011 catalog ACTIVE AND free capacity >= request; order: MEC021 AMS coverage first, then most free CPU', candidates, selected: eligible[0]?.mep ?? null };
}

export class MecIpeOrchestrator {
  constructor({ sandbox, client, ipeAePath, request = { cpu: 0.1, memoryMi: 64 }, template = null, clock = () => Date.now(), trace = () => {} } = {}) {
    if (!sandbox || !client || !ipeAePath) throw new Error('MecIpeOrchestrator needs sandbox, client and ipeAePath');
    Object.assign(this, { sandbox, client, ipeAePath, request, template, clock, traceSink: trace });
    this.epoch = 0; this.decisions = []; this.topology = null;
  }
  trace(step, details = {}) { const entry = { at: new Date(this.clock()).toISOString(), actor: 'orchestrator', step, ...details }; this.traceSink(entry); return entry; }
  async refresh() {
    this.topology = scenarioTopology((await this.sandbox('GET', '/sandbox-ctrl/v1/active')).data);
    // The last IPE process seen stays the template, so a host can be re-populated after every instance left.
    if (this.topology.ipeProcesses.length) this.template = this.topology.ipeProcesses[0].process;
    return this.topology;
  }
  /** Live MEC011 catalog of one MEP (service management API on that host). */
  async probe(mep) {
    const started = this.clock();
    try {
      const response = await this.sandbox('GET', `/${mep}/mec_service_mgmt/v1/services`, undefined, [200]);
      const services = (Array.isArray(response.data) ? response.data : []).map((entry) => classifyMecService(entry));
      return { status: response.status, ms: this.clock() - started, activeApis: [...new Set(services.filter((item) => item.state === 'ACTIVE').map((item) => item.mecApi))].sort(), ipeInstances: services.filter((item) => item.serName === 'pb-onem2m-ipe').length };
    } catch (error) { return { status: error.status ?? null, ms: this.clock() - started, activeApis: [], reason: error.message }; }
  }
  async probeAll() { const probes = {}; for (const host of this.topology.hosts) probes[host.mep] = await this.probe(host.mep); return probes; }
  /** Where a UE is now, from each host's MEC013 (each host only sees its locality). */
  async locateUe(address) {
    const sightings = [];
    for (const host of this.topology.hosts) {
      try {
        const response = await this.sandbox('GET', `/${host.mep}/location/v3/queries/users?address=${encodeURIComponent(address)}`, undefined, [200, 404]);
        const user = response.data?.userList?.user?.[0];
        if (user) sightings.push({ mep: host.mep, zoneId: user.zoneId ?? null, accessPointId: user.accessPointId ?? null });
      } catch { /* host not reachable */ }
    }
    return { ueRef: approvalHash(address).slice(0, 16), sightings, zoneId: sightings[0]?.zoneId ?? null, accessPointId: sightings[0]?.accessPointId ?? null };
  }
  async decide({ kind, zone, trigger, ue = null, exclude = [] }) {
    const startedAt = this.clock();
    await this.refresh();
    const probes = await this.probeAll();
    const evaluation = evaluateEligibility(this.topology, { zone, probes, request: this.request, exclude });
    const record = { decisionId: `dec-${this.decisions.length + 1}-${approvalHash({ kind, zone, startedAt }).slice(0, 8)}`, kind, at: new Date(startedAt).toISOString(), trigger, ue, ...evaluation, instances: this.topology.ipeProcesses.map(({ name, id, mep, nodePort }) => ({ name, id, mep, nodePort })), evaluationMs: this.clock() - startedAt };
    this.decisions.push(record);
    this.trace('ORCHESTRATION_DECISION', { decisionId: record.decisionId, kind, zone, selected: record.selected, eligible: record.candidates.filter((item) => item.eligible).map((item) => item.mep), evaluationMs: record.evaluationMs });
    return record;
  }
  instanceOn(mep) { return this.topology?.ipeProcesses.find((item) => item.mep === mep) ?? null; }
  instanceById(id) { return this.topology?.ipeProcesses.find((item) => item.id === id) ?? null; }

  /** IPE process for `mep`, derived from the declared instance (environment, ports, resources). */
  processFor(mep, { id, name = `pb-ipe-${mep}`, nodePort }) {
    const template = this.topology?.ipeProcesses[0]?.process ?? this.template;
    if (!template) throw new Error('no IPE process in the active scenario or declared template');
    const env = envMap(template.environment);
    const publicUrl = (env.MEC_CALLBACK_PUBLIC_URL ?? '').replace(/:\d+$/, `:${nodePort}`);
    Object.assign(env, { PB_IPE_MEP: mep, MEC_MEP: mep, MEC_APP_INSTANCE_ID: id, MEC_CALLBACK_PUBLIC_URL: publicUrl, MEC_IPE_ONEM2M_URL: publicUrl });
    const process = structuredClone(template);
    Object.assign(process, { id, name, environment: Object.entries(env).map(([key, value]) => `${key}=${value}`).join(',') });
    process.serviceConfig = { ...process.serviceConfig, name, ports: (process.serviceConfig?.ports ?? []).map((port) => ({ ...port, externalPort: nodePort })) };
    return process;
  }
  async place(mep, options) {
    const process = this.processFor(mep, options);
    const startedAt = this.clock();
    const response = await this.sandbox('POST', '/sandbox-ctrl/v1/events/SCENARIO-UPDATE', { name: `pb-ipe-add-${mep}`, type: 'SCENARIO-UPDATE', eventScenarioUpdate: { action: 'ADD', node: { type: 'EDGE-APP', parent: mep, nodeDataUnion: { process } } } }, [200]);
    this.trace('IPE_INSTANCE_ADD', { mep, name: process.name, appInstanceId: process.id, nodePort: options.nodePort, httpStatus: response.status });
    return { mep, name: process.name, id: process.id, nodePort: options.nodePort, httpStatus: response.status, requestedAt: new Date(startedAt).toISOString() };
  }
  async remove(name, { gracePeriod = 20 } = {}) {
    const response = await this.sandbox('POST', '/sandbox-ctrl/v1/events/SCENARIO-UPDATE', { name: `pb-ipe-remove-${name}`, type: 'SCENARIO-UPDATE', eventScenarioUpdate: { action: 'REMOVE', node: { type: 'EDGE-APP', nodeDataUnion: { process: { name } } }, gracePeriod } }, [200]);
    this.trace('IPE_INSTANCE_REMOVE', { name, gracePeriod, httpStatus: response.status });
    return { name, gracePeriod, httpStatus: response.status, requestedAt: new Date(this.clock()).toISOString() };
  }
  async writeOwnership({ owner, mep, decisionId, reason }) {
    const epoch = this.epoch + 1;
    const con = { schema: IPE_OWNERSHIP_SCHEMA, epoch, owner, mep, decisionId, reason, at: new Date(this.clock()).toISOString() };
    const result = await this.client.create(`${this.ipeAePath}/ownership`, 4, { 'm2m:cin': { cnf: 'application/json', con, lbl: ['pb:mec-ipe-ownership', `pb:epoch:${epoch}`], cr: null } });
    if (result.rsc !== 2001) throw Object.assign(new Error(`ownership write ${result.rsc}`), { code: 'OWNERSHIP_WRITE_REVIEW', rsc: result.rsc });
    this.epoch = epoch;
    this.trace('IPE_OWNERSHIP_WRITTEN', { epoch, owner, mep, decisionId, cinRi: result.payload?.['m2m:cin']?.ri ?? null });
    return { epoch, cinRi: result.payload?.['m2m:cin']?.ri ?? null, at: con.at };
  }
}
