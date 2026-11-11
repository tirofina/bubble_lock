import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const comparePath = (left, right) => left < right ? -1 : left > right ? 1 : 0;
// Public-source roots separate credentials, state, receipts and generated output.
export const sourceCollection = Object.freeze([
  { directory: 'integration/src', pattern: '\\.mjs$' },
  { directory: 'src', pattern: '\\.mjs$' },
  { directory: 'contracts', pattern: '\\.json$' },
  { directory: '../contracts/keyring', pattern: '\\.json$' },
  { directory: 'integration/fixtures', pattern: '\\.json$' },
  { directory: 'db/migrations', pattern: '\\.sql$' },
  { directory: 'scripts', pattern: '\\.(mjs|py|ps1)$' },
  { directory: 'test', pattern: '\\.test\\.mjs$' },
  { directory: 'config', pattern: '(\\.example\\.json|\\.env\\.example)$' }
]);

export async function collectIntegrationSources(basePath = root) {
  const paths = ['package.json', 'package-lock.json'];
  async function visit(relative, filter) {
    const directory = resolve(basePath, relative);
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Public source directory required: ${relative}`);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || ['node_modules', 'receipts', 'release', 'dist', 'build', '__pycache__'].includes(entry.name)) continue;
      const child = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`Public source must be a regular file or directory: ${child}`);
      if (entry.isDirectory()) await visit(child, filter);
      else if (entry.isFile() && filter.test(entry.name)) paths.push(child);
    }
  }
  for (const rule of sourceCollection) await visit(rule.directory, new RegExp(rule.pattern));
  const artifacts = [];
  for (const relative of paths.sort(comparePath)) {
    const path = resolve(basePath, relative);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Public source file required: ${relative}`);
    const bytes = await readFile(path);
    artifacts.push({ path: relative, bytes: bytes.length, sha256: hash(bytes) });
  }
  return { artifacts, sourceDigest: hash(JSON.stringify(artifacts)) };
}

export async function buildIntegrationEvidence({ basePath = root, generatedAt = new Date().toISOString() } = {}) {
  const sources = await collectIntegrationSources(basePath);
  return {
    manifestId: 'privacy-bubble.integration.release', version: '1.0.0', role: 'PC-MOBIUS-INTEGRATION', docRevision: '2.0.0', generatedAt,
    commands: ['npm run integration:validate', 'npm run integration', 'npm run integration:replay', 'npm run integration:mec', 'npm run fl:verify', 'npm run mcp:verify'],
    rubric: ['R06', 'R10', 'R12', 'R13', 'R14', 'R15', 'R16', 'R17'],
    collection: { pathBase: 'pc-mobius', rules: sourceCollection, files: ['package.json', 'package-lock.json'], digestAlgorithm: 'SHA-256', digestEncoding: 'UTF-8 JSON.stringify(artifacts), sorted by path Unicode code point' },
    evidence: {
      kind: 'SOURCE_INTEGRITY', status: 'COLLECTED', verification: 'SEPARATE_EXECUTION_RECEIPTS',
      receiptRequirements: ['sourceDigest', 'command', 'environment', 'observedAt', 'result', 'evidenceMode'],
      evidenceModes: ['LOCAL_SIMULATION', 'LOCAL_REAL_PROTOCOL', 'DEPLOYED_SERVICE', 'PHYSICAL_DEVICE'], receipts: []
    },
    ...sources
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const epoch = process.env.SOURCE_DATE_EPOCH;
  if (epoch !== undefined && !/^\d+$/.test(epoch)) throw new Error('SOURCE_DATE_EPOCH requires integer seconds');
  const manifest = await buildIntegrationEvidence({ generatedAt: epoch === undefined ? new Date().toISOString() : new Date(Number(epoch) * 1000).toISOString() });
  const outputPath = resolve(root, 'integration/release/manifest.json');
  await mkdir(resolve(root, 'integration/release'), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ status: manifest.evidence.status, evidenceKind: manifest.evidence.kind, outputPath, artifactCount: manifest.artifacts.length, sourceDigest: manifest.sourceDigest, receiptCount: 0 }, null, 2));
}
