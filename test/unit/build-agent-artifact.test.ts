import { describe, test, expect } from 'bun:test';
import { readFile } from 'fs/promises';
import { join } from 'path';

/**
 * INVARIANT: scripts/build.ts must verify the agent artifact BEFORE embedding it
 * into the host `lazy` binary. A bare Bun runtime at ./lazy-agent used to ship
 * inside compiled lazy and then into ~/.lazy/bin/lazy-agent after upgrade.
 */
describe('scripts/build.ts agent artifact guard', () => {
  const ROOT = join(import.meta.dir, '..', '..');

  test('verifies the agent binary bytes after compile and before the host build', async () => {
    const script = await readFile(join(ROOT, 'scripts', 'build.ts'), 'utf-8');

    const agentCompileIndex = script.indexOf('bunCompile([`--target=${linuxTarget}`, agentEntry], agentOutfile)');
    const hostCompileIndex = script.indexOf('bunCompile([hostEntry], hostOutfile)');
    expect(agentCompileIndex).toBeGreaterThan(-1);
    expect(hostCompileIndex).toBeGreaterThan(agentCompileIndex);

    expect(script).toContain('verifyAgentBinaryBytes');
    const verifyIndex = script.indexOf('verifyAgentBinaryBytes(agentBytes)');
    expect(verifyIndex).toBeGreaterThan(agentCompileIndex);
    expect(verifyIndex).toBeLessThan(hostCompileIndex);
  });

  test('runs exec selfcheck on Linux after the content check', async () => {
    const script = await readFile(join(ROOT, 'scripts', 'build.ts'), 'utf-8');
    expect(script).toContain('verifyAgentBinarySelfcheckExec(agentOutfile)');
    expect(script).toMatch(/process\.platform === 'linux'/);
  });
});
