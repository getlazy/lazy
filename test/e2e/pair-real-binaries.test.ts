/**
 * Pair's and Chat's interactive argv against the REAL agent binaries the runner
 * image installs — not the fakes. Opt-in (`LAZY_REAL_BINARY_TESTS=1`): it needs
 * the image's codex / cursor-agent / pi on PATH and tmux as the terminal (the
 * TUIs query the terminal and stall under a bare pty; the image has no tmux, so
 * `sudo apt-get install -y tmux` first). No model is ever reached: the provider
 * points at a closed port and no credential is real.
 *
 *   LAZY_REAL_BINARY_TESTS=1 bun test test/e2e/pair-real-binaries.test.ts
 */
import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getAgent } from '../../src/agent/registry';
import { interactiveChatArgs } from '../../src/agent/interactive-modes';

const TIMEOUT_MS = 180_000;
// A live codex TUI: its main screen, or a first-run announcement it shows over it.
const CODEX_TUI = /OpenAI Codex|\^c quit/;
const has = (bin: string): boolean => Bun.spawnSync(['sh', '-c', `command -v ${bin}`]).exitCode === 0;
const optedIn = process.env.LAZY_REAL_BINARY_TESTS === '1';
if (!optedIn) console.log('[skip] pair-real-binaries: set LAZY_REAL_BINARY_TESTS=1 (needs tmux and the image agent binaries)');

const root = mkdtempSync(join(tmpdir(), 'pair-real-'));
const socket = join(root, 'tmux.sock');
afterAll(() => {
  Bun.spawnSync(['tmux', '-S', socket, 'kill-server']);
  rmSync(root, { recursive: true, force: true });
});

// The child sees no ambient LAZY_* variable.
function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('LAZY_')) env[k] = v;
  return { ...env, ...extra };
}

const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
const tmux = (...args: string[]) => Bun.spawnSync(['tmux', '-S', socket, ...args], { env: cleanEnv({}) });
const capture = (name: string): string => tmux('capture-pane', '-p', '-t', name).stdout.toString();

/** Start argv in a detached tmux pane; the launch's own variables ride `-e`, never the server's environment. */
async function startPane(argv: string[], env: Record<string, string>, cwd: string, waitMs = 8000): Promise<string> {
  const name = `p${Math.random().toString(36).slice(2, 8)}`;
  const vars = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  const cmd = `${argv.map(shq).join(' ')}; echo LAZY_PANE_EXIT=$?; sleep 60`;
  expect(tmux('new-session', '-d', '-x', '160', '-y', '40', '-s', name, '-c', cwd, ...vars, cmd).exitCode).toBe(0);
  await Bun.sleep(waitMs);
  return name;
}

/** Type a line into the pane: literal text, then Enter on its own. */
async function typeLine(name: string, text: string, waitMs = 10_000): Promise<void> {
  tmux('send-keys', '-t', name, '-l', text);
  await Bun.sleep(500);
  tmux('send-keys', '-t', name, 'Enter');
  await Bun.sleep(waitMs);
}

/**
 * Exit codex the way a person does and return the pane: Ctrl-C quits a first-run
 * announcement at once, the main screen needs a second one.
 */
async function exitCodex(name: string): Promise<string> {
  tmux('send-keys', '-t', name, 'C-c');
  await Bun.sleep(2000);
  if (!capture(name).includes('LAZY_PANE_EXIT=')) {
    tmux('send-keys', '-t', name, 'C-c');
    await Bun.sleep(3000);
  }
  const pane = capture(name);
  tmux('kill-session', '-t', name);
  return pane;
}

/** Start argv and return the pane once it shows `expected` or exits (at most 30s). */
async function paneText(argv: string[], env: Record<string, string>, cwd: string, expected: string): Promise<string> {
  const name = await startPane(argv, env, cwd, 1000);
  const deadline = Date.now() + 30_000;
  let pane = capture(name);
  while (!pane.includes(expected) && !pane.includes('LAZY_PANE_EXIT=') && Date.now() < deadline) {
    await Bun.sleep(500);
    pane = capture(name);
  }
  // Let a binary that refuses its argv after drawing get the chance to exit.
  await Bun.sleep(2000);
  pane = capture(name);
  tmux('kill-session', '-t', name);
  return pane;
}

function rollouts(home: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: import('fs').Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; /* no sessions dir yet */ }
    for (const e of entries) {
      if (e.isDirectory()) walk(join(dir, e.name));
      else if (e.name.startsWith('rollout-')) out.push(join(dir, e.name));
    }
  };
  walk(join(home, 'sessions'));
  return out;
}

describe.skipIf(!optedIn)('pair against the real binaries', () => {
  const work = join(root, 'work');
  Bun.spawnSync(['mkdir', '-p', work]);
  Bun.spawnSync(['git', 'init', '-q', work]);

  // Opted in without tmux must fail, not skip: three skips read as a pass.
  test('tmux is available', () => {
    if (!has('tmux')) throw new Error('LAZY_REAL_BINARY_TESTS=1 needs tmux: sudo apt-get install -y tmux');
  });

  // INVARIANT: Pair's Codex argv starts the real interactive codex, fresh and
  // resuming a thread, and the resumed session records into that thread's
  // rollout. Release 20 shipped an argv the real binary refused ("no complete
  // local package") while the fake accepted it.
  test('codex: fresh session starts; resume records into the thread and exits cleanly', async () => {
    console.log(`[pair-real-binaries] ${Bun.spawnSync(['codex', '--version']).stdout.toString().trim()}`);
    const home = join(root, 'codex-home');
    Bun.spawnSync(['mkdir', '-p', home]);
    writeFileSync(join(home, 'config.toml'), [
      'model_provider = "lazy"',
      '[model_providers.lazy]',
      'name = "lazy"',
      'base_url = "http://127.0.0.1:9/v1"',
      'env_key = "OPENAI_API_KEY"',
      'wire_api = "responses"',
      `[projects.${JSON.stringify(work)}]`,
      'trust_level = "trusted"',
      '',
    ].join('\n'));
    const env = { CODEX_HOME: home, OPENAI_API_KEY: 'not-a-key' };
    const codex = getAgent('codex');

    const fresh = await startPane(codex.buildInteractiveArgs({ modelId: 'gpt-5.5', dangerouslySkipPermissions: true })!, env, work);
    const freshPane = capture(fresh);
    expect(freshPane).not.toContain('no complete local package');
    expect(freshPane).not.toContain('LAZY_PANE_EXIT=');
    expect(freshPane).toMatch(CODEX_TUI);
    expect(await exitCodex(fresh)).toContain('LAZY_PANE_EXIT=0');

    // A thread to resume: exec records one even though the model is unreachable.
    const exec = Bun.spawnSync(['codex', 'exec', '--json', '--skip-git-repo-check', 'hi'], { cwd: work, env: cleanEnv(env), stdin: 'ignore', timeout: 60_000 });
    const thread = /"thread_id":"([^"]+)"/.exec(exec.stdout.toString())?.[1];
    expect(thread).toBeTruthy();
    const rollout = rollouts(home).find((f) => f.includes(thread!));
    expect(rollout).toBeTruthy();

    const resumed = await startPane(codex.buildInteractiveArgs({ sessionId: thread!, modelId: 'gpt-5.5', dangerouslySkipPermissions: false })!, env, work);
    const resumedPane = capture(resumed);
    expect(resumedPane).not.toContain('no complete local package');
    expect(resumedPane).not.toContain('No saved session');
    expect(resumedPane).not.toContain('LAZY_PANE_EXIT=');
    expect(resumedPane).toMatch(CODEX_TUI);
    if (capture(resumed).includes('Use existing model')) {
      // Codex's first-run model announcement: "2" keeps the session's model.
      tmux('send-keys', '-t', resumed, '2');
      await Bun.sleep(2000);
    }
    // The thread's earlier prompt is on screen: this is that conversation.
    expect(capture(resumed)).toContain('› hi');
    await typeLine(resumed, 'pair-marker-7f3a', 1000);
    // Codex writes the turn once it ends; here it ends after its retries fail.
    const deadline = Date.now() + 60_000;
    while (!readFileSync(rollout!, 'utf8').includes('pair-marker-7f3a') && Date.now() < deadline) await Bun.sleep(1000);
    expect(readFileSync(rollout!, 'utf8')).toContain('pair-marker-7f3a');
    expect(await exitCodex(resumed)).toContain('LAZY_PANE_EXIT=0');
  }, TIMEOUT_MS);

  // INVARIANT: the real cursor-agent accepts Pair's argv, the member session's
  // (no --trust) and Chat's (--exclude-tools, a hidden flag), fresh and
  // resuming. It stops at its own login screen here, having no credential.
  test('cursor: pair, member and chat argv are accepted', async () => {
    const cursor = getAgent('cursor');
    for (const sessionId of [null, 'thread-1']) {
      const pair = cursor.buildInteractiveArgs({ sessionId, modelId: 'auto', dangerouslySkipPermissions: true })!;
      const chat = [...cursor.buildInteractiveArgs({ sessionId, modelId: 'auto', dangerouslySkipPermissions: false })!, ...interactiveChatArgs('cursor')];
      for (const argv of [pair, pair.filter((a) => a !== '--trust'), chat, chat.filter((a) => a !== '--trust')]) {
        const pane = await paneText(argv, {}, work, 'Cursor Agent');
        expect(pane).not.toContain('LAZY_PANE_EXIT=');
        expect(pane).toContain('Cursor Agent');
      }
    }
  }, TIMEOUT_MS * 2);

  // INVARIANT: the real pi starts its TUI with Pair's and Chat's argv, fresh and resuming.
  test('pi: pair and chat TUI start', async () => {
    const pi = getAgent('pi');
    for (const sessionId of [null, 'thread-1']) {
      const pair = pi.buildInteractiveArgs({ sessionId, modelId: 'anthropic/claude-sonnet-5-5', dangerouslySkipPermissions: true })!;
      const chat = [...pi.buildInteractiveArgs({ sessionId, modelId: 'anthropic/claude-sonnet-5-5', dangerouslySkipPermissions: false })!, ...interactiveChatArgs('pi')];
      for (const argv of [pair, chat]) {
        const pane = await paneText(argv, { ANTHROPIC_API_KEY: 'not-a-key' }, work, 'ctrl+c/ctrl+d clear/exit');
        expect(pane).not.toContain('LAZY_PANE_EXIT=');
        expect(pane).toContain('ctrl+c/ctrl+d clear/exit');
      }
    }
  }, TIMEOUT_MS);
});
