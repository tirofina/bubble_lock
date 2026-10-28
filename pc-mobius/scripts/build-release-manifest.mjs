import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const templatePath = join(root, 'release', 'manifest.json');
const outputPath = resolve(process.env.RELEASE_MANIFEST_OUTPUT ?? join(root, 'receipts', `release-manifest-${Date.now()}.json`));
const template = JSON.parse(await readFile(templatePath, 'utf8'));
const artifacts = {};
for (const relativePath of template.artifacts) {
  const bytes = await readFile(join(root, relativePath));
  artifacts[relativePath] = createHash('sha256').update(bytes).digest('hex');
}
const manifest = { ...template, sourceRevision: process.env.GIT_COMMIT ?? 'working-tree', generatedAt: new Date().toISOString(), artifactSha256: artifacts };
await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ status: 'READY', outputPath, artifactCount: Object.keys(artifacts).length }, null, 2));
