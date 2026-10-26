import { afterEach, expect, test } from 'bun:test';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { hardwareTestEnv } from '../helpers/hardware-env';
import { makeDaemonBaseDir, pinDaemonBaseDir, removeDaemonBaseDir } from '../helpers/daemon-base-dir';

let ctx: TestContext | undefined;
let daemonBase: string | undefined;
let unpin: (() => void) | undefined;
let priorConfig: string | undefined;

afterEach(async () => {
  try {
    await ctx?.cleanup();
  } finally {
    if (priorConfig === undefined) delete process.env.LAZY_CONFIG;
    else process.env.LAZY_CONFIG = priorConfig;
    unpin?.();
    if (daemonBase) await removeDaemonBaseDir(daemonBase);
  }
});

// INVARIANT: the hardware fixture's environment reaches init, both CLI paths,
// and daemon restarts. Any ambient merge would re-adopt the outer task's config.
test('a hardware environment stays isolated throughout the test context', async () => {
  priorConfig = process.env.LAZY_CONFIG;
  daemonBase = await makeDaemonBaseDir();
  unpin = pinDaemonBaseDir(daemonBase);
  const inheritedEnv = hardwareTestEnv({ LAZY_DAEMON_BASE_DIR: daemonBase });
  process.env.LAZY_CONFIG = join(daemonBase, 'outer-task-config-that-does-not-exist.toml');
  ctx = await setupTestLazy({ withDaemon: true, inheritedEnv });
  const create = await ctx.lazy(['create', '--goal', 'hardware-env-fixture']);
  expect(create.exitCode, create.stdout + create.stderr).toBe(0);
  await ctx.restartDaemon();
  for (const result of [await ctx.lazy(['list']), await ctx.lazyMocked(['list'], { result: 'unused', session_id: 'unused' })]) {
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('hardware-env-fixture');
  }
});
