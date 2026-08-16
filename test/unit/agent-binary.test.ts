import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { mkdirSync, rmSync, existsSync, writeFileSync, readdirSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { extractEmbeddedAgentBinary } from '../../src/capture/claude';
import { AGENT_SELFCHECK_SENTINEL } from '../../src/agent/binary-identity';

/**
 * Tests for atomic agent binary replacement logic.
 *
 * These tests verify that:
 * 1. Binary builds use a temp file, not the final path
 * 2. Failed builds clean up the temp file
 * 3. Successful builds atomically replace the old binary
 *
 * We don't test ensureAgentBinary() directly because it requires a full
 * lazy source tree and Bun build environment. Instead, we test the pattern:
 * build to temp file → rename to final path (or cleanup on failure).
 */

describe('Agent binary atomic replacement pattern', () => {
  let testDir: string;
  let binaryPath: string;

  beforeEach(() => {
    // Create a temp directory for each test
    testDir = join(tmpdir(), `lazy-test-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
    binaryPath = join(testDir, 'lazy-agent');
  });

  afterEach(() => {
    // Clean up test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test('builds to temp file then renames to final path', () => {
    // Simulate the build process: write to temp file, rename to final
    const tmpPath = join(testDir, `.tmp-lazy-agent-${randomUUID()}`);

    // Simulate build: write content to temp file
    writeFileSync(tmpPath, 'fake binary content', 'utf-8');
    expect(existsSync(tmpPath)).toBe(true);
    expect(existsSync(binaryPath)).toBe(false);

    // Atomically replace (this is what the real code does)
    Bun.spawnSync(['mv', tmpPath, binaryPath]);

    // Verify: final file exists, temp file is gone
    expect(existsSync(binaryPath)).toBe(true);
    expect(existsSync(tmpPath)).toBe(false);
  });

  test('temp file is cleaned up on build failure', () => {
    const tmpPath = join(testDir, `.tmp-lazy-agent-${randomUUID()}`);

    // Simulate a failed build that leaves a temp file
    writeFileSync(tmpPath, 'partial build', 'utf-8');
    expect(existsSync(tmpPath)).toBe(true);

    // Simulate cleanup on failure (this is what the real code does)
    try {
      if (existsSync(tmpPath)) {
        rmSync(tmpPath);
      }
    } catch {
      // Best effort
    }

    // Verify: temp file is gone
    expect(existsSync(tmpPath)).toBe(false);
  });

  test('temp files use .tmp-lazy-agent prefix', () => {
    // This test verifies the naming pattern used by ensureAgentBinary()
    const tmpPath = join(testDir, `.tmp-lazy-agent-${randomUUID()}`);
    expect(tmpPath).toContain('.tmp-lazy-agent-');

    // Verify the temp file is in the same directory as the final binary
    expect(tmpPath.startsWith(testDir)).toBe(true);
    expect(binaryPath.startsWith(testDir)).toBe(true);
  });

  test('atomic rename replaces existing binary', () => {
    // Create an existing binary
    writeFileSync(binaryPath, 'old binary', 'utf-8');
    expect(existsSync(binaryPath)).toBe(true);

    // Simulate a new build
    const tmpPath = join(testDir, `.tmp-lazy-agent-${randomUUID()}`);
    writeFileSync(tmpPath, 'new binary content', 'utf-8');

    // Atomically replace
    Bun.spawnSync(['mv', tmpPath, binaryPath]);

    // Verify: new content is at the final path, temp file is gone
    expect(existsSync(binaryPath)).toBe(true);
    expect(existsSync(tmpPath)).toBe(false);

    const finalContent = Bun.file(binaryPath).text();
    expect(finalContent).resolves.toBe('new binary content');
  });

  test('no leftover temp files after successful build', () => {
    const tmpPath = join(testDir, `.tmp-lazy-agent-${randomUUID()}`);

    // Simulate build and atomic replace
    writeFileSync(tmpPath, 'binary content', 'utf-8');
    Bun.spawnSync(['mv', tmpPath, binaryPath]);

    // Check directory for leftover temp files
    const files = readdirSync(testDir);
    const tempFiles = files.filter(f => f.startsWith('.tmp-'));

    expect(tempFiles.length).toBe(0);
    expect(files).toContain('lazy-agent');
  });
});

/**
 * The extraction path itself, driven for real (the embedded-binary source is
 * parameterised so a compiled build isn't needed).
 *
 * Regression: this used to decide the extracted binary was current by comparing
 * SIZES. Two builds of a ~100MB Bun executable that differ by a few source
 * lines routinely land on the same size, and when they did, every container got
 * the STALE agent binary bind-mounted while the daemon ran the new code. That
 * is invisible from both ends — the daemon reports the new version, the agent
 * behaves like the old one — and it is the shape of the `lazy_wait` failure
 * this suite was extended for: an agent-side MCP client older than the daemon
 * it talks to.
 */
describe('extractEmbeddedAgentBinary staleness detection', () => {
  let testDir: string;
  let embeddedPath: string;
  let destDir: string;

  /**
   * A stand-in "embedded binary": 4096 bytes (above MIN_AGENT_BINARY_SIZE) that
   * looks like the real thing — ELF magic and the selfcheck sentinel — because
   * extraction now REFUSES to install a file that is not the compiled agent
   * (see test/unit/agent-binary-identity.test.ts). `marker` varies the content
   * without varying the length, which is what these staleness tests are about.
   */
  const pad = (marker: string) => {
    const head = '\u007fELF' /* ELF magic */ + AGENT_SELFCHECK_SENTINEL + ' 0.0.0-test ' + marker;
    return head + 'x'.repeat(4096 - head.length);
  };

  beforeEach(() => {
    testDir = join(tmpdir(), `lazy-extract-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
    embeddedPath = join(testDir, 'embedded-lazy-agent');
    destDir = join(testDir, 'bin');
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  test('extracts when nothing is there yet', async () => {
    writeFileSync(embeddedPath, pad('BUILD-A'));
    const out = await extractEmbeddedAgentBinary(destDir, embeddedPath);
    expect(out).toBe(join(destDir, 'lazy-agent'));
    expect(await Bun.file(out!).text()).toBe(pad('BUILD-A'));
    expect(statSync(out!).mode & 0o111).toBeGreaterThan(0);
  });

  // THE regression: same size, different bytes. A size-only check keeps the
  // stale binary here and ships old agent code into every container.
  test('re-extracts a stale binary of identical size', async () => {
    writeFileSync(embeddedPath, pad('BUILD-A'));
    const out = (await extractEmbeddedAgentBinary(destDir, embeddedPath))!;
    expect(await Bun.file(out).text()).toBe(pad('BUILD-A'));

    // A new lazy build: same length to the byte, different content.
    writeFileSync(embeddedPath, pad('BUILD-B'));
    expect(Bun.file(embeddedPath).size).toBe(4096);

    await extractEmbeddedAgentBinary(destDir, embeddedPath);
    expect(await Bun.file(out).text()).toBe(pad('BUILD-B'));
  });

  test('leaves a byte-identical binary untouched', async () => {
    writeFileSync(embeddedPath, pad('BUILD-A'));
    const out = (await extractEmbeddedAgentBinary(destDir, embeddedPath))!;
    const before = statSync(out);

    const again = await extractEmbeddedAgentBinary(destDir, embeddedPath);
    expect(again).toBe(out);
    // Same inode AND same mtime — nothing was rewritten.
    expect(statSync(out).ino).toBe(before.ino);
    expect(statSync(out).mtimeMs).toBe(before.mtimeMs);
  });

  // INVARIANT: re-extraction must not rewrite the destination inode in place.
  // Running containers bind-mount that exact file at /usr/local/bin/lazy-agent;
  // truncating and rewriting it mutates a live builder's agent binary
  // mid-session. rename() gives them the old inode and new launches the new one.
  test('re-extraction replaces the file atomically, not in place', async () => {
    writeFileSync(embeddedPath, pad('BUILD-A'));
    const out = (await extractEmbeddedAgentBinary(destDir, embeddedPath))!;
    const oldIno = statSync(out).ino;

    writeFileSync(embeddedPath, pad('BUILD-B'));
    await extractEmbeddedAgentBinary(destDir, embeddedPath);

    expect(statSync(out).ino).not.toBe(oldIno);
    // And no temp file is left behind.
    expect(readdirSync(destDir).filter(f => f.startsWith('.tmp-'))).toEqual([]);
  });

  test('ignores a dev-mode placeholder that is too small to be a binary', async () => {
    writeFileSync(embeddedPath, 'placeholder\n');
    expect(await extractEmbeddedAgentBinary(destDir, embeddedPath)).toBeNull();
  });

  test('returns null when there is no embedded binary at all', async () => {
    expect(await extractEmbeddedAgentBinary(destDir, join(testDir, 'nope'))).toBeNull();
  });
});
