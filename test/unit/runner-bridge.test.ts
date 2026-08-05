import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat, readlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  seedSandboxFromHost,
  bridgeSessionForRunnerSwitch,
} from '../../src/cli/commands/pair-bridge';
import { encodeProjectPath } from '../../src/import/claude-code-logs';

const SANDBOX_DIR = '.lazy-task-sandbox';
const SID = 'abc12345-0000-0000-0000-000000000000';

describe('cross-runner session bridging', () => {
  let tmp: string;
  let worktree: string;
  let fakeHome: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'lazy-bridge-'));
    worktree = join(tmp, 'worktree');
    fakeHome = join(tmp, 'home');
    await mkdir(worktree, { recursive: true });
    await mkdir(fakeHome, { recursive: true });
    // getHome() prefers $HOME — point it at our sandboxed fake home.
    prevHome = process.env.HOME;
    process.env.HOME = fakeHome;
  });

  afterEach(async () => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    await rm(tmp, { recursive: true, force: true });
  });

  function hostSessionPath(): string {
    return join(fakeHome, '.claude', 'projects', encodeProjectPath(worktree), `${SID}.jsonl`);
  }
  function sandboxSessionPath(): string {
    return join(worktree, SANDBOX_DIR, '.claude', 'projects', encodeProjectPath(worktree), `${SID}.jsonl`);
  }

  async function writeHostSession(content: string): Promise<void> {
    const p = hostSessionPath();
    await mkdir(join(p, '..'), { recursive: true });
    await writeFile(p, content);
  }
  async function writeSandboxSession(content: string): Promise<void> {
    const p = sandboxSessionPath();
    await mkdir(join(p, '..'), { recursive: true });
    await writeFile(p, content);
  }

  // INVARIANT: host → container switch COPIES the real JSONL into the mounted
  // sandbox. A symlink would dangle inside the container's separate mount
  // namespace, so the bridge must materialize a real file.
  test('seedSandboxFromHost copies the host JSONL into the sandbox as a real file', async () => {
    await writeHostSession('{"type":"user"}\n');

    const result = await seedSandboxFromHost(worktree, SID);

    expect(result.seeded).toBe(true);
    const dest = sandboxSessionPath();
    expect(await readFile(dest, 'utf-8')).toBe('{"type":"user"}\n');
    // Must be a real file, not a symlink (would dangle in the container).
    expect((await lstat(dest)).isSymbolicLink()).toBe(false);
  });

  test('seedSandboxFromHost is a no-op when the host session does not exist', async () => {
    const result = await seedSandboxFromHost(worktree, SID);
    expect(result.seeded).toBe(false);
  });

  test('seedSandboxFromHost does not clobber an existing sandbox session', async () => {
    await writeHostSession('HOST\n');
    await writeSandboxSession('SANDBOX-NEWER\n');

    const result = await seedSandboxFromHost(worktree, SID);

    expect(result.seeded).toBe(true);
    // The in-sandbox copy (which the container agent may have appended to) wins.
    expect(await readFile(sandboxSessionPath(), 'utf-8')).toBe('SANDBOX-NEWER\n');
  });

  // INVARIANT: container → host switch reuses bridgeSessionFiles (symlink the
  // sandbox file into the host ~/.claude tree) so host-side `claude --resume`
  // finds it.
  test('bridge container → host makes the sandbox session accessible at host home', async () => {
    await writeSandboxSession('{"type":"user"}\n');

    const result = await bridgeSessionForRunnerSwitch(worktree, SID, 'docker', 'dangerously-host-process-without-any-isolation');

    expect(result.bridged).toBe(true);
    // Reachable at the host projects path (via symlink).
    expect(await readFile(hostSessionPath(), 'utf-8')).toBe('{"type":"user"}\n');
  });

  test('bridge host → container copies into the sandbox', async () => {
    await writeHostSession('{"type":"user"}\n');

    const result = await bridgeSessionForRunnerSwitch(worktree, SID, 'dangerously-host-process-without-any-isolation', 'docker');

    expect(result.bridged).toBe(true);
    expect(await readFile(sandboxSessionPath(), 'utf-8')).toBe('{"type":"user"}\n');
    expect((await lstat(sandboxSessionPath())).isSymbolicLink()).toBe(false);
  });

  test('bridge is a no-op when both runners are on the same side of the boundary', async () => {
    // docker → podman: both containers. No file movement should occur.
    const result = await bridgeSessionForRunnerSwitch(worktree, SID, 'docker', 'podman');
    expect(result.bridged).toBe(false);

    // host → host: also a no-op.
    const result2 = await bridgeSessionForRunnerSwitch(
      worktree,
      SID,
      'dangerously-host-process-without-any-isolation',
      'dangerously-host-process-without-any-isolation',
    );
    expect(result2.bridged).toBe(false);
  });
});
