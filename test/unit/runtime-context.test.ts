import { ClaudeCodeAgent } from '../../src/agent/claude-code';
import { CursorAgent } from '../../src/agent/cursor';
import { CodexAgent } from '../../src/agent/codex';
import { PiAgent } from '../../src/agent/pi';
import { QaAgent } from '../../src/agent/qa-agent';
import { buildMergeAgentArgs } from '../../src/supervisor/merge';
import type { Command } from '../../src/protocol';
import { expect, test } from 'bun:test';
import { appendRuntimeContext, daemonRuntimeFacts, withRuntimeContext, type RuntimeFacts } from '../../src/runtime-context';
import type { RunnerType } from '../../src/config/types';
import { commonCommandFields } from '../../src/protocol';
import { DEFAULT_CONFIG } from '../../src/config/loader';

const solo: RuntimeFacts = {
  managed: false, backend: null, daemonPlatform: 'darwin', daemonArch: 'arm64',
  version: '1.2.3', team: null, project: null, teamsUrl: null,
};
const teams = (backend: string): RuntimeFacts => ({
  ...solo, managed: true, backend, daemonPlatform: 'linux',
  team: 'Acme', project: 'Example', teamsUrl: 'https://teams.example',
});

// INVARIANT: generated deployment facts survive custom prompts on every surface.
// Otherwise a customized builder forgets Teams and prescribes laptop commands.
for (const [name, facts, runner, expected] of [
  ['solo Docker', solo, 'docker', 'repository mounted read-only'],
  ['solo host process', solo, 'dangerously-host-process-without-any-isolation', 'Host process; permission mode'],
  ['Teams microVM', teams('microvm'), 'docker', 'project microVM'],
  ['Teams local Docker', teams('local-docker'), 'docker', 'shared dockerd'],
] as const) {
  test(name, () => {
    const prompt = appendRuntimeContext('My customized system prompt', {
      facts, runner: runner as RunnerType, audience: 'builder', scratch: '/scratch',
      dashboardUrl: 'http://lazy.localhost:26025',
    });
    expect(prompt).toStartWith('My customized system prompt');
    expect(prompt).toContain('## Where you are');
    expect(prompt.toLowerCase()).toContain(expected.toLowerCase());
    expect(prompt).toContain(facts.daemonPlatform + '/' + facts.daemonArch);
    expect(prompt).toContain('1.2.3');
    expect(prompt).toContain('/scratch');
    expect(prompt).not.toContain('{{');
    if (facts.managed) {
      expect(prompt).toContain('Acme');
      expect(prompt).toContain('Example');
      expect(prompt).toContain('https://teams.example');
      expect(prompt).toContain('machine you cannot see');
      expect(prompt).not.toContain('lazy.localhost');
    }
  });
}

test('unknown deployment and platform facts stay unknown', () => {
  const prompt = appendRuntimeContext('custom', { runner: 'docker', audience: 'builder' });
  expect(prompt).toContain('daemon deployment facts unavailable');
  expect(prompt).toContain('runner OS/architecture unknown');
  expect(prompt).not.toContain('solo lazy');
});

test('daemon facts use only the fleet deployment settings', () => {
  const f = daemonRuntimeFacts({ LAZY_MANAGED: '1', LAZY_MANAGED_BACKEND: 'microvm', LAZY_MANAGED_TEAM: 'Acme' });
  expect(f.managed).toBe(true);
  expect(f.backend).toBe('microvm');
  expect(f.team).toBe('Acme');
  expect(f.project).toBeNull();
  expect(f.teamsUrl).toBeNull();
});

test('task commands carry context even without a system prompt', () => {
  const fields = commonCommandFields(DEFAULT_CONFIG);
  expect(fields.runtime_context).toContain('## Where you are');
  expect(fields.runtime_context).toContain('No builder scratch access');
});

// INVARIANT: work, automatic resumes, ask and review all receive the same section
// before harness dispatch, even when no other system prompt was sent.
for (const type of ['start', 'unblock', 'ask', 'review'] as const) {
  test(type + ' receives deployment context independently of its system prompt', () => {
    for (const custom of [undefined, 'Custom instructions']) {
      const command = { type, runtime_context: 'Generated deployment facts', system_prompt: custom } as Command;
      const result = withRuntimeContext(command);
      expect('system_prompt' in result && result.system_prompt).toBe(custom ? custom + '\n\nGenerated deployment facts' : 'Generated deployment facts');
      expect("system_prompt" in command && command.system_prompt).toBe(custom);
    }
  });
}

// INVARIANT: no harness drops generated context, including conflict resolution.
for (const agent of [new ClaudeCodeAgent(), new CursorAgent(), new CodexAgent(), new PiAgent(), new QaAgent()]) {
  test(agent.id + ' carries context in work and merge invocations', () => {
    const context = appendRuntimeContext('Custom system instructions', { facts: teams('microvm'), runner: 'docker', audience: 'task' });
    const work = agent.buildExecArgs({ prompt: 'work', systemPrompt: context, modelId: 'test-model', dangerouslySkipPermissions: true });
    const merge = buildMergeAgentArgs(agent, 'merge', 'test-model', undefined, false, undefined, undefined, context);
    for (const args of [work, merge]) {
      const sent = [...args, args.stdinInput ?? '', args.systemPromptInput ?? ''].join('\n');
      expect(sent).toContain('Custom system instructions');
      expect(sent).toContain('## Where you are');
      expect(sent).toContain('Acme');
    }
  });
}

// INVARIANT: human scratch access does not determine the container mount path.
// Managed review builders use the daemon path; detached builders use a fixed mount.
test('managed headless and detached builders advertise their actual scratch mounts', async () => {
  const assembly = await Bun.file('src/builder/system-prompt.ts').text();
  const review = await Bun.file('src/daemon/review-session-builder-turn.ts').text();
  const detached = await Bun.file('src/daemon/builder-sessions.ts').text();
  expect(assembly).toContain('scratch: opts.scratchDir ?? builderScratchDir(opts.lazyRoot)');
  expect(review).toContain("scratchAccess: isManagedMode() ? 'store' : 'host'");
  expect(review).not.toContain('scratchDir: BUILDER_CONTAINER_PATHS');
  expect(detached).toContain('scratchDir: BUILDER_CONTAINER_PATHS.scratchDir');
  const prompt = appendRuntimeContext('custom', { facts: teams('microvm'), runner: 'docker', audience: 'builder', scratch: '/project/scratch' });
  expect(prompt).toContain('/project/scratch');
  expect(prompt).not.toContain('/lazy-builder/scratch');
});

// INVARIANT: standalone sync does not use commonCommandFields, but its conflict
// resolver still needs the same deployment facts as ordinary task turns.
test('standalone sync producer sends generated context to conflict resolution', async () => {
  const source = await Bun.file('src/daemon/task-lifecycle.ts').text();
  const producer = source.slice(source.indexOf('const syncCommand: SyncCommand = {'));
  expect(producer.slice(0, producer.indexOf('\n      };'))).toContain('runtime_context: taskRuntimeContext(runner.type)');
  const { taskRuntimeContext } = await import('../../src/protocol');
  expect(taskRuntimeContext('docker')).toContain('## Where you are');
});

// INVARIANT: the resolved task runner overrides the project default for every
// launch, so host-process tasks are never described as Docker containers.
test('task runner override controls context and is supplied by every producer', async () => {
  const host = commonCommandFields(DEFAULT_CONFIG, { runner: 'dangerously-host-process-without-any-isolation' }).runtime_context;
  expect(host).toContain('Runner: host process');
  const docker = commonCommandFields({ ...DEFAULT_CONFIG, runner: { ...DEFAULT_CONFIG.runner, type: 'dangerously-host-process-without-any-isolation' } }, { runner: 'docker' }).runtime_context;
  expect(docker).toContain('runner OS/architecture unknown');
  for (const path of ['src/daemon/task-lifecycle.ts', 'src/daemon/task-launcher.ts', 'src/utils/auto-resume.ts', 'src/daemon/auto-deliver.ts']) {
    const source = await Bun.file(path).text();
    const calls = [...source.matchAll(/\.\.\.commonCommandFields\([^\n]+/g)];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call[0]).toContain('runner: runner.type');
  }
});

// INVARIANT: access guidance follows the runner, not the task type or Teams label.
// A cluster has task mounts; a builder sees the data-directory overlay instead.
for (const facts of [solo, teams('microvm'), teams('local-docker')]) {
  for (const audience of ['builder', 'task'] as const) {
    for (const runner of ['docker', 'podman', 'dangerously-host-process-without-any-isolation'] as const) {
      test(`${facts.managed ? facts.backend : 'solo'} ${audience} ${runner} file access`, () => {
        const prompt = appendRuntimeContext('custom', { facts, audience, runner, scratch: '/scratch', dataDir: '/project/.lazy' });
        expect(prompt.match(/## Where you are/g)).toHaveLength(1);
        expect(prompt).toContain('git show <sha>:<path>');
        expect(prompt).toContain('git grep -n <pattern> <sha>');
        expect(prompt).toContain('git diff <base-sha>..<sha>');
        if (runner === 'dangerously-host-process-without-any-isolation' && audience === 'builder') {
          expect(prompt).toContain('lazy show <task> --json');
          expect(prompt).toContain('lazy diff <task> --full');
          expect(prompt).toContain('lazy accept <task>');
          expect(prompt).not.toContain('`lazy_diff`');
          expect(prompt).not.toContain('`lazy_accept`');
        } else {
          expect(prompt).toContain('`lazy_show`');
          expect(prompt).toContain('narrowed with `files`');
          expect(prompt).toContain('`lazy_accept`');
          expect(prompt).not.toContain('lazy diff <task> --full');
        }
        expect(prompt).toContain('Export only when');
        expect(prompt).toContain('no uncommitted edits');
        expect(prompt).toContain('git metadata');
        expect(prompt).not.toContain('{{');
        if (runner !== 'dangerously-host-process-without-any-isolation' && audience === 'task') {
          expect(prompt).toContain('including your children’s');
          expect(prompt).toContain('are hidden');
          expect(prompt).toContain('your own task worktree mounted writable');
          expect(prompt).toContain('reflective turns must leave your worktree unchanged');
        } else if (runner !== 'dangerously-host-process-without-any-isolation') {
          expect(prompt).toContain('writable lazy data-directory overlay at /project/.lazy');
          expect(prompt).toContain('Task worktrees beneath that directory are visible');
          expect(prompt).toContain('Run checks needing writes in a disposable export');
        } else {
          expect(prompt).toContain('No container mount');
          expect(prompt).not.toContain('are hidden');
          expect(prompt).toContain('sandbox');
        }
      });
    }
  }
}

// INVARIANT: clusters can inspect selected files without exporting a whole tree.
// Report-first review saves context but must not steer inspection into an archive.
test('cluster review points to targeted reads and the generated access section', async () => {
  const prompt = await Bun.file('src/prompts/cluster-constraints.md').text();
  expect(prompt).toContain('Use `lazy_diff` with `files`');
  expect(prompt).toContain('git show <sha>:<path>');
  expect(prompt).toContain('neither requires an export');
});
