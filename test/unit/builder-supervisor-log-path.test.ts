/**
 * Unit tests: the builder supervisor's log path has ONE definition, shared by
 * the supervisor that writes the log and the DockerRunner that copies a dead
 * builder's log out of its container.
 */

import { describe, test, expect } from 'bun:test';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { builderSupervisorLogPath } from '../../src/builder/supervisor-log-path';

const ROOT = join(import.meta.dir, '..', '..');
const SHARED_IMPORT =
  /import\s*\{[^}]*\bbuilderSupervisorLogPath\b[^}]*\}\s*from\s*'\.\.\/builder\/supervisor-log-path'/;
const LOCAL_DEFINITION = /\b(function|const|let|var)\s+builderSupervisorLogPath\b/;

describe('builderSupervisorLogPath', () => {
  // INVARIANT: the writer (runBuilderSupervisor) and the reader
  // (DockerRunner.readSupervisorLog) resolve the log path through the SAME
  // function in src/builder/supervisor-log-path.ts, and neither defines its own.
  // Two identical copies drift apart silently: the daemon would then copy from
  // a path nothing writes to, and a dead builder's only evidence would vanish.
  for (const [role, file] of [
    ['writer', 'src/supervisor/builder.ts'],
    ['reader', 'src/runner/docker-runner.ts'],
  ] as const) {
    test(`the ${role} (${file}) imports the shared function and defines none of its own`, async () => {
      const source = await readFile(join(ROOT, file), 'utf-8');
      expect(source).toMatch(SHARED_IMPORT);
      expect(source).not.toMatch(LOCAL_DEFINITION);
    });
  }

  test('an 8-hex builder id maps to one fixed file the daemon can copy', () => {
    expect(builderSupervisorLogPath('0a1b2c3d')).toBe('/tmp/lazy-builder-0a1b2c3d.log');
    expect(builderSupervisorLogPath('0a1b2c3d')).toBe(builderSupervisorLogPath('0a1b2c3d'));
  });

  test('a missing or malformed id gets a timestamped name, never an id-derived path', () => {
    for (const id of [undefined, '', 'ABCDEF12', '../../etc', '0a1b2c3d4']) {
      expect(builderSupervisorLogPath(id)).toMatch(/^\/tmp\/lazy-builder-\d+\.log$/);
    }
  });
});
