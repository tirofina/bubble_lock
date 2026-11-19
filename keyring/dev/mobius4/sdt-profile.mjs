// binarySwitch wire profiles for the keyring Mobius4 bench.
//
// Mobius4 binds one envelope key to each containerDefinition in config/specializations.json
// (cse/specialization.js expected_envelope_key), so one CSE accepts exactly one of the two
// representations below. A deployment selects its profile once, and the matching registry file is
// mounted into the CSE:
//   r4-common-1.0  canonical TS-0023 short name cod:binSh   -> specializations.canonical.json
//   pb-legacy-1.0  project envelope pb:binarySwitch          -> specializations.json (DEPRECATED)
// The legacy profile stays available so bench volumes provisioned with pb:binarySwitch keep
// working; new deployments use the canonical profile. Readers accept either envelope.
export const BINARY_SWITCH_CND = 'org.onem2m.common.moduleclass.binarySwitch';
export const CANONICAL_SDT_PROFILE = 'r4-common-1.0';
export const LEGACY_SDT_PROFILE = 'pb-legacy-1.0';
export const SDT_PROFILES = Object.freeze({
  [CANONICAL_SDT_PROFILE]: Object.freeze({ envelope: 'cod:binSh', registry: 'specializations.canonical.json', deprecated: false }),
  [LEGACY_SDT_PROFILE]: Object.freeze({ envelope: 'pb:binarySwitch', registry: 'specializations.json', deprecated: true }),
});

// An existing environment without KEYRING_SDT_PROFILE predates the canonical profile.
export function selectSdtProfile(value) {
  const name = value || LEGACY_SDT_PROFILE;
  if (!Object.hasOwn(SDT_PROFILES, name)) throw new Error(`Unsupported KEYRING_SDT_PROFILE ${name}`);
  return { name, ...SDT_PROFILES[name] };
}

export function switchResource(profile, { rn, state = false, lbl = [] }) {
  if (typeof state !== 'boolean') throw new Error('binarySwitch state requires boolean');
  return { [profile.envelope]: { rn, cnd: BINARY_SWITCH_CND, state, lbl } };
}

export function switchUpdate(profile, state) {
  if (typeof state !== 'boolean') throw new Error('binarySwitch state requires boolean');
  return { [profile.envelope]: { state } };
}

// Dual reader: identifies which profile an existing resource representation uses.
export function describeSwitch(payload) {
  const keys = payload && typeof payload === 'object' ? Object.keys(payload) : [];
  const match = Object.entries(SDT_PROFILES).find(([, profile]) => keys.length === 1 && keys[0] === profile.envelope);
  if (!match) return null;
  const resource = payload[match[1].envelope];
  return { profile: match[0], envelope: match[1].envelope, deprecated: match[1].deprecated, resource };
}
