import { describe, test, expect } from 'bun:test';
import {
  applyFidelitySection,
  wrapFidelitySection,
  composeInitialBody,
  synthesizeFidelityBody,
  regenerateFidelity,
  FIDELITY_BEGIN,
  FIDELITY_END,
} from '../../src/synthesis/fidelity';
import type { Summarizer, SummarizerInput } from '../../src/synthesis/summarizer';
import { GitHubDriver } from '../../src/remote/github-driver';
import type { DriverDeps, GhResult } from '../../src/remote/github-driver';
import type { RepositoryDriver } from '../../src/remote/driver';
import type { Task, Turn, Commit, Comment, Session } from '../../src/types';
import type { Storage } from '../../src/storage';
import type { ResolvedConfig } from '../../src/config/types';

// ---------------------------------------------------------------------------
// Section helpers
// ---------------------------------------------------------------------------

describe('applyFidelitySection', () => {
  // INVARIANT: updateRemoteBody must touch ONLY the lazy-owned delimited
  // section. Human-authored text before/after the markers is the reviewer's
  // and must survive regeneration verbatim.
  test('replaces only the lazy-owned section, preserving human text', () => {
    const body = [
      '## Goal',
      '',
      'human-written goal edits',
      '',
      FIDELITY_BEGIN,
      'stale plan text',
      FIDELITY_END,
      '',
      '## Reviewer notes',
      'please keep this',
    ].join('\n');

    const out = applyFidelitySection(body, 'the work as it actually became');

    expect(out).toContain('human-written goal edits');
    expect(out).toContain('## Reviewer notes');
    expect(out).toContain('please keep this');
    expect(out).toContain('the work as it actually became');
    expect(out).not.toContain('stale plan text');
    // Markers remain so the next regeneration also lands in place.
    expect(out).toContain(FIDELITY_BEGIN);
    expect(out).toContain(FIDELITY_END);
  });

  // INVARIANT: if a human deleted the markers, we must NOT rewrite their
  // description — append a fresh section instead of clobbering.
  test('appends a fresh section when markers are absent', () => {
    const out = applyFidelitySection('purely human description', 'syn');
    expect(out.startsWith('purely human description')).toBe(true);
    expect(out).toContain(wrapFidelitySection('syn'));
  });

  test('is idempotent given the same summary', () => {
    const once = applyFidelitySection(composeInitialBody({ goal: 'g', footer: 'f' }), 'X');
    const twice = applyFidelitySection(once, 'X');
    expect(twice).toBe(once);
  });
});

// ---------------------------------------------------------------------------
// synthesizeFidelityBody — storage gathering + fallback
// ---------------------------------------------------------------------------

function makeTask(overrides?: Partial<Task>): Task {
  return {
    id: 'task1234',
    code: null,
    goal: 'Original goal',
    prompt: 'Original prompt',
    type: 'task',
    status: 'blocked',
    created_at: Date.now(),
    completed_at: null,
    target: { kind: 'branch' as const, branch: 'main' },
    branched_from_sha: null,
    close_reason: null,
    model: null,
    agent_id: 'claude-code',
    metadata: {},
    pending_sync: 0,
    ...overrides,
  };
}

function fakeStorage(parts: {
  turns?: Partial<Turn>[];
  commits?: Partial<Commit>[];
  comments?: Partial<Comment>[];
  children?: Task[];
}): Storage {
  const session: Session = { id: 'sess1', task_id: 'task1234' } as unknown as Session;
  return {
    getSessionByTaskId: async () => session,
    getSessionTurns: async () => (parts.turns ?? []).map((t, i) => ({
      id: `t${i}`, session_id: 'sess1', sequence: i, role: 'agent', content: '', timestamp: i,
      usage: null, start_sha: null, start_sha_work: null, end_sha_work: null, end_sha: null,
      ...t,
    })) as Turn[],
    getSessionCommits: async () => (parts.commits ?? []).map((c, i) => ({
      id: `c${i}`, session_id: 'sess1', sha: `sha${i}`, message: '', status: 'committed', timestamp: i,
      ...c,
    })) as Commit[],
    getTaskComments: async () => (parts.comments ?? []).map((c, i) => ({
      id: `cm${i}`, task_id: 'task1234', content: '', created_at: i, ...c,
    })) as Comment[],
    getChildTasks: async () => parts.children ?? [],
  } as unknown as Storage;
}

const echoSummarizer: Summarizer = {
  async summarize(input: SummarizerInput): Promise<string> {
    return `ECHO:${input.goal}\n${input.bundle}`;
  },
};

const failingSummarizer: Summarizer = {
  async summarize(): Promise<string> {
    throw new Error('no model available');
  },
};

describe('synthesizeFidelityBody', () => {
  test('synthesizes from turns, comments, children, and commits', async () => {
    const storage = fakeStorage({
      turns: [
        { role: 'human', actor: 'human', content: 'change direction: use approach B' },
        { role: 'agent', content: 'reworked to approach B' },
      ],
      comments: [{ content: 'looks good' }],
      commits: [{ message: 'Pivot to approach B\n\ndetails' }],
      children: [makeTask({ id: 'child1', goal: 'child feature', status: 'complete' })],
    });

    const result = await synthesizeFidelityBody(storage, makeTask(), echoSummarizer);
    expect(result.synthesized).toBe(true);
    expect(result.summary).toContain('ECHO:Original goal');
    expect(result.summary).toContain('change direction: use approach B');
    expect(result.summary).toContain('child feature');
    expect(result.summary).toContain('Pivot to approach B');
    // Only the subject line of a commit message is included.
    expect(result.summary).not.toContain('\ndetails');
  });

  // INVARIANT: synthesis is an enhancement, not a gate. A Summarizer failure
  // must yield the deterministic commit-subject fallback, never throw.
  test('falls back to deterministic commit list when the summarizer fails', async () => {
    const storage = fakeStorage({ commits: [{ message: 'Add feature X' }, { message: 'Fix Y' }] });
    const result = await synthesizeFidelityBody(storage, makeTask(), failingSummarizer);
    expect(result.synthesized).toBe(false);
    expect(result.summary).toContain('Add feature X');
    expect(result.summary).toContain('Fix Y');
  });
});

// ---------------------------------------------------------------------------
// regenerateFidelity — orchestration
// ---------------------------------------------------------------------------

function fakeDriver(overrides: Partial<RepositoryDriver>): RepositoryDriver {
  return {
    needsSync: true,
    hasRemoteRef: () => true,
    updateRemoteBody: async () => {},
    ...overrides,
  } as unknown as RepositoryDriver;
}

describe('regenerateFidelity', () => {
  test('updates the remote body and returns a fidelityBody when synthesis succeeds', async () => {
    const storage = fakeStorage({ commits: [{ message: 'work' }] });
    let updatedWith: string | undefined;
    const driver = fakeDriver({ updateRemoteBody: async (_t, s) => { updatedWith = s; } });

    const result = await regenerateFidelity(storage, makeTask(), driver, echoSummarizer);
    expect(result.fidelityBody).toContain('ECHO:Original goal');
    expect(updatedWith).toContain('ECHO:Original goal');
    expect(result.warning).toBeUndefined();
  });

  // INVARIANT: on synthesis failure we must NOT push a remote body update and
  // must NOT supply a squash fidelityBody — the caller falls back to its
  // deterministic default. This keeps "synthesis failure" strictly separate
  // from "remote write failure".
  test('does not touch the remote body when synthesis fails', async () => {
    const storage = fakeStorage({ commits: [{ message: 'work' }] });
    let called = false;
    const driver = fakeDriver({ updateRemoteBody: async () => { called = true; } });

    const result = await regenerateFidelity(storage, makeTask(), driver, failingSummarizer);
    expect(called).toBe(false);
    expect(result.fidelityBody).toBeUndefined();
  });

  // A remote WRITE failure is surfaced as a warning but never thrown — the
  // accept/push must proceed.
  test('returns a warning (does not throw) when the remote write fails', async () => {
    const storage = fakeStorage({ commits: [{ message: 'work' }] });
    const driver = fakeDriver({ updateRemoteBody: async () => { throw new Error('gh down'); } });

    const result = await regenerateFidelity(storage, makeTask(), driver, echoSummarizer);
    expect(result.warning).toContain('gh down');
    // Still returns the synthesized body for the local squash path.
    expect(result.fidelityBody).toContain('ECHO:Original goal');
  });

  test('skips remote write for non-hosted drivers but still returns fidelityBody', async () => {
    const storage = fakeStorage({ commits: [{ message: 'work' }] });
    let called = false;
    const driver = fakeDriver({ needsSync: false, updateRemoteBody: async () => { called = true; } });

    const result = await regenerateFidelity(storage, makeTask(), driver, echoSummarizer);
    expect(called).toBe(false);
    expect(result.fidelityBody).toContain('ECHO:Original goal');
  });
});

// ---------------------------------------------------------------------------
// GitHubDriver.updateRemoteBody
// ---------------------------------------------------------------------------

const mockConfig: ResolvedConfig = {
  models: { default: 'claude-sonnet-4-5-20250929', roles: { builder: { backend: 'anthropic', model: '', endpoint: '' }, agent: { backend: 'anthropic', model: '', endpoint: '' } } },
  session: { verbose: false, debug: false, auto_commit_instructions: false },
  data: { path: '/tmp/test/.lazy' },
  storage: { backend: 'external', external_path: '', postgres_ssl: false },
  git: { default_branch_prefix: 'lazy' },
  output: { shortid_length: 8 },
  agent: { agent_id: 'test-agent', watchdog_output_timeout_ms: 0, graceful_exit_timeout_ms: 0, effort: 'medium' },
  builder: { effort: 'high' },
  chattiness: { default: '', builder: '', agent: '' },
  server: { port: 3000, sync_interval: 1000, bind: '127.0.0.1' },
  remote: {
    driver: 'github',
    git_remote: 'origin',
    auto_approve: false,
    offline: false,
    github_auto_push: true,
    github_dangerously_sync_comments_in_public_repos_and_open_yourself_to_prompt_injection: false,
    gitlab_auto_push: true,
    gitlab_dangerously_sync_comments_in_public_repos_and_open_yourself_to_prompt_injection: false,
  },
  docker: { dockerfile: '' },
  runner: { type: 'docker' as const },
  documents: { path: '' },
  features: {},
  worktree: { include: [] },
  permissions: { protected: [] },
  automation: { maintain: [] },
  mounts: [],
  checks: { post_turn: '', post_turn_timeout: 300 },
  ollama: { enabled: false, model: '', endpoint: 'http://host.docker.internal:11434' },
  daemon: {
    auto_react_ci: true,
    auto_react_comments: true,
    auto_react_max_retries: 3,
    auto_react_backoff: 'exponential' as const,
    auto_react_daily_budget: 50,
    max_auto_turns: 3,
  },
};

const ok = (stdout = ''): GhResult => ({ stdout, stderr: '', exitCode: 0 });
const fail = (stderr = 'error'): GhResult => ({ stdout: '', stderr, exitCode: 1 });

describe('GitHubDriver.updateRemoteBody', () => {
  test('edits only the lazy section of the live PR body', async () => {
    const liveBody = [
      '## Goal',
      '',
      'reviewer added this line',
      '',
      FIDELITY_BEGIN,
      'frozen plan',
      FIDELITY_END,
    ].join('\n');

    let editedBody: string | undefined;
    const deps: DriverDeps = {
      runGh: async (args) => {
        if (args[0] === 'pr' && args[1] === 'view') return ok(JSON.stringify({ body: liveBody }));
        if (args[0] === 'pr' && args[1] === 'edit') {
          editedBody = args[args.indexOf('--body') + 1];
          return ok();
        }
        return fail('unexpected gh call');
      },
      runGit: async () => ok(),
    };

    const task = makeTask({ metadata: { github_remote_ref_id: '7' } });
    const driver = new GitHubDriver(mockConfig, deps);
    await driver.updateRemoteBody(task, 'the real story');

    expect(editedBody).toBeDefined();
    expect(editedBody).toContain('reviewer added this line');
    expect(editedBody).toContain('the real story');
    expect(editedBody).not.toContain('frozen plan');
  });

  test('skips the edit when the body section is unchanged', async () => {
    const liveBody = wrapFidelitySection('same');
    let editCalled = false;
    const deps: DriverDeps = {
      runGh: async (args) => {
        if (args[0] === 'pr' && args[1] === 'view') return ok(JSON.stringify({ body: liveBody }));
        if (args[0] === 'pr' && args[1] === 'edit') { editCalled = true; return ok(); }
        return fail('unexpected gh call');
      },
      runGit: async () => ok(),
    };
    const task = makeTask({ metadata: { github_remote_ref_id: '7' } });
    const driver = new GitHubDriver(mockConfig, deps);
    await driver.updateRemoteBody(task, 'same');
    expect(editCalled).toBe(false);
  });

  test('is a no-op when the task has no PR', async () => {
    let anyCall = false;
    const deps: DriverDeps = {
      runGh: async () => { anyCall = true; return ok(); },
      runGit: async () => ok(),
    };
    const driver = new GitHubDriver(mockConfig, deps);
    await driver.updateRemoteBody(makeTask({ metadata: {} }), 'x');
    expect(anyCall).toBe(false);
  });

  // INVARIANT: updateRemoteBody is a remote WRITE — it fails hard (throws) so
  // the caller can decide. (regenerateFidelity is the layer that downgrades
  // this to a non-blocking warning on the accept/push path.)
  test('throws when gh pr view fails', async () => {
    const deps: DriverDeps = {
      runGh: async (args) => (args[1] === 'view' ? fail('HTTP 401') : ok()),
      runGit: async () => ok(),
    };
    const task = makeTask({ metadata: { github_remote_ref_id: '7' } });
    const driver = new GitHubDriver(mockConfig, deps);
    await expect(driver.updateRemoteBody(task, 'x')).rejects.toThrow(/gh pr view failed/);
  });
});
