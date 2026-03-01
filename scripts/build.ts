#!/usr/bin/env bun
/**
 * Build script for lazy.
 *
 * Runs `bun build --compile` from a temp directory to work around a Bun bug
 * where the compiler creates a temp file in CWD and then fails to rename it
 * on certain filesystems (virtiofs mounts in Docker on macOS, and some
 * macOS APFS configurations).
 *
 * The output is also written to the temp directory first and then copied to
 * the final destination, avoiding issues with cross-filesystem writes.
 */
import { join, basename } from 'path';
import { mkdtempSync, rmSync, copyFileSync, existsSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';

const projectRoot = join(import.meta.dir, '..');

function getLinuxArch(): string {
  const arch = process.arch; // 'x64', 'arm64', etc.
  return arch === 'arm64' ? 'arm64' : 'x64';
}

/**
 * Run bun build --compile from a temp directory to avoid filesystem rename issues.
 * Compiles to the temp dir first, then copies the result to the final destination.
 */
function bunCompile(args: string[], finalOutfile: string): void {
  const tempDir = mkdtempSync(join(tmpdir(), 'lazy-build-'));
  const tempOutfile = join(tempDir, basename(finalOutfile));
  try {
    const proc = Bun.spawnSync(['bun', 'build', '--compile', ...args, '--outfile', tempOutfile], {
      cwd: tempDir,
      stdout: 'inherit',
      stderr: 'inherit',
      env: process.env,
    });
    if (proc.exitCode !== 0) {
      throw new Error(`bun build failed with exit code ${proc.exitCode}`);
    }
    copyFileSync(tempOutfile, finalOutfile);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

// Build agent binary (cross-compiled for Linux)
const agentEntry = join(projectRoot, 'src', 'agent-entry.ts');
const agentOutfile = join(projectRoot, 'lazy-agent');
const linuxTarget = `bun-linux-${getLinuxArch()}`;

// Overwrite existing binaries before building to prevent bun from creating
// massive sparse temp files (150GB+) when the target already exists.
// Even if the binary doesn't exist, we have to have a placeholder to solve
// the circular dependency (will be fixed sometime later)
writeFileSync(agentOutfile, 'placeholder');

console.log(`Building agent binary for ${linuxTarget}...`);
bunCompile([`--target=${linuxTarget}`, agentEntry], agentOutfile);

// Build host binary (native)
const hostEntry = join(projectRoot, 'src', 'index.ts');
const hostOutfile = join(projectRoot, 'lazy');

if (existsSync(hostOutfile)) unlinkSync(hostOutfile);

console.log('Building host binary...');
bunCompile([hostEntry], hostOutfile);

console.log('Build complete.');
