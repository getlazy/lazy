import { describe, test, expect } from 'bun:test';
import type { ResolvedConfig, RoleTarget } from '../../src/config/types';
import { ANTHROPIC_DEFAULT_TARGET } from '../../src/config/default-target';
import type { Task } from '../../src/types';
import { pairSessionModel, taskLaunchIdentityView } from '../../src/task/launch-identity-view';
import { launchIdentityHtml, taskPageHtml } from '../../src/server/task-page';

const anthropic = (model = ''): RoleTarget => ({ ...ANTHROPIC_DEFAULT_TARGET, model });

/**
 * A ResolvedConfig carrying only what the view reads: the model ladder,
 * `[agent] effort`, and the raw `[agents.<name>]` table.
 */
function configWith(over?: {
  defaultModel?: string;
  effort?: string;
  agents?: Record<string, { harness?: string; model?: string }>;
  agentRole?: RoleTarget;
}): ResolvedConfig {
  return {
    models: {
      default: over?.defaultModel ?? 'claude-opus-5',
      roles: { builder: anthropic(), agent: over?.agentRole ?? anthropic() },
    },
    agents: over?.agents,
    agent: { effort: over?.effort ?? 'medium' },
  } as unknown as ResolvedConfig;
}

function task(over: Partial<Task> = {}): Task {
  return {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    code: 'ui-header-metadata',
    goal: 'Surface agent, model and effort on the header',
    prompt: 'Do the work',
    type: 'task',
    status: 'working',
    created_at: 1,
    completed_at: null,
    target: { kind: 'branch', branch: 'main' },
    branched_from_sha: null,
    close_reason: null,
    model: null,
    agent_id: 'claude-code',
    runner_type: null,
    metadata: null,
    tags: [],
    pending_sync: 0,
    ...over,
  } as Task;
}

describe('taskLaunchIdentityView', () => {
  test('stored agent, model and effort all read as the task\'s own choices', () => {
    const view = taskLaunchIdentityView({
      task: task({ model: 'claude-opus-5', agent_id: 'codex', metadata: { effort: 'xhigh' } }),
      config: configWith({ agents: { codex: { harness: 'codex', model: 'claude-opus-5' } } }),
    });
    expect(view.agent).toEqual({ value: 'codex', source: 'task', note: undefined });
    expect(view.model).toEqual({ value: 'claude-opus-5', source: 'task' });
    expect(view.effort).toEqual({ value: 'xhigh', source: 'task' });
  });

  // INVARIANT: an effective value that came from lazy.toml is reported as a
  // DEFAULT, never as the task's. A header that shows only the winning value
  // cannot be honest about a task that has never recorded one — the effort of an
  // unstarted task is `[agent] effort`, and showing it bare hides that.
  test('unset model and effort resolve to the config values, marked as defaults', () => {
    const view = taskLaunchIdentityView({
      task: task({ model: null, metadata: null }),
      config: configWith({ defaultModel: 'claude-sonnet-5', effort: 'low' }),
    });
    expect(view.model).toEqual({ value: 'claude-sonnet-5', source: 'default' });
    expect(view.effort).toEqual({ value: 'low', source: 'default' });
  });

  test('the project-settings overlay model is reported, still as a default', () => {
    const view = taskLaunchIdentityView({
      task: task({ model: null }),
      config: configWith({ defaultModel: 'claude-sonnet-5' }),
      projectModel: 'claude-opus-5',
    });
    expect(view.model).toEqual({ value: 'claude-opus-5', source: 'default' });
  });

  test('a blank agent_id reports the default profile as a default', () => {
    const view = taskLaunchIdentityView({ task: task({ agent_id: '' }), config: configWith() });
    expect(view.agent.value).toBe('claude-code');
    expect(view.agent.source).toBe('default');
  });

  test('an agent_id no profile defines is shown, with a note saying so', () => {
    const view = taskLaunchIdentityView({
      task: task({ agent_id: 'renamed-profile' }),
      config: configWith(),
    });
    expect(view.agent.value).toBe('renamed-profile');
    expect(view.agent.source).toBe('task');
    expect(view.agent.note).toContain('lazy.toml');
  });

  // INVARIANT: the header shows the model that would actually RUN, resolved
  // by the SAME rule the launch uses (taskModelChoice). Since turn-model
  // stickiness, a stored task model wins even over a profile that pins an
  // endpoint — so the header reports it as the task's, and the pinned profile's
  // model is only what a task with no model yet would run. (This test used to
  // assert the reverse; changed with the engineer's approval, see the task's
  // blocking raise.)
  //
  // The task names NO agent on purpose. `[models.roles.agent]` is the fallback
  // for exactly that case: a task that DID name a profile is resolved against
  // that profile instead, so the role's pinned target would not govern it and
  // this would be asserting the wrong rung. Verified against resolveAgentModel
  // directly — named `claude-code` gives `claude-opus-5`, unnamed gives
  // `qwen3-coder`.
  test('a stored task model wins over a pinned local backend, as it does at launch', () => {
    const view = taskLaunchIdentityView({
      task: task({ model: 'claude-opus-5', agent_id: '' }),
      config: configWith({
        agentRole: {
          profile: 'local-ollama',
          harness: 'claude-code',
          model: 'qwen3-coder',
          endpoint: 'http://host.docker.internal:11434',
          pinned: true,
          wire: 'anthropic',
          credential: 'none',
        },
      }),
    });
    expect(view.model).toEqual({ value: 'claude-opus-5', source: 'task' });
  });
});

// INVARIANT (turn-model stickiness): a pair/chat session pins what the task's
// next turn would run — the persisted model, else the profile default for a
// task that never had one — never the builder role's model, and never nothing.
// `lazy pair` used to pin the builder's model, and the web shell passed raw
// task.model, which is null on a fresh task (and a pi session then refused).
describe('pairSessionModel', () => {
  const config = configWith({
    agents: { 'local-pi': { harness: 'pi', model: 'qwen3.8:latest' } },
  });

  test("a task with a model pairs on it", () => {
    expect(pairSessionModel({ task: task({ agent_id: 'local-pi', model: 'muse-glimmer' }), config }))
      .toBe('muse-glimmer');
  });

  test("a task that has never had a model pairs on its profile's default", () => {
    expect(pairSessionModel({ task: task({ agent_id: 'local-pi', model: null }), config }))
      .toBe('qwen3.8:latest');
  });
});

describe('launchIdentityHtml', () => {
  test('renders profile · model · effort, dimming only the defaults', () => {
    const html = launchIdentityHtml({
      agent: { value: 'codex', source: 'task' },
      model: { value: 'claude-opus-5', source: 'task' },
      effort: { value: 'medium', source: 'default' },
    });
    expect(html).toContain('codex');
    expect(html).toContain('claude-opus-5');
    expect(html).toContain('·');
    expect(html).toContain('title="Agent profile — recorded on this task"');
    expect(html).toContain('title="Effort — from lazy.toml default"');
    // Only the default-sourced item carries the subdued class.
    expect(html.match(/lz-launch-default/g)?.length).toBe(1);
  });

  test('a note lands in the tooltip alongside the provenance', () => {
    const html = launchIdentityHtml({
      agent: { value: 'gone', source: 'task', note: 'no [agents] profile of this name is defined in lazy.toml' },
      model: { value: 'm', source: 'default' },
      effort: { value: 'low', source: 'default' },
    });
    expect(html).toContain('recorded on this task (no [agents] profile');
  });

  // INVARIANT: the stored case says "recorded", never "set"/"chosen"/"pinned".
  // The task record cannot tell a human's `--model` from the value the first
  // launch persisted for itself (resolveTurnLaunchIdentity / resolveAndPersistEffort
  // write both the same way, and agent_id is filled at create time from the
  // project default). Wording that claims intent would assert a choice nobody
  // made on essentially every started task — worse than saying nothing.
  test('the stored tooltip does not claim anyone chose the value', () => {
    const html = launchIdentityHtml({
      agent: { value: 'codex', source: 'task' },
      model: { value: 'claude-opus-5', source: 'task' },
      effort: { value: 'high', source: 'task' },
    });
    expect(html).toContain('recorded on this task');
    for (const claim of ['set on this task', 'chosen', 'selected', 'pinned by']) {
      expect(html).not.toContain(claim);
    }
  });

  // INVARIANT: never invent a value that was not resolved. Config that cannot
  // be read yields no view, and the header then says nothing about what runs
  // the task rather than printing a guess.
  test('no view renders nothing', () => {
    expect(launchIdentityHtml(null)).toBe('');
    expect(launchIdentityHtml(undefined)).toBe('');
  });
});

describe('task page header', () => {
  function page(launchIdentity: Parameters<typeof launchIdentityHtml>[0]): string {
    return taskPageHtml({
      task: task({ model: 'claude-opus-5', metadata: { effort: 'high' } }),
      session: null,
      turns: [],
      commits: [],
      comments: [],
      journal: [],
      raisedItems: [],
      children: [],
      promptVersions: [],
      tab: 'landing',
      launchIdentity,
    });
  }

  test('the identity sits on the header status line', () => {
    const html = page({
      agent: { value: 'codex', source: 'task' },
      model: { value: 'claude-opus-5', source: 'task' },
      effort: { value: 'high', source: 'task' },
    });
    const meta = html.slice(html.indexOf('task-signal-meta'), html.indexOf('</div>', html.indexOf('task-signal-meta')));
    expect(meta).toContain('lz-launch-identity');
    expect(meta).toContain('codex');
    expect(meta).toContain('high');
  });

  // The header is now the one place these three are answered — a Metadata row
  // restating them would be a second, staler answer (it only ever knew the
  // stored value, so an unstarted task showed no model at all).
  test('Metadata no longer carries Agent or Model rows', () => {
    const html = page({
      agent: { value: 'codex', source: 'task' },
      model: { value: 'claude-opus-5', source: 'task' },
      effort: { value: 'high', source: 'task' },
    });
    expect(html).not.toContain('<span class="detail-label">Agent</span>');
    expect(html).not.toContain('<span class="detail-label">Model</span>');
    // What Metadata keeps.
    expect(html).toContain('<span class="detail-label">ID</span>');
    expect(html).toContain('<span class="detail-label">Created</span>');
  });
});
