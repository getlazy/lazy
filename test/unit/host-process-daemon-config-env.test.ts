import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const RUNNER = join(import.meta.dir, '..', '..', 'src', 'runner', 'host-process-runner.ts');

describe('host-process supervisor environment', () => {
  // INVARIANT: a supervisor holds only the LAZY_DAEMON_CONFIG its own daemon
  // issued. Inheriting the daemon process's own (a daemon run inside a task
  // container, as lazy's own tests are) pointed test supervisors at a
  // DIFFERENT, real daemon, acting with another task's token. Source scan: the
  // launch spawns a real supervisor, which a unit test cannot do cheaply.
  test('the inherited LAZY_DAEMON_CONFIG is stripped before the supervisor spawn', () => {
    const source = readFileSync(RUNNER, 'utf8');
    const strip = source.indexOf('delete cleanEnv.LAZY_DAEMON_CONFIG;');
    const spawnAt = source.indexOf('const proc = spawn(supervisorArgs');
    expect(strip).toBeGreaterThan(-1);
    expect(spawnAt).toBeGreaterThan(strip);
    // The only way back in is the config this daemon issued.
    expect(source).toContain('...(daemonConfigPath ? { LAZY_DAEMON_CONFIG: daemonConfigPath } : {})');
  });
});
