/**
 * SECURITY INVARIANT (fix-cursor-security-musts §3): PAIRING NEVER IMPORTS
 * CONTAINER-WRITTEN AGENT STATE ONTO THE HOST.
 *
 * `lazy pair` used to `cp -r` `<worktree>/.lazy-task-sandbox/.cursor/projects`
 * into the host's real `~/.cursor/projects`. That directory is written entirely
 * by the untrusted in-container agent, and `--autonomous` then resumed the
 * copied transcript with `cursor-agent --force` — approvals off AND the agent's
 * own sandbox off. Agent-authored chat history became a prompt-injection channel
 * into a host session running as the human with their credentials.
 *
 * The rule is absolute: nothing under ~/.cursor or ~/.claude is copied,
 * clobbered, overwritten, or merged by pairing. When a container-written session
 * cannot be resumed on the host, pairing says so and starts fresh.
 *
 * THE ONE PERMITTED HOST-HOME WRITE is `bridgeSessionFiles` (pair-bridge.ts) for
 * the Claude branch, and it is permitted only because of the properties asserted
 * below: it creates SYMLINKS ONLY (no content lands on the host), it is purely
 * ADDITIVE (an existing host entry is never replaced), it is namespaced to the
 * task worktree's encoded path, and every link it makes is removed at session
 * end. Without it, `claude --resume` cannot find a container session at all.
 *
 * Do not relax any of this. Weakening a security property is a review with the
 * human, not a test edit.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { readFileSync, mkdirSync, writeFileSync, rmSync, mkdtempSync, lstatSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { bridgeSessionFiles } from '../../src/cli/commands/pair-bridge';
import { encodeProjectPath } from '../../src/import/claude-code-logs';

const PAIR_SRC = readFileSync(join(import.meta.dir, '../../src/cli/commands/pair.ts'), 'utf-8');

/** Source with comments stripped — the prose explains the removed code by name. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(line => !line.trim().startsWith('//'))
    .join('\n');
}

describe('pair never writes agent state into host home config dirs', () => {
  const pairCode = code(PAIR_SRC);

  test('pair.ts imports no recursive/file copy primitive', () => {
    // `cp` from fs/promises is what performed the sandbox→host import.
    expect(pairCode).not.toMatch(/\b(cp|cpSync|copyFile|copyFileSync)\s*\(/);
    expect(pairCode).not.toMatch(/from\s+'fs\/promises'/);
  });

  test('pair.ts never constructs a path into the host ~/.cursor tree', () => {
    expect(pairCode).not.toMatch(/getHome\(\)[^\n]*\.cursor/);
    expect(pairCode).not.toContain('.cursor');
  });

  // The agent branch launches `cursor-agent` (and any future non-Claude CLI)
  // over a session whose earlier turns an agent wrote. --force there disables
  // approvals AND the CLI's own sandbox; --autonomous never asked for that.
  test('pair never passes --force to a non-Claude agent CLI', () => {
    expect(pairCode).not.toContain('--force');
  });

  // The strongest form of "no sandbox→host import": there is no non-Claude
  // interactive launch path left in pair.ts at all. `pairWithTaskAgent` — which
  // held the sandbox-state detection, the best-effort resume of an
  // agent-written session, and the --autonomous caveat — was deleted outright
  // once cursor stopped opting in, rather than left unreachable.
  test('pair.ts has no generic non-Claude agent launch path', () => {
    expect(pairCode).not.toContain('pairWithTaskAgent');
    // The gate refuses by capability, never by hardcoding an agent id.
    expect(pairCode).toContain('supportsPairing()');
  });

  // Scoped to commandPair's own body on purpose. Whole-file indices would prove
  // nothing: the helpers are DEFINED above commandPair, so their text sorts
  // before the gate even though they only RUN after it. Source position is not
  // execution order — this test asserts the order of statements in the one
  // function that decides whether pairing happens.
  test('the pairing gate refuses BEFORE any lock, status change, or launch', () => {
    const body = pairCode.slice(pairCode.indexOf('export async function commandPair'));
    expect(body.length).toBeGreaterThan(0);

    const gateAt = body.indexOf('supportsPairing()');
    expect(gateAt).toBeGreaterThan(-1);

    // Everything that takes the pairing lock, moves the task INTO `pairing`, or
    // hands the terminal to an agent must come after the refusal: a task whose
    // agent does not opt in must never reach `pairing` status or spawn anything.
    // (The earlier `'pairing'` mentions in commandPair are the stuck-state
    // RECOVERY path, which moves pairing → blocked — hence matching on the
    // specific transition rather than the bare status string.)
    for (const after of [
      'acquirePairingLock(',
      "updateTaskStatus(task.id, 'pairing'",
      'runInteractiveSupervisor(',
    ]) {
      const at = body.indexOf(after);
      expect(at).toBeGreaterThan(-1);
      expect(at).toBeGreaterThan(gateAt);
    }
  });
});

describe('the one permitted host-home write is symlink-only and additive', () => {
  let tempDir: string;
  let fakeHome: string;
  let worktreePath: string;
  let sandboxProjectDir: string;
  let hostProjectDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'lazy-pair-host-writes-'));
    fakeHome = join(tempDir, 'home');
    worktreePath = join(tempDir, 'worktree');
    mkdirSync(fakeHome, { recursive: true });
    mkdirSync(worktreePath, { recursive: true });
    const encoded = encodeProjectPath(worktreePath);
    sandboxProjectDir = join(worktreePath, '.lazy-task-sandbox', '.claude', 'projects', encoded);
    hostProjectDir = join(fakeHome, '.claude', 'projects', encoded);
    mkdirSync(sandboxProjectDir, { recursive: true });
    originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('no sandbox CONTENT is ever copied onto the host — links only, removed on cleanup', () => {
    writeFileSync(join(sandboxProjectDir, 'sess-1.jsonl'), '{"agent":"wrote this"}\n');

    const bridge = bridgeSessionFiles(worktreePath, 'sess-1');
    expect(bridge.accessible).toBe(true);

    // Every host entry the bridge produced is a symlink — no bytes were copied,
    // so nothing on the host survives the sandbox going away.
    const linkStat = lstatSync(hostProjectDir);
    expect(linkStat.isSymbolicLink()).toBe(true);

    bridge.cleanup();
    expect(existsSync(hostProjectDir)).toBe(false);
  });

  test('an existing host session file is never replaced or merged', () => {
    // The human's own host-side session, plus a same-named one written by the
    // container agent. The host copy must win, untouched.
    mkdirSync(hostProjectDir, { recursive: true });
    writeFileSync(join(hostProjectDir, 'sess-1.jsonl'), 'HOST ORIGINAL\n');
    writeFileSync(join(sandboxProjectDir, 'sess-1.jsonl'), 'SANDBOX AGENT WROTE THIS\n');
    writeFileSync(join(sandboxProjectDir, 'sess-2.jsonl'), '{"other":true}\n');

    const bridge = bridgeSessionFiles(worktreePath, 'sess-1');

    expect(readFileSync(join(hostProjectDir, 'sess-1.jsonl'), 'utf-8')).toBe('HOST ORIGINAL\n');
    expect(lstatSync(join(hostProjectDir, 'sess-1.jsonl')).isSymbolicLink()).toBe(false);

    // The additive entries it did make are symlinks, and they go away again.
    for (const entry of readdirSync(hostProjectDir)) {
      const st = lstatSync(join(hostProjectDir, entry));
      expect(st.isSymbolicLink() || entry === 'sess-1.jsonl').toBe(true);
    }
    bridge.cleanup();
    expect(readFileSync(join(hostProjectDir, 'sess-1.jsonl'), 'utf-8')).toBe('HOST ORIGINAL\n');
    expect(existsSync(join(hostProjectDir, 'sess-2.jsonl'))).toBe(false);
  });

  test('no config file is touched — writes stay inside ~/.claude/projects/<encoded worktree>', () => {
    // The user's real config lives beside the projects dir. Bridging must be
    // invisible to it: these are the files item 2 protects from clobbering,
    // and the bridge has no business writing them at all.
    mkdirSync(join(fakeHome, '.claude'), { recursive: true });
    writeFileSync(join(fakeHome, '.claude.json'), '{"mcpServers":{"mine":{}}}\n');
    writeFileSync(join(fakeHome, '.claude', 'settings.json'), '{"permissions":{"allow":["Bash"]}}\n');
    writeFileSync(join(sandboxProjectDir, 'sess-1.jsonl'), '{"agent":"wrote this"}\n');

    const bridge = bridgeSessionFiles(worktreePath, 'sess-1');
    expect(bridge.accessible).toBe(true);

    expect(readFileSync(join(fakeHome, '.claude.json'), 'utf-8')).toBe('{"mcpServers":{"mine":{}}}\n');
    expect(readFileSync(join(fakeHome, '.claude', 'settings.json'), 'utf-8'))
      .toBe('{"permissions":{"allow":["Bash"]}}\n');

    // ~/.cursor is not this code path's business under any circumstances.
    expect(existsSync(join(fakeHome, '.cursor'))).toBe(false);

    // Everything it did create sits under the worktree-keyed projects dir.
    expect(readdirSync(join(fakeHome, '.claude', 'projects')))
      .toEqual([encodeProjectPath(worktreePath)]);
    bridge.cleanup();
  });

  test('a REAL host project dir is never removed — only a dangling symlink is', () => {
    // The dangling-symlink cleanup path must not generalise into deleting a
    // directory that holds the human's own sessions.
    mkdirSync(hostProjectDir, { recursive: true });
    writeFileSync(join(hostProjectDir, 'human-session.jsonl'), 'HUMAN\n');
    writeFileSync(join(sandboxProjectDir, 'sess-1.jsonl'), '{"agent":true}\n');

    const bridge = bridgeSessionFiles(worktreePath, 'sess-1');

    expect(lstatSync(hostProjectDir).isDirectory()).toBe(true);
    expect(readFileSync(join(hostProjectDir, 'human-session.jsonl'), 'utf-8')).toBe('HUMAN\n');

    bridge.cleanup();
    // Cleanup removed only lazy's links; the human's dir and file remain.
    expect(readFileSync(join(hostProjectDir, 'human-session.jsonl'), 'utf-8')).toBe('HUMAN\n');
  });
});
