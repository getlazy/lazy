/** Real wrapper + supervisor + scripted agent; only the agent is fake.
 * Also runs in Docker when a test image is available. The same entrypoint is
 * used by solo, Teams local-docker, and Docker inside the Teams microVM.
 * Tests set their own one-minute timeout; setup and cleanup allow two minutes.
 * No command-line --timeout override is needed.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'fs/promises';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { FileStorage } from '../../src/storage';
import { DockerRunner } from '../../src/runner/docker-runner';
import { removeTaskRun } from '../../src/runner/session-launch';
import { environmentReplacedPrefix } from '../../src/task/environment-replaced';
import { STOP_TASK_AGENT_SCRIPT } from '../../src/runner/stop-task-agent';
import { buildSupervisorWrapperScript } from '../../src/capture/claude';
import { consumeResponse, readResponse, writeCommand } from '../../src/protocol/io';
import { PROTOCOL_VERSION } from '../../src/protocol/types';
import { readClaudeInvocations, installFakeClaude, setClaudeScenario, crashScenario, successScenario, goSilentScenario } from '../helpers/fake-claude';
import { hardwareTestEnv } from '../helpers/hardware-env';
import type { DaemonMcpConfigFile } from '../../src/daemon/mcp-proxy';

const repo = resolve(import.meta.dir, '../..');
const binary = process.env.LAZY_TEST_CONTAINER_BINARY ?? 'docker';
const image = process.env.LAZY_TEST_GIT_IMAGE ?? 'lazy-runner:latest';
// Docker resolves its selected context through the host HOME/.docker. Only
// the supervisor gets a private HOME; probes and runtime commands share this env.
const hostEnv = hardwareTestEnv();
const dockerAvailable = (() => {
  try { return Bun.spawnSync([binary, 'image', 'inspect', image], { env: hostEnv, stdout: 'ignore', stderr: 'ignore' }).exitCode === 0; }
  catch { return false; /* The explicit skip below reports a missing runtime. */ }
})();
if (!dockerAvailable) console.log(`[skip] container-outlives-failed-turns Docker checks: no ${binary} with image ${image}`);

const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

for (const inDocker of [false, true]) {
  describe.skipIf(inDocker && !dockerAvailable)(inDocker ? 'real task container' : 'task entrypoint on local shell', () => {
    let root: string;
    let proto: string;
    let worktree: string;
    let fake: Awaited<ReturnType<typeof installFakeClaude>>;
    let wrapper: ReturnType<typeof Bun.spawn> | null;
    let containerName: string;
    let supervisorEnv: Record<string, string | undefined>;

    async function run(argv: string[]): Promise<string> {
      const proc = Bun.spawn(argv, { env: hostEnv, stdout: 'pipe', stderr: 'pipe' });
      const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      if (code !== 0) throw new Error(`${argv[0]} ${argv[1]} failed (${code}): ${err}`);
      return out.trim();
    }
    async function until<T>(read: () => Promise<T> | T, ready: (v: T) => boolean, timeout = 30_000): Promise<T> {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        const value = await read();
        if (ready(value)) return value;
        await Bun.sleep(50);
      }
      throw new Error(`Timed out waiting for entrypoint; logs: ${await readFile(join(root, 'wrapper.log'), 'utf8').catch(String)}`);
    }
    async function runningId(): Promise<string> {
      if (!inDocker) { process.kill(wrapper!.pid, 0); return String(wrapper!.pid); }
      return run([binary, 'inspect', '--format', '{{.Id}} {{.State.Running}}', containerName]);
    }
    async function outsideFile(): Promise<string> {
      return inDocker ? run([binary, 'exec', containerName, 'cat', '/tmp/valuable-state']) : readFile(join(root, 'valuable-state'), 'utf8');
    }
    function command(id: string, version = PROTOCOL_VERSION, timeout = 0) {
      writeCommand(proto, {
        type: 'ask', task_id: 'container-lifetime-task', goal: 'Keep the environment', prompt: 'Read the project',
        command_id: id, protocol_version: version, agent_id: 'claude-code', model_id: 'claude-sonnet-5-5',
        watchdog_output_timeout_ms: timeout,
      });
    }
    async function answer(id: string) {
      return until(() => readResponse(proto), r => !!r && 'command_id' in r && r.command_id === id);
    }

    async function launchDocker() {
      await run([binary, 'run', '-d', '--name', containerName,
        '--user', `${process.getuid!()}:${process.getgid!()}`,
        '-v', `${repo}:${repo}:ro`, '-v', `${root}:${root}`,
        // The published runner installs Bun for Pi under /home/user/.bun/bin;
        // lazy-dev's custom image also exposes it system-wide. Keep both.
        '-e', `HOME=${supervisorEnv.HOME}`, '-e', `PATH=${fake.binDir}:/usr/local/bin:/home/user/.bun/bin:/usr/bin:/bin`,
        '-e', `LAZY_DAEMON_CONFIG=${supervisorEnv.LAZY_DAEMON_CONFIG}`,
        '-e', `LAZY_TEST_AGENT_HOME=${supervisorEnv.LAZY_TEST_AGENT_HOME}`,
        image, 'sh', '-c', `exec >> ${quote(join(root, 'wrapper.log'))} 2>&1\n${buildSupervisorWrapperScript(proto, worktree)}`]);
    }

    beforeEach(async () => {
      root = await realpath(await mkdtemp(join(tmpdir(), 'lazy-container-lifetime-')));
      proto = join(root, 'protocol'); worktree = join(root, 'worktree');
      containerName = `lazy-lifetime-${process.pid}-${Date.now()}`;
      wrapper = null;
      await Promise.all([mkdir(proto), mkdir(worktree), mkdir(join(root, 'home'))]);
      fake = await installFakeClaude(join(root, 'fake'));
      if (inDocker) {
        // The host Bun may be a macOS executable at a different path. Use the
        // test image's own Linux runtime for the fake and the real supervisor.
        const fakePath = join(fake.binDir, 'claude');
        await writeFile(fakePath, (await readFile(fakePath, 'utf8')).replace(/^#![^\n]+/, '#!/usr/bin/env bun'));
      }
      // The fake never calls MCP, but the real supervisor must register its
      // tools. Supply the same config shape on the host and inside Docker;
      // never borrow the outer task's daemon, token, config or turn identity.
      const daemonConfig = join(root, 'daemon-mcp.json');
      await writeFile(daemonConfig, JSON.stringify({
        target: 'http://127.0.0.1:1', token: 'container-lifetime-fixture', projectRoot: worktree, taskId: '',
      } satisfies DaemonMcpConfigFile));
      supervisorEnv = hardwareTestEnv({
        HOME: join(root, 'home'), LAZY_TEST_AGENT_HOME: join(root, 'home'),
        PATH: `${fake.binDir}:${process.env.PATH}`,
        LAZY_DAEMON_CONFIG: daemonConfig,
        LAZY_TEST_PARENT_PID: String(process.pid), LAZY_ALLOW_HOST_RUNNER: '1',
      }, hostEnv);
      const main = join(root, 'main');
      await mkdir(main);
      await run(['git', '-C', main, 'init', '-q']);
      await run(['git', '-C', main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-qm', 'base']);
      await rm(worktree, { recursive: true });
      await run(['git', '-C', main, 'worktree', 'add', '-qb', 'task', worktree]);
      // The real binary's source entrypoint, never a supervisor/module mock.
      const agent = join(fake.binDir, 'lazy-agent');
      await writeFile(agent, `#!/bin/sh\nexec ${inDocker ? 'bun' : quote(process.execPath)} ${quote(join(repo, 'src/agent-entry.ts'))} "$@"\n`);
      await chmod(agent, 0o755);
      const log = Bun.file(join(root, 'wrapper.log'));
      const script = buildSupervisorWrapperScript(proto, worktree);
      if (inDocker) {
        await launchDocker();
        await run([binary, 'exec', containerName, 'sh', '-c', 'echo precious > /tmp/valuable-state; sleep 300 </dev/null >/dev/null 2>&1 & echo $! > /tmp/valuable-process']);
      } else {
        await writeFile(join(root, 'valuable-state'), 'precious');
        wrapper = Bun.spawn(['sh', '-c', script], { env: supervisorEnv, stdout: log, stderr: log });
      }
    }, 120_000);
    afterEach(async () => {
      if (inDocker) await run([binary, 'rm', '-f', containerName]);
      else if (wrapper) { wrapper.kill('SIGTERM'); await wrapper.exited; }
      if (!inDocker) {
        for (const file of ['hook.pid', 'hook-service.pid']) {
          const pid = await readFile(join(root, file), 'utf8').catch(err => {
            if (err.code === 'ENOENT') return '';
            throw err;
          });
          if (pid.trim()) {
            try { process.kill(Number(pid), 'SIGKILL'); } catch (err) {
              if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
            }
          }
        }
        for (const invocation of await readClaudeInvocations(fake)) {
          try { process.kill(invocation.pid, 'SIGKILL'); } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
          }
        }
      }
      await rm(root, { recursive: true, force: true });
    }, 120_000);

    for (const hook of ['pre_turn_hook', 'post_turn_check'] as const) {
      for (const stop of [false, true]) {
        // INVARIANT: the current hook belongs to its turn just like the harness.
        // Recovery and Stop end it before publishing failure, without sweeping
        // services, so it cannot keep writing alongside the next turn.
        test(`${stop ? 'Stop' : 'supervisor crash'} ends the real ${hook} and preserves services`, async () => {
          const firstId = await runningId();
          const marker = join(root, 'hook-writes');
          await setClaudeScenario(fake, successScenario());
          writeCommand(proto, {
            type: 'start', task_id: 'container-lifetime-task', goal: 'Keep the environment', prompt: 'Do the work',
            command_id: 'hook-turn', protocol_version: PROTOCOL_VERSION,
            agent_id: 'claude-code', model_id: 'claude-sonnet-5-5',
            [hook]: `trap '' TERM; echo $$ > ${quote(join(root, 'hook.pid'))}; ` +
              `sleep 300 </dev/null >/dev/null 2>&1 & echo $! > ${quote(join(root, 'hook-service.pid'))}; ` +
              `while :; do echo writing >> ${quote(marker)}; sleep 0.05; done`,
          });
          await until(() => readFile(marker, 'utf8').catch(() => ''), text => text.length > 0);
          const pid = Number(await readFile(join(proto, 'supervisor.pid'), 'utf8'));
          if (stop) {
            const argv = ['sh', '-c', STOP_TASK_AGENT_SCRIPT, 'stop-task-agent', proto];
            await run(inDocker ? [binary, 'exec', containerName, ...argv] : argv);
          } else if (inDocker) await run([binary, 'exec', containerName, 'kill', '-KILL', String(pid)]);
          else process.kill(pid, 'SIGKILL');
          expect((await answer('hook-turn'))?.status).toBe('error');
          const writesAtFailure = await readFile(marker, 'utf8');
          consumeResponse(proto);
          command('after-hook');
          expect((await answer('after-hook'))?.status).toBe('completed');
          expect(await readFile(marker, 'utf8')).toBe(writesAtFailure);
          const service = (await readFile(join(root, 'hook-service.pid'), 'utf8')).trim();
          await run(inDocker ? [binary, 'exec', containerName, 'kill', '-0', service] : ['kill', '-0', service]);
          expect(await runningId()).toBe(firstId);
          expect((await outsideFile()).trim()).toBe('precious');
        }, 60_000);
      }
    }

    // INVARIANT: an external container death is explained BEFORE launch removes
    // its runtime record. The new container must deliver that fact to its agent.
    test.skipIf(!inDocker)('an externally killed environment is replaced with its exit evidence on the task', async () => {
      const storage = new FileStorage(root, { basePath: join(root, 'store') });
      await storage.initialize();
      try {
        const task = await storage.createTask('Explain the replacement');
        const session = await storage.createSession(task.id, 'claude-code', 'task', 'base');
        await storage.updateSessionContainerName(session.id, containerName, 'claude-code');
        const original = await runningId();
        await run([binary, 'kill', containerName]);
        const runner = new DockerRunner(binary);
        await removeTaskRun(runner, storage, (await storage.getSessionByTaskId(task.id))!, containerName);
        const notice = await environmentReplacedPrefix(storage, task.id);
        expect(notice).toContain('code 137');
        expect(notice).toContain('not OOM-killed');
        expect((await storage.getTaskJournal(task.id))[0].content).toContain('code 137');
        await launchDocker();
        expect(await runningId()).not.toBe(original);
        await setClaudeScenario(fake, successScenario());
        writeCommand(proto, {
          type: 'ask', task_id: task.id, goal: task.goal, prompt: notice + 'Read the project',
          command_id: 'replacement', protocol_version: PROTOCOL_VERSION,
          agent_id: 'claude-code', model_id: 'claude-sonnet-5-5',
        });
        expect((await answer('replacement'))?.status).toBe('completed');
        expect((await readClaudeInvocations(fake)).some(i => i.stdin?.includes('Your environment was replaced'))).toBe(true);
      } finally {
        await storage.close();
      }
    }, 60_000);

    // INVARIANT: a stopped turn cannot start from the mailbox during crash
    // backoff. Stop must cancel it and leave this same environment reusable.
    test('Stop during backoff cancels the queued turn and preserves the environment', async () => {
      const firstId = await runningId();
      await setClaudeScenario(fake, crashScenario({ stderr: 'Invalid API key', exitCode: 1 }));
      command('failed');
      expect((await answer('failed'))?.status).toBe('error');
      await until(() => readFile(join(root, 'wrapper.log'), 'utf8'), log => log.includes('retrying in 1s'));
      consumeResponse(proto);
      await setClaudeScenario(fake, goSilentScenario({ silentMs: 60_000 }));
      command('cancelled');
      const argv = ['sh', '-c', STOP_TASK_AGENT_SCRIPT, 'stop-task-agent', proto];
      if (inDocker) await run([binary, 'exec', containerName, ...argv]);
      else await run(argv);
      expect(await Bun.file(join(proto, 'command.json')).exists()).toBe(false);
      expect(await runningId()).toBe(firstId);
      expect((await outsideFile()).trim()).toBe('precious');
      await setClaudeScenario(fake, successScenario());
      command('next');
      expect((await answer('next'))?.status).toBe('completed');
      expect(await readClaudeInvocations(fake)).toHaveLength(2);
      expect(await runningId()).toBe(firstId);
    }, 60_000);

    for (const failure of ['fatal agent error', 'watchdog', 'protocol mismatch', 'supervisor killed', 'stop agent']) {
      // INVARIANT: a failed turn owns only its agent. A second turn must use the
      // same live environment, including state outside the worktree.
      test(`${failure} keeps the environment and the next turn reuses it`, async () => {
        const firstId = await runningId();
        if (failure === 'fatal agent error') await setClaudeScenario(fake, crashScenario({ stderr: 'Invalid API key', exitCode: 1 }));
        else await setClaudeScenario(fake, goSilentScenario({ silentMs: 60_000 }));
        command('failed', failure === 'protocol mismatch' ? PROTOCOL_VERSION + 1 : PROTOCOL_VERSION, failure === 'watchdog' ? 200 : 0);
        if (failure === 'supervisor killed' || failure === 'stop agent') {
          await until(() => readFile(join(proto, 'supervisor.pid'), 'utf8').catch(() => ''), p => p.trim().length > 0);
          await until(() => Bun.file(join(proto, 'command.json')).exists(), exists => !exists);
          // Wait until a harness actually exists; killing during startup alone
          // would miss the orphan-agent case this regression must exercise.
          await until(() => readClaudeInvocations(fake), invocations => invocations.length > 0);
          const pid = Number(await readFile(join(proto, 'supervisor.pid'), 'utf8'));
          if (failure === 'stop agent') {
            const argv = ['sh', '-c', STOP_TASK_AGENT_SCRIPT, 'stop-task-agent', proto];
            if (inDocker) await run([binary, 'exec', containerName, ...argv]);
            else await run(argv);
          } else if (inDocker) await run([binary, 'exec', containerName, 'kill', '-KILL', String(pid)]);
          else process.kill(pid, 'SIGKILL');
        }
        const failed = await answer('failed');
        expect(failed?.status).toBe('error');
        expect(await runningId()).toBe(firstId);
        expect((await outsideFile()).trim()).toBe('precious');
        if (inDocker) await run([binary, 'exec', containerName, 'sh', '-c', 'kill -0 "$(cat /tmp/valuable-process)"']);
        consumeResponse(proto);
        await setClaudeScenario(fake, successScenario({ result: 'The environment is intact.' }));
        command('next');
        const next = await answer('next');
        expect(next?.status, JSON.stringify(next) + await readFile(join(root, 'wrapper.log'), 'utf8')).toBe('completed');
        expect(await runningId()).toBe(firstId);
        expect((await outsideFile()).trim()).toBe('precious');
      }, 60_000);
    }
  });
}
