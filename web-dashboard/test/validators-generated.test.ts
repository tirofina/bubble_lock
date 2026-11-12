import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('validates browser events when CSP forbids string code generation', () => {
  const result = spawnSync(process.execPath, ['--disallow-code-generation-from-strings', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    const { parseDashboardEvent, validateDashboardEvent } = await import('./shared/validation.ts');
    const { loadReplay } = await import('./server/replay.ts');
    const replay = await loadReplay();
    assert.equal(replay.events.length, 18);
    for (const event of replay.events) assert.deepEqual(parseDashboardEvent(event), event);
    assert.equal(validateDashboardEvent({}).valid, false);
    assert.equal(validateDashboardEvent('{broken').valid, false);
  `], { cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr || String(result.error));
});
