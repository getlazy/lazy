/**
 * `lazy system verify-host-boundary` asks before it spends real sessions.
 *
 * The probe launches nine billed headless Claude Code sessions (one with
 * --check). A fake `claude` on PATH stands in for them: it reports a version
 * and answers every prompt "Not logged in", so a probe that does run ends
 * INCONCLUSIVE within a second or two — enough to tell "ran" from "did not".
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';

const FAKE_CLAUDE = `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "9.9.9 (Claude Code)"; exit 0; fi
echo '{"result":"Not logged in · Please run /login"}'
`;

const RAN = 'Verifying the host file-tool deny boundary';

describe('lazy system verify-host-boundary confirmation', () => {
  let ctx: TestContext;
  let dir: string;
  let env: Record<string, string>;

  beforeEach(async () => {
    ctx = await setupTestLazy();
    dir = await mkdtemp(join(tmpdir(), 'verify-boundary-'));
    await mkdir(join(dir, 'bin'));
    await mkdir(join(dir, 'home'));
    await writeFile(join(dir, 'bin', 'claude'), FAKE_CLAUDE);
    await chmod(join(dir, 'bin', 'claude'), 0o755);
    // The probe plants decoys under $HOME and the verdict cache lives there.
    env = { PATH: `${join(dir, 'bin')}:${process.env.PATH}`, HOME: join(dir, 'home') };
  });

  afterEach(async () => {
    await ctx.cleanup();
    await rm(dir, { recursive: true, force: true });
  });

  // INVARIANT: without a terminal the sessions never start unless both --yes
  // and --json are given. Nobody can answer the question there, and a script
  // must take the verdict from the JSON file, not from a run it never saw.
  test('non-interactive run without --yes refuses before any session', async () => {
    const r = await ctx.lazy(['system', 'verify-host-boundary', '--refresh'], { env });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('--yes --json <path>');
    expect(r.stdout).not.toContain(RAN);
  });

  // INVARIANT: --yes alone is refused, at a terminal or not: it is only for
  // automation, which reads the verdict from --json.
  test('--yes without --json is refused', async () => {
    const cases: Record<string, string>[] = [{}, { LAZY_FORCE_TTY: '1', LAZY_PROMPT_DEFAULTS: 'accept' }];
    for (const extra of cases) {
      const r = await ctx.lazy(['system', 'verify-host-boundary', '--refresh', '--yes'], { env: { ...env, ...extra } });
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain('--yes is only accepted together with --json');
      expect(r.stdout).not.toContain(RAN);
    }
  });

  // INVARIANT: at a terminal the human is asked, default no, and a "no" starts
  // nothing and is never reported as a pass.
  test('declining the prompt starts no session and reports no verdict', async () => {
    const r = await ctx.lazy(['system', 'verify-host-boundary', '--refresh'], {
      env: { ...env, LAZY_FORCE_TTY: '1', LAZY_PROMPT_DEFAULTS: 'decline' },
    });
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain('9 real headless Claude Code sessions');
    expect(r.stdout).toContain('Run them now? [y/N]');
    expect(r.stdout).toContain('Not run');
    expect(r.stdout).not.toContain(RAN);
  });

  test('accepting the prompt runs the probe', async () => {
    const r = await ctx.lazy(['system', 'verify-host-boundary', '--refresh'], {
      env: { ...env, LAZY_FORCE_TTY: '1', LAZY_PROMPT_DEFAULTS: 'accept' },
    });
    expect(r.stdout).toContain(RAN);
    expect(r.exitCode).toBe(2); // the fake is "not logged in": inconclusive
  }, 60_000);

  test('--yes --json runs without asking and writes the verdict', async () => {
    const out = join(dir, 'verdict.json');
    const r = await ctx.lazy(['system', 'verify-host-boundary', '--refresh', '--yes', '--json', out], { env });
    expect(r.stdout).not.toContain('Run them now?');
    expect(r.stdout).toContain(RAN);
    expect(JSON.parse(await readFile(out, 'utf-8')).verdict).toBe('inconclusive');
  }, 60_000);
});
