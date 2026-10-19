/**
 * Source guard for the hold-logging call sites. Driving autoResumeTask or the
 * reconciler in-process needs the daemon's proxy and a container runtime, so
 * the behaviour of the dedup itself is tested in image-hold-log-once.test.ts
 * and this file pins that every site routes its "held until the project's
 * runner image is ready" line through it.
 */
import { describe, test, expect } from 'bun:test';
import { readFile } from 'fs/promises';
import { join } from 'path';

const SITES = ['src/utils/reconcile.ts', 'src/utils/auto-resume.ts', 'src/daemon/auto-deliver.ts', 'src/daemon/auto-react.ts'];

describe('image-hold log call sites', () => {
  // INVARIANT: no path logs a runner-image hold unconditionally. The
  // reconciler re-offers a held task every few seconds, so an unguarded line
  // floods the daemon log for as long as the project's image cannot build.
  for (const file of SITES) {
    test(`${file} logs its runner-image hold only through shouldLogImageHold`, async () => {
      const lines = (await readFile(join(import.meta.dir, '../..', file), 'utf-8')).split('\n');
      const logging = lines.filter((l) => l.includes('logger.') && l.includes("held until the project's runner image is ready"));
      expect(logging.length).toBeGreaterThan(0);
      for (const l of logging) expect(l).toContain('shouldLogImageHold(');
    });
  }
});
