/**
 * Wait for lazy-guest-init's detached dockerd wrapper to finish writing.
 *
 * `--ensure` starts dockerd under a setsid'd wrapper shell that writes
 * lazy-dockerd.pid, then lazy-dockerd.start, and — once dockerd exits —
 * lazy-dockerd.exit, all on its own schedule. `--ensure` returns as soon as
 * `docker info` answers, which a fake dockerd makes true before the wrapper has
 * written any of that. A test that then plays a death by overwriting those files
 * races the wrapper: under parallel load its late `echo 0 >lazy-dockerd.exit`
 * lands AFTER the test's `137`, and the next `--ensure` diagnoses `exited-0`.
 * Settle first, then write.
 *
 * `kill`: the fake dockerd is still running (it sleeps); end it so the wrapper
 * writes its exit status now rather than whenever the sleep ends.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

async function waitFor(what: string, cond: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`dockerd wrapper never ${what} within ${timeoutMs}ms`);
    await Bun.sleep(20);
  }
}

export async function settleDockerdWrapper(runDir: string, opts: { kill?: boolean } = {}): Promise<void> {
  const pidFile = join(runDir, 'lazy-dockerd.pid');
  const startFile = join(runDir, 'lazy-dockerd.start');
  const exitFile = join(runDir, 'lazy-dockerd.exit');
  let pid = 0;
  await waitFor('wrote its pid and start files', async () => {
    if (!existsSync(pidFile) || !existsSync(startFile)) return false;
    pid = Number((await readFile(pidFile, 'utf8')).trim());
    return pid > 0;
  });
  if (opts.kill && !existsSync(exitFile)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch (err) {
      // ESRCH: the fake already exited on its own; the wait below still applies.
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
    }
  }
  await waitFor('wrote its exit status', async () => existsSync(exitFile));
}
