/** Real smolvm supervisor launch, with only the machine and Engine API faked. */
import { chmod, mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { DEFAULT_CONFIG } from '../../src/config/loader';
import { ANTHROPIC_DEFAULT_TARGET } from '../../src/config/default-target';
import { createSmolvmRunner, closeSmolvmRelaysForTests } from '../../src/runner/smolvm-runner';
import { ClaudeCodeAgent } from '../../src/agent/claude-code';
import { soloMachineName } from '../../src/vm/smolvm-project-machine';
import { hardwareTestEnv } from './hardware-env';
import type { DialedProcess } from '../../src/vm/docker-relay';

const [root, protocolBase, docker] = process.argv.slice(2) as [string, string, string];
const children: DialedProcess[] = [];
try {
  const worktree = join(root, '.lazy', 'worktrees', 'handoff');
  const git = Bun.spawn(['git', 'worktree', 'add', '-b', 'lazy/handoff', worktree], { cwd: root, stdout: 'pipe', stderr: 'pipe', timeout: 10_000 });
  const [err, code] = await Promise.all([new Response(git.stderr).text(), git.exited]);
  if (code !== 0) throw new Error(`fixture worktree failed: ${err}`);
  const sandboxPath = join(worktree, '.lazy-task-sandbox');
  await mkdir(sandboxPath);
  const mcpDir = join(root, 'private-mcp');
  await mkdir(mcpDir, { mode: 0o700 });
  const configPath = join(mcpDir, 'daemon-mcp-lazy-handoff.json');
  await writeFile(configPath, '{"token":"fixture-only"}', { mode: 0o600 });
  await chmod(configPath, 0o600);
  const config = structuredClone(DEFAULT_CONFIG);
  config.runner.type = 'smolvm';
  config.smolvm.binary = '/fixture/smolvm';
  config.smolvm.image = join(root, 'image.tar');
  await writeFile(config.smolvm.image, 'fake image');
  let state = 'absent';
  const runner = await createSmolvmRunner(root, config, {
    stateRoot: join(root, 'state'), socketRoot: '/tmp', dockerCli: docker,
    verifyBinary: async path => path,
    cli: () => async args => {
      if (args[1] === 'ls') return { exitCode: 0, stdout: JSON.stringify(state === 'absent' ? [] : [{ name: soloMachineName(root), state }]), stderr: '' };
      if (args[1] === 'create') state = 'stopped';
      if (args[1] === 'start') state = 'running';
      return { exitCode: 0, stdout: 'lazy-agent ok', stderr: '' };
    },
    dial: () => () => {
      const child = Bun.spawn([process.execPath, join(import.meta.dir, 'docker-relay-engine.ts'), 'launch', join(root, 'launch.json')], {
        env: hardwareTestEnv(), stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', timeout: 30_000,
      }) as unknown as DialedProcess;
      children.push(child);
      return child;
    },
    shareInputs: async () => ({ projectRoot: root, gitCommonDir: join(root, '.git'), protocolProjectDir: root,
      agentBinDir: root, mcpConfigDir: mcpDir, oneshotDir: root, mounts: [], runArgSources: [] }),
  });
  runner.setAgent(new ClaudeCodeAgent(), 'claude-code');
  // This fixture never makes a model request or borrows a real credential.
  runner.setAgentTarget({ ...ANTHROPIC_DEFAULT_TARGET, credential: 'none' });
  const protocol = join(protocolBase, 'handoff');
  await mkdir(protocol, { recursive: true });
  await runner.launchSupervisor({ worktreePath: worktree, sandboxPath }, 'lazy-handoff', protocol, false, configPath, undefined, undefined, 'fixture-image');
  console.log(await readFile(join(root, 'launch.json'), 'utf8'));
} finally {
  for (const child of children) child.kill();
  await Promise.all(children.map(child => child.exited));
  await closeSmolvmRelaysForTests();
}
