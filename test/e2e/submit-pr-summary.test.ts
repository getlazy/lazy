import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { readTaskStatus } from '../helpers/storage';

/**
 * A stateful fake `gh`: `pr create` stores the body it was given, `pr edit`
 * replaces it, `pr view --json body` reads it back. A real daemon, real git.
 */
function fakeGh(stateDir: string): string {
  return `#!/bin/sh
D="${stateDir}"
body=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--body" ]; then body="$a"; fi
  prev="$a"
done
case "$*" in
  *"--version"*) echo "gh version 2.0.0 (fake)"; exit 0 ;;
  "pr create"*) printf '%s' "$body" > "$D/body"; echo "https://github.com/acme/widgets/pull/7"; exit 0 ;;
  "pr edit"*) printf '%s' "$body" > "$D/body"; exit 0 ;;
  *"--json body"*) if [ -f "$D/body" ]; then printf '{"body":%s}' "$(cat "$D/body" | sed ':a;N;$!ba;s/\\\\/\\\\\\\\/g;s/"/\\\\"/g;s/\\n/\\\\n/g;s/^/"/;s/$/"/')"; else echo '{"body":""}'; fi; exit 0 ;;
  *"--json state"*) echo '{"state":"OPEN"}'; exit 0 ;;
  *"--json baseRefName"*) echo '{"baseRefName":"main"}'; exit 0 ;;
  *"--json isDraft"*) echo '{"isDraft":false}'; exit 0 ;;
  *"pr view"*) if [ -f "$D/body" ]; then echo '{"url":"https://github.com/acme/widgets/pull/7","number":7,"state":"OPEN","baseRefName":"main","headRefOid":"x"}'; exit 0; fi; echo "no pull requests found" >&2; exit 1 ;;
  *"pr list"*) echo '[]'; exit 0 ;;
esac
echo "fake gh: unsupported: $*" >&2
exit 1
`;
}

describe('submit shows a real PR Summary', () => {
  let ctx: TestContext;
  let ghDir: string;

  beforeEach(async () => {
    ghDir = mkdtempSync(join(tmpdir(), 'lazy-fake-gh-'));
    writeFileSync(join(ghDir, 'gh'), fakeGh(ghDir));
    chmodSync(join(ghDir, 'gh'), 0o755);
    ctx = await setupTestLazy({
      withDaemon: true,
      daemonEnv: { PATH: `${ghDir}:${process.env.PATH ?? ''}`, LAZY_SUMMARIZER_STUB: '1' },
    });
  });

  afterEach(async () => {
    await ctx.cleanup();
    rmSync(ghDir, { recursive: true, force: true });
  });

  // Submits a task that already has finished work, against the stateful fake gh.
  async function submitTaskWithWork(): Promise<string> {
    const taskId = await createTask(ctx, 'Summary goal', 'Add a file');
    expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS));
    expect((await ctx.lazy(['wait', taskId])).exitCode).toBe(0);
    const worktree = join(ctx.root, '.lazy', 'worktrees', taskId);
    writeFileSync(join(worktree, 'f.txt'), 'x\n');
    ctx.git('-C', worktree, 'add', 'f.txt');
    ctx.git('-C', worktree, 'commit', '-m', 'Add f.txt');

    const tomlPath = join(ctx.root, 'lazy.toml');
    const toml = readFileSync(tomlPath, 'utf-8');
    const github = toml.replace('driver = "local"', 'driver = "github"');
    expect(github).not.toBe(toml);
    writeFileSync(tomlPath, github);
    const bare = join(ctx.root, '.test-remote.git');
    expect(ctx.git('init', '--bare', '-b', 'main', bare).exitCode).toBe(0);
    if (ctx.git('remote', 'get-url', 'origin').exitCode === 0) ctx.git('remote', 'set-url', 'origin', bare);
    else ctx.git('remote', 'add', 'origin', bare);
    expect(ctx.git('push', 'origin', 'main').exitCode).toBe(0);

    expectSuccess(await ctx.lazy(['submit', taskId, '--yes']));
    expect(readTaskStatus(ctx.root, taskId)).toBe('submitted');
    return taskId;
  }

  async function waitForBody(marker: string): Promise<string> {
    const bodyPath = join(ghDir, 'body');
    const deadline = Date.now() + 100_000;
    let body = '';
    while (Date.now() < deadline) {
      body = existsSync(bodyPath) ? readFileSync(bodyPath, 'utf-8') : '';
      if (body.includes(marker)) break;
      await Bun.sleep(1000);
    }
    return body;
  }

  // INVARIANT: a task submitted with work already done never keeps the "Pending"
  // placeholder: its PR body ends up with a real Summary. This guards behaviour,
  // not the bug: it also passes without the submit-time refresh, because the
  // daemon sweep fills the Summary in within seconds when synthesis works.
  test('the PR body carries a synthesized Summary after submit', async () => {
    await submitTaskWithWork();
    const body = await waitForBody('SYNTHESIZED-FIDELITY');
    expect(body).toContain('SYNTHESIZED-FIDELITY');
    expect(body).not.toContain('Pending');
    expect(body).toContain('Summary goal');
  }, 240_000);

  // INVARIANT: when the summary cannot be written, the description says so
  // instead of promising an automatic update that never comes. Fails without it:
  // the body stays "Pending — updated automatically" for good.
  test('an unavailable summarizer leaves an honest note, never the Pending promise', async () => {
    await ctx.cleanup();
    ctx = await setupTestLazy({
      withDaemon: true,
      daemonEnv: { PATH: `${ghDir}:${process.env.PATH ?? ''}`, LAZY_SUMMARIZER_STUB: '1', LAZY_SUMMARIZER_FAIL: '1' },
    });
    await submitTaskWithWork();
    const body = await waitForBody('Summary not available yet');
    expect(body).toContain('Summary not available yet');
    expect(body).not.toContain('Pending');
  }, 240_000);
});
