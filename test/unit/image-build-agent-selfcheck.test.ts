import { describe, test, expect } from 'bun:test';
import { readFile } from 'fs/promises';
import { join } from 'path';

/**
 * INVARIANT: a container image must not be tagged while the agent binary that
 * will be bind-mounted at launch would fail the builder preflight selfcheck.
 */
describe('image build agent-binary selfcheck gate', () => {
  test('buildImageWithTags probes the agent mount after docker build succeeds', async () => {
    const source = await readFile(join(import.meta.dir, '../../src/capture/claude.ts'), 'utf-8');
    const buildIndex = source.indexOf('await runDockerBuild(');
    const probeIndex = source.indexOf('assertAgentBinarySelfcheckForImage(');
    expect(buildIndex).toBeGreaterThan(-1);
    expect(probeIndex).toBeGreaterThan(buildIndex);
  });
});
