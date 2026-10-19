import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { readTaskStatus } from '../helpers/storage';
import { DaemonClient } from '../../src/daemon/client';
import { getDaemonTcpTarget, readToken } from '../../src/daemon/lifecycle';

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
  "pr create"*) printf '%s' "$body" > "$D/body"; printf '%s' "$body" > "$D/created"; echo "https://github.com/acme/widgets/pull/7"; exit 0 ;;
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


const TASK_TEMPLATE = 'https://teams.example/teams/1/projects/2/tasks/{task}';
const SERVICE_TEMPLATE = 'https://teams.example/teams/1/projects/2/tasks/{task}/services/{service}';

describe('submit puts Lazy Teams links at the top of the PR description', () => {
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

  async function pushLinks(params: Record<string, unknown>) {
    const target = getDaemonTcpTarget(ctx.root);
    const token = readToken(ctx.root);
    if (!target || !token) throw new Error('test daemon did not record a TCP target and token');
    return await DaemonClient.fromTarget(target, token).rpc('setTeamsLinks', ctx.root, params);
  }

  async function submitTask(serveToml: string): Promise<{ taskId: string; body: string; created: string }> {
    const taskId = await createTask(ctx, 'Links goal', 'Add a file');
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
    writeFileSync(tomlPath, `${github}\n${serveToml}`);
    const bare = join(ctx.root, '.test-remote.git');
    expect(ctx.git('init', '--bare', '-b', 'main', bare).exitCode).toBe(0);
    if (ctx.git('remote', 'get-url', 'origin').exitCode === 0) ctx.git('remote', 'set-url', 'origin', bare);
    else ctx.git('remote', 'add', 'origin', bare);
    expect(ctx.git('push', 'origin', 'main').exitCode).toBe(0);

    expectSuccess(await ctx.lazy(['submit', taskId, '--yes']));
    expect(readTaskStatus(ctx.root, taskId)).toBe('submitted');
    // The body `pr create` was given: what the forge shows, and notifies
    // watchers with, before any refresh runs.
    const created = readFileSync(join(ghDir, 'created'), 'utf-8');
    // The refresh that follows a submit rewrites the description in place; wait
    // for it so the assertions see the body the reviewer will see.
    const bodyPath = join(ghDir, 'body');
    const deadline = Date.now() + 100_000;
    let body = '';
    while (Date.now() < deadline) {
      body = existsSync(bodyPath) ? readFileSync(bodyPath, 'utf-8') : '';
      if (body.includes('SYNTHESIZED-FIDELITY')) break;
      await Bun.sleep(1000);
    }
    return { taskId, body, created };
  }

  // INVARIANT: under Teams the description opens with a link to the task and to
  // the project's main service, and the refresh never duplicates the block.
  test('main_service picks the service; the task link comes first, once', async () => {
    await pushLinks({ taskUrlTemplate: TASK_TEMPLATE, serviceUrlTemplate: SERVICE_TEMPLATE });
    const { body, created } = await submitTask('[serve]\nports = [3000, 5173]\nmain_service = 5173\n');
    // INVARIANT: the links are in the PR as CREATED, not only after a later
    // refresh, which may never write.
    expect(created.startsWith('<!-- lazy:links:begin -->')).toBe(true);
    expect(created).toContain('/services/5173)');
    expect(body.startsWith('<!-- lazy:links:begin -->')).toBe(true);
    expect(body).toContain('(https://teams.example/teams/1/projects/2/tasks/');
    expect(body).toContain('/services/5173)');
    expect(body).not.toContain('/services/3000');
    expect(body.split('lazy:links:begin').length - 1).toBe(1);
    expect(body.indexOf('## Goal')).toBeGreaterThan(body.indexOf('lazy:links:end'));
    expect(body).toContain('SYNTHESIZED-FIDELITY');
  }, 240_000);

  // INVARIANT: without main_service the first declared port is the main service.
  test('a missing main_service falls back to the first declared port', async () => {
    await pushLinks({ taskUrlTemplate: TASK_TEMPLATE, serviceUrlTemplate: SERVICE_TEMPLATE });
    const { body, created } = await submitTask('[serve]\nports = [3000, 5173]\n');
    expect(created).toContain('/services/3000)');
    expect(body).toContain('/services/3000)');
    expect(body).not.toContain('/services/5173');
  }, 240_000);

  // INVARIANT: a solo install (nothing pushed by Teams) gets no links: a
  // localhost link is useless to a reviewer.
  test('without Teams the description carries no links', async () => {
    const { body, created } = await submitTask('[serve]\nports = [3000]\n');
    expect(created).not.toContain('lazy:links');
    expect(body).not.toContain('lazy:links');
    expect(body).not.toContain('teams.example');
    expect(body).toContain('## Goal');
  }, 240_000);
});
