import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { join } from 'path';
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import {
  verifyAgentBinary,
  verifyAgentBinaryBytes,
  formatAgentBinaryError,
  AGENT_SELFCHECK_SENTINEL,
} from '../../src/agent/binary-identity';
import { extractEmbeddedAgentBinary } from '../../src/capture/claude';

/**
 * INVARIANT: nothing may install a file at the agent-binary path without first
 * proving it is the compiled lazy agent.
 *
 * The failure this encodes was observed in the field: a bare Bun runtime ended
 * up at ~/.lazy/bin/lazy-agent, was bind-mounted into every container at
 * /usr/local/bin/lazy-agent, and produced two unrelated-looking errors —
 * `lazy-agent selfcheck` exiting 1 with EMPTY stdout, and the container's entry
 * argv failing as `error: Script not found "builder"` (Bun's message for
 * `bun <script>`). Every layer that could have caught it trusted the file:
 * extraction checked only a 1KB size floor, the cached-binary path checked only
 * existence, and `lazy upgrade` reported "rebuilt" without looking.
 *
 * The check is content-based because the agent binary is a Linux cross-compile:
 * a macOS host cannot exec it to ask what it is.
 */

const ELF_HEADER = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]);
const MACHO_HEADER = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01]);

/** An ELF with no lazy sentinel — what a bare Bun runtime looks like on disk. */
function bareBunLike(size = 4096): Buffer {
  const buf = Buffer.alloc(size, 0x41);
  ELF_HEADER.copy(buf, 0);
  buf.write('bun --version', 64);
  return buf;
}

/** An ELF carrying the sentinel — what the compiled agent looks like on disk. */
function agentLike(size = 4096, sentinelAt = 512): Buffer {
  const buf = bareBunLike(size);
  buf.write(`${AGENT_SELFCHECK_SENTINEL} 0.0.0-test`, sentinelAt);
  return buf;
}

describe('agent binary identity', () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `lazy-agent-identity-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('accepts a binary carrying the selfcheck sentinel', async () => {
    const p = join(dir, 'lazy-agent');
    writeFileSync(p, agentLike());
    expect(await verifyAgentBinary(p)).toEqual({ ok: true });
  });

  test('rejects a bare Bun runtime and says so by name', async () => {
    const p = join(dir, 'lazy-agent');
    writeFileSync(p, bareBunLike());
    const verdict = await verifyAgentBinary(p);
    expect(verdict.ok).toBe(false);
    // The operator must be told WHAT the file is, not just that it is wrong.
    expect((verdict as { reason: string }).reason).toContain('bare Bun runtime');
  });

  test('rejects the dev-mode placeholder as too small', async () => {
    const p = join(dir, 'lazy-agent');
    writeFileSync(p, 'placeholder\n');
    const verdict = await verifyAgentBinary(p);
    expect(verdict.ok).toBe(false);
    expect((verdict as { reason: string }).reason).toContain('placeholder');
  });

  test('rejects a macOS host binary with a platform-specific reason', async () => {
    const p = join(dir, 'lazy-agent');
    const buf = Buffer.alloc(4096, 0x41);
    MACHO_HEADER.copy(buf, 0);
    buf.write(`${AGENT_SELFCHECK_SENTINEL} 0.0.0-test`, 512);
    writeFileSync(p, buf);
    const verdict = await verifyAgentBinary(p);
    // Even WITH the sentinel: the host build cannot run inside a Linux container.
    expect(verdict.ok).toBe(false);
    expect((verdict as { reason: string }).reason).toContain('Linux cross-compile');
  });

  test('reports a missing file rather than throwing', async () => {
    const verdict = await verifyAgentBinary(join(dir, 'nope'));
    expect(verdict).toEqual({ ok: false, reason: 'file does not exist' });
  });

  test('finds a sentinel that straddles a scan chunk boundary', async () => {
    // The scan reads in 4MB chunks; a match split across two reads must still be
    // found, or a real binary would be rejected at random depending on layout.
    const size = 5 * 1024 * 1024;
    const boundary = 4 * 1024 * 1024;
    writeFileSync(join(dir, 'lazy-agent'), agentLike(size, boundary - 5));
    expect(await verifyAgentBinary(join(dir, 'lazy-agent'))).toEqual({ ok: true });
  });

  test('verifyAgentBinaryBytes mirrors the on-disk verdicts', () => {
    expect(verifyAgentBinaryBytes(agentLike())).toEqual({ ok: true });
    expect(verifyAgentBinaryBytes(bareBunLike()).ok).toBe(false);
    expect(verifyAgentBinaryBytes(Buffer.from('placeholder\n')).ok).toBe(false);
  });

  test('the error text names the remedy for both dev and installed builds', () => {
    const dev = formatAgentBinaryError('/p/lazy-agent', 'because', { canRebuild: true });
    expect(dev).toContain('bun run build');
    const installed = formatAgentBinaryError('/p/lazy-agent', 'because', { canRebuild: false });
    expect(installed).toContain('lazy upgrade');
    // Both must explain the consequence, not just the fact.
    expect(dev).toContain('/usr/local/bin/lazy-agent');
  });
});

describe('extractEmbeddedAgentBinary refuses to install a non-agent', () => {
  let dir: string;
  let destDir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `lazy-agent-extract-${randomUUID()}`);
    destDir = join(dir, 'bin');
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('installs a valid embedded binary', async () => {
    const src = join(dir, 'embedded');
    writeFileSync(src, agentLike());
    const out = await extractEmbeddedAgentBinary(destDir, src);
    expect(out).toBe(join(destDir, 'lazy-agent'));
    expect(readFileSync(out!).length).toBe(4096);
  });

  // INVARIANT: in dev mode the "embedded" path is the repo's own ./lazy-agent,
  // which is whatever the last build (or an interrupted one) left there. A file
  // over the 1KB floor used to be copied to ~/.lazy/bin/lazy-agent and mounted
  // into every container. It must be refused so the caller rebuilds instead.
  test('refuses a bare-Bun-shaped file and installs nothing', async () => {
    const src = join(dir, 'embedded');
    writeFileSync(src, bareBunLike(64 * 1024));
    const out = await extractEmbeddedAgentBinary(destDir, src);
    expect(out).toBeNull();
    expect(existsSync(join(destDir, 'lazy-agent'))).toBe(false);
  });

  test('refuses the tiny placeholder (ordinary dev-mode case)', async () => {
    const src = join(dir, 'embedded');
    writeFileSync(src, 'placeholder\n');
    expect(await extractEmbeddedAgentBinary(destDir, src)).toBeNull();
  });
});

describe('lazy upgrade agent-binary rebuild', () => {
  let home: string;
  let binDir: string;
  let restoreHome: string | undefined;

  beforeEach(() => {
    home = join(tmpdir(), `lazy-upgrade-home-${randomUUID()}`);
    binDir = join(home, '.lazy', 'bin');
    mkdirSync(binDir, { recursive: true });
    restoreHome = process.env.HOME;
    process.env.HOME = home;
  });

  afterEach(() => {
    if (restoreHome === undefined) delete process.env.HOME;
    else process.env.HOME = restoreHome;
    rmSync(home, { recursive: true, force: true });
    mock.restore();
  });

  // INVARIANT: the rebuild removes the STALENESS MARKER, never the binary.
  // Deleting the binary first (the old behavior) meant a rebuild that failed for
  // any reason left the machine with no agent binary at all — every container
  // launch broken, instead of running the previous, working one.
  test('deletes only the hash file, leaving the existing binary in place', async () => {
    const binary = join(binDir, 'lazy-agent');
    const hash = join(binDir, 'lazy-agent.hash');
    writeFileSync(binary, agentLike());
    writeFileSync(hash, 'stale-hash:bun-linux-arm64');

    mock.module('../../src/capture/claude', () => ({
      ensureAgentBinary: async () => binary,
      ensureImage: async () => 'lazy-runner:test',
      resolveImageName: () => 'lazy-runner:test',
    }));
    const { forceRebuildAgentBinary } = await import('../../src/cli/commands/upgrade');

    await forceRebuildAgentBinary();

    expect(existsSync(hash)).toBe(false);
    expect(existsSync(binary)).toBe(true);
  });

  // INVARIANT: `lazy upgrade` is the remedy every "your agent binary is wrong"
  // error names. It must never be the command that installs a wrong binary and
  // reports success.
  test('fails loud when the rebuilt binary is not the lazy agent', async () => {
    const binary = join(binDir, 'lazy-agent');
    writeFileSync(binary, bareBunLike());

    mock.module('../../src/capture/claude', () => ({
      ensureAgentBinary: async () => binary,
      ensureImage: async () => 'lazy-runner:test',
      resolveImageName: () => 'lazy-runner:test',
    }));
    const { forceRebuildAgentBinary } = await import('../../src/cli/commands/upgrade');

    await expect(forceRebuildAgentBinary()).rejects.toThrow(/bare Bun runtime/);
  });
});
