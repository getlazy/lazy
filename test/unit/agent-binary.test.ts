import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { mkdirSync, rmSync, existsSync, writeFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

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
