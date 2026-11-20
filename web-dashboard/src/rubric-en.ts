/**
 * English text for the requirement rows on the Build status page. docs/rubric-audit.json keeps the Korean design
 * notes as the source of record; the page shows these English versions unless the Korean language option is on.
 */
export const rubricDesignEn: Readonly<Record<string, string>> = {
  R01: 'Group/fanOutPoint sends one command to both lights and handles failures per member, combined with subscriptions, ACP and expiry.',
  R02: 'Uses keyring BLE, relay-to-CSE oneM2M MQTT and app-to-CSE HTTPS for real, and checks MQTT originator mapping and reconnection.',
  R03: 'Connects the guardian, visitor and operator apps with keyrings, relays and appliances, running discovery, incidents, group control and revocation as one scenario.',
  R04: 'A Hackster article, in reproducible order, on circuits, deployment, resources, protocols, measurements, failures and what adopting oneM2M changed.',
  R05: 'A 4 min 40 s main video that separates real devices from the simulated network and shows incidents, revocation, handover, learning and MCP results. Detailed logs go in an appendix.',
  R06: 'Install, seed resources, test and demo from a fresh environment, with versions, dependencies, source layout, sample settings, license and article link.',
  R07: 'Real examples, with measurements and code, of Group, SDT, subscriptions and ACP removing duplicated app logic, shown in the docs, video and repository.',
  R08: 'Reproduce real Group partial failure, SDT mapping and MEC subscription revocation issues and post questions, results and contributions on the public forum. A draft alone does not count.',
  R09: 'Each owner explains resources, communication, permissions and the MEC flow, and answers random device swap, expiry and failure questions with code and logs.',
  R10: 'Combines HTTPS/MQTTS, identity mapping, per-role ACP and server-side lease and capability checks, and tests direct bypass, forgery, replay, queue delay and revocation after handover.',
  R11: 'Applies standard SDT modules such as binarySwitch and typed schemas, and proves reuse with a second client that reads only the public schemas and with a device swap.',
  R12: 'Reconnects between two distinct CSEs on location and availability, mapping logical IDs to per-CSE AE-IDs with epoch fencing, resource, subscription and group rebuild and duplicate suppression.',
  R13: 'Links the home and outing zone topology and Edge A/B placement rules to a real deployment controller, recording container placement, registration, health checks, relocation and rollback.',
  R14: 'A coordinator on the ESTIMED VM runs three initial clients and one late joiner through oneM2M resources, checking 10 rounds, dropout, rejoin and model versions.',
  R15: 'Separates BLE relay sightings and MEC device location by source, subject, error and time, and lets zone changes trigger approved incident, placement and handover decisions.',
  R16: 'Discovers Location and RNIS over Mp1, creates, updates and deletes subscriptions from oneM2M requests, and returns MEC callback resource and policy changes to the app.',
  R17: 'Combines three MCP servers (oneM2M, MEC requests, audit) and resumes discovery, permission checks, planning, guardian approval, server enforcement and result checks from durable state.',
};

export const rubricStatusEn: Readonly<Record<string, string>> = {
  '부분 구현·실증/공개 증거 연결 단계': 'Partly implemented, linking field and public evidence',
};
