/**
 * Live builder-conversation capture, end to end through the REAL supervisor.
 *
 * WHY THIS SUITE EXISTS
 * ---------------------
 * Builder capture has now broken twice without anyone noticing (see the tasks
 * `fix-builder-capture-loss` and `fix-conversation-capture`), because every
 * existing test stops short of the path that actually runs in production: the
 * in-container `lazy-agent builder` supervisor, watching a real Claude projects
 * dir, writing through the daemon. Unit tests call the capture functions
 * directly; the module-mock e2e seam replaces the supervisor wholesale.
 *
 * This suite runs the real thing: a real daemon, a real `lazy-agent builder`
 * supervisor process, a fake `claude` binary that writes real session JSONL
 * into a real `$HOME/.claude/projects/<encoded-cwd>/` dir. The only fake parts
 * are the agent binary and the container boundary (the supervisor runs as a
 * plain subprocess — it behaves identically, it just isn't in Docker).
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { installFakeAgentBinary } from '../helpers/fake-agent-binary';
import { writeBuilderClaudeConfig } from '../helpers/builder-claude-config';
import { TURN_IDENTITY_ENV_PINS } from '../helpers/mcp-env';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { getWebPortPath } from '../../src/daemon/paths';
import { mintMcpToken } from '../../src/daemon/mcp-tokens';
import { builderScratchDir } from '../../src/builder/scratch';

const AGENT_ENTRY = resolve(__dirname, '../../src/agent-entry.ts');

/** Scratch dir as the supervisor subprocess sees it (matches setupTestLazy's pin). */
function scratchDirFor(ctx: TestContext): string {
  const previous = process.env.LAZY_SCRATCH_BASE_DIR;
  process.env.LAZY_SCRATCH_BASE_DIR = ctx.scratchBaseDir;
  try {
    return builderScratchDir(ctx.root);
  } finally {
    if (previous === undefined) delete process.env.LAZY_SCRATCH_BASE_DIR;
    else process.env.LAZY_SCRATCH_BASE_DIR = previous;
  }
}

/** Poll until `check` passes or the deadline expires. */
async function waitFor(check: () => Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe('builder live conversation capture', () => {
  let ctx: TestContext;
  let home: string;
  let binDir: string;

  beforeEach(async () => {
    ctx = await setupTestLazy({ fakeClaude: true });
    home = await mkdtemp(join(tmpdir(), 'lazy-e2e-home-'));
    await mkdir(join(home, '.claude', 'projects'), { recursive: true });
    binDir = await mkdtemp(join(tmpdir(), 'lazy-e2e-bin-'));
    // `mcp` must run the real server: the supervisor's preflight starts it and
    // requires an `initialize` response before it will launch Claude Code.
    await installFakeAgentBinary(binDir, AGENT_ENTRY);
  });

  afterEach(async () => {
    await ctx.cleanup();
    await rm(home, { recursive: true, force: true });
    await rm(binDir, { recursive: true, force: true });
  });

  /**
   * Write the daemon MCP config the supervisor reads (as the runner mounts it),
   * plus the `$HOME/.claude.json` that must name it — the supervisor's MCP
   * preflight requires the two to agree before it will launch Claude Code.
   *
   * The token must be a BUILDER-kind MCP token, exactly what
   * `writeDaemonMcpConfig` mints in production — never the shared daemon token.
   * This fixture used the shared token, and that alone is why this suite could
   * not see the bug it exists to catch: capture posted to `/rpc/storage`, which
   * only the shared token opens, so it passed here and 401'd every 30 seconds in
   * every real builder session. Capture now goes to `/builder/storage`, which
   * takes this token and refuses the shared one.
   */
  async function writeDaemonConfig(): Promise<string> {
    const token = await mintMcpToken(ctx.root, { kind: 'builder' }, 'builder-testbuilder');
    const port = (await readFile(getWebPortPath(ctx.root), 'utf-8')).trim();
    const path = join(ctx.root, '.lazy', 'tmp', 'daemon-mcp-builder-test.json');
    await mkdir(join(ctx.root, '.lazy', 'tmp'), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({ token, projectRoot: ctx.root, taskId: '', target: `http://127.0.0.1:${port}` }, null, 2),
    );
    await writeBuilderClaudeConfig(home, path, ctx.root);
    return path;
  }

  /** Run the real builder supervisor to completion; returns its exit code + output. */
  async function runSupervisor(
    daemonConfigPath: string,
    extraEnv: Record<string, string> = {},
  ): Promise<{ exitCode: number; stderr: string }> {
    const promptFile = join(ctx.root, '.lazy', 'tmp', 'builder-prompt.txt');
    await writeFile(promptFile, 'You are the builder.');
    const builderConfigPath = join(ctx.root, '.lazy', 'tmp', 'builder-cfg.json');
    await writeFile(
      builderConfigPath,
      JSON.stringify({ host: '127.0.0.1', port: 1, token: 'unused', lazyRoot: ctx.root }),
    );

    const proc = Bun.spawn(
      [
        'bun', 'run', AGENT_ENTRY, 'builder',
        '--system-prompt-file', promptFile,
        '--worktree', ctx.root,
        '--builder-config', builderConfigPath,
        '--daemon-config', daemonConfigPath,
        '--builder-id', 'testbuilder',
      ],
      {
        cwd: ctx.root,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          ...process.env,
          HOME: home,
          // ctx.fakeClaudeBinDir must be on PATH or the supervisor spawns the
          // REAL claude (it is not in process.env.PATH — see TestContext).
          PATH: `${binDir}:${ctx.fakeClaudeBinDir}:${process.env.PATH ?? ''}`,
          // A production builder belongs to no task turn. Whoever runs this
          // suite may — `bun test` under a lazy agent inherits that agent's
          // turn identity, and the MCP server the preflight spawns would then
          // refuse to serve "another task's" tools. See mcp-env.ts.
          ...TURN_IDENTITY_ENV_PINS,
          ...extraEnv,
        },
      },
    );
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    return { exitCode, stderr };
  }

  test('a builder session reaches the store while it is still running', async () => {
    await ctx.setClaudeScenario({
      steps: [
        { kind: 'session-jsonl', sessionId: 'live-sess-1', userText: 'hello builder', assistantText: 'hi human' },
        { kind: 'sleep', ms: 20_000 },
      ],
    });
    const daemonConfigPath = await writeDaemonConfig();
    const running = runSupervisor(daemonConfigPath);

    // The conversation must be in the store BEFORE the session ends — that is
    // what "live capture" means, and it is the safety net for a builder that is
    // killed rather than exiting cleanly.
    await waitFor(
      // `builder list` prints the session id truncated to 8 chars.
      async () => (await ctx.lazy(['builder', 'list'])).stdout.includes('live-ses'),
      45_000,
      'live capture of live-sess-1 while the session is still running',
    );

    await running;
  }, 90_000);

  test('every segment of a finished builder session is captured', async () => {
    await ctx.setClaudeScenario({
      steps: [
        { kind: 'session-jsonl', sessionId: 'seg-a', userText: 'first question', assistantText: 'first answer' },
        // A /clear rolls Claude to a fresh JSONL mid-run — both segments belong
        // to this builder run and both must land in the store.
        { kind: 'session-jsonl', sessionId: 'seg-b', userText: 'second question', assistantText: 'second answer' },
      ],
    });
    const daemonConfigPath = await writeDaemonConfig();
    const { exitCode, stderr } = await runSupervisor(daemonConfigPath);
    expect({ exitCode, stderr }).toMatchObject({ exitCode: 0 });

    const list = await ctx.lazy(['builder', 'list']);
    expect(list.stdout).toContain('seg-a');
    expect(list.stdout).toContain('seg-b');
  }, 90_000);

  // INVARIANT: scratch capture rides the supervisor's capture monitor, not only
  // `lazy scratch sync`. Unit tests call syncScratchDir directly; without this,
  // a missing /builder/storage allowlist entry ships with green tests.
  test('scratch files reach the store on the capture cadence while the session runs', async () => {
    const scratchDir = scratchDirFor(ctx);
    await mkdir(scratchDir, { recursive: true });
    await writeFile(join(scratchDir, 'mid-session.md'), 'builder left this during the run\n');

    await ctx.setClaudeScenario({
      steps: [
        { kind: 'session-jsonl', sessionId: 'scratch-sess', userText: 'hi', assistantText: 'hello' },
        { kind: 'sleep', ms: 5_000 },
      ],
    });
    const daemonConfigPath = await writeDaemonConfig();
    const running = runSupervisor(daemonConfigPath, {
      LAZY_SCRATCH_DIR: scratchDir,
      LAZY_TEST: '1',
      LAZY_FORCE_BUILDER_CAPTURE_INTERVAL_MS: '1000',
    });

    await waitFor(
      async () => {
        const list = await ctx.lazy(['scratch', 'list']);
        return list.stdout.includes('mid-session.md');
      },
      15_000,
      'scratch capture of mid-session.md while the builder supervisor is still running',
    );

    await running;
  }, 60_000);
});
