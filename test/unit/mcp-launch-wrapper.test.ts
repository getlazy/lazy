import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { writeMcpLaunchWrapper } from '../../src/builder/mcp-launch-wrapper';
import { AGENT_SELFCHECK_SENTINEL } from '../../src/agent/binary-identity';

describe('writeMcpLaunchWrapper', () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  test('writes an executable script that selfcheck-gates lazy-agent before exec', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-mcp-wrap-'));
    const path = await writeMcpLaunchWrapper({ tmpDir, builderId: 'abc12345' });
    const script = await readFile(path, 'utf-8');

    expect(path).toContain('lazy-mcp-wrapper-abc12345.sh');
    expect(script).toContain('#!/bin/sh');
    expect(script).toContain('lazy-agent selfcheck');
    expect(script).toContain(AGENT_SELFCHECK_SENTINEL);
    expect(script).toContain('exec lazy-agent "$@"');
    expect(script).toContain('bun run build');
  });
});
