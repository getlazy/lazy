/**
 * Unit tests for resolveOutstandingViolations — "which protected files does
 * this task still owe a decision on?" — over REAL git repositories.
 *
 * Slice 4 of the final-turn design (docs/design/final-turn.md §14, §4.2): a
 * human-audience parent's wrap-up covers its accepted children's work. An
 * AGENT-audience child's final runs no protected-file push-back, so its
 * protected files were never asked of anyone — they were deferred to the hub's
 * final. A HUMAN-audience child's approvals were decided by a human at that
 * child's accept, so they join the hub's answer and clear the hub's own
 * pending records for the same files.
 *
 * INVARIANT: the scan's path set is the task's DIRECT paths widened by the
 * attributed paths of its agent-audience accepted children — never the
 * unrestricted whole-branch range. A test here going red means the resolver
 * has started scanning children's work wholesale (re-asking hundreds of
 * already-approved files on a release hub) or has dropped the deferral
 * (agent-audience children's protected files silently skip the hub's final).
 *
 * INVARIANT: a warm read costs one `git rev-parse HEAD` and opens no child
 * records — the child-approval union rides the detection cache value, and
 * child contributions are read at cache-fill time only.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { realpath } from 'fs/promises';
import {
  clearOutstandingViolationsCache,
  resolveOutstandingViolations,
} from '../../src/protection/outstanding-resolver';
import { acceptTagName } from '../../src/git/operations';
import type { Session, Task, Turn } from '../../src/types';
import type { StatusChange } from '../../src/storage/types';
import type { Storage } from '../../src/storage/interface';
import { runGit } from '../../src/utils/git';

const HUB_ID = '12345678-aaaa-4bbb-8ccc-dddddddddddd';
const CHILD_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const CHILD_CODE = 'child-a';
/** A second accepted child, for the hub that has one of each audience. */
const SIBLING_ID = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
/** The protected file: pre-existing at the branch point, so a child's EDIT of it violates. */
const PROTECTED_FILE = 'a.spec.ts';

async function git(args: string[], cwd: string): Promise<string> {
  const result = await runGit(args, { cwd });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr}`);
  }
  return result.stdout;
}

function hubTask(): Task {
  // taskRef falls back to shortId — 'hub12345' is stored so the worktree path
  // is deterministic regardless of the id's shape.
  return {
    id: HUB_ID,
    code: 'hub',
    goal: 'hub',
    metadata: { task_ref: 'hub12345' },
    target: { kind: 'branch', branch: '' },
  } as unknown as Task;
}

function childTask(status = 'complete'): Task {
  return { id: CHILD_ID, code: CHILD_CODE, goal: 'child work', status } as unknown as Task;
}

function siblingTask(status = 'complete'): Task {
  return { id: SIBLING_ID, code: 'child-b', goal: 'sibling work', status } as unknown as Task;
}

function turn(fields: Partial<Turn> & { sequence: number }): Turn {
  return {
    id: `turn-${fields.sequence}`,
    role: 'agent',
    content: '',
    timestamp: Date.now(),
    ...fields,
  } as unknown as Turn;
}

/** A child whose launching turn decides its audience, plus optional approval records. */
function childEnvironment(
  audience: 'agent' | 'human',
  approvals: string[] = [],
  child: { id: string; session: string } = { id: CHILD_ID, session: 'sess-child' },
): {
  childSessions: Map<string, string>;
  childTurns: Map<string, Turn[]>;
  childHistory: Map<string, StatusChange[]>;
} {
  return {
    childSessions: new Map([[child.id, child.session]]),
    childTurns: new Map([
      [
        child.session,
        [
          turn({ sequence: 1, role: 'human', actor: audience }),
          ...(approvals.length > 0
            ? [
                turn({
                  sequence: 2,
                  role: 'agent',
                  actor: audience,
                  violations: approvals.map((file) => ({ file, base_sha: '', status: 'approved' as const })),
                }),
              ]
            : []),
        ],
      ],
    ]),
    childHistory: new Map([[child.id, [{ actor: audience } as StatusChange]]]),
  };
}

type ChildEnv = ReturnType<typeof childEnvironment>;

/** One hub carrying several children — each with its own session and audience. */
function childEnvironments(...envs: ChildEnv[]): ChildEnv {
  return {
    childSessions: new Map(envs.flatMap((e) => [...e.childSessions])),
    childTurns: new Map(envs.flatMap((e) => [...e.childTurns])),
    childHistory: new Map(envs.flatMap((e) => [...e.childHistory])),
  };
}

interface FakeStorage {
  storage: Storage;
  sessionTurnCalls: () => number;
}

function storageWith(children: Task[], childEnv?: ReturnType<typeof childEnvironment>): FakeStorage {
  let sessionTurnCalls = 0;
  const storage = {
    getChildTasks: async () => children,
    getSessionByTaskId: async (id: string) =>
      childEnv?.childSessions.get(id) ? ({ id: childEnv.childSessions.get(id) } as unknown as Session) : null,
    getSessionTurns: async (sessionId: string) => {
      sessionTurnCalls++;
      return childEnv?.childTurns.get(sessionId) ?? [];
    },
    getStatusHistory: async (id: string) => childEnv?.childHistory.get(id) ?? [],
  } as unknown as Storage;
  return { storage, sessionTurnCalls: () => sessionTurnCalls };
}

describe('resolveOutstandingViolations (real git)', () => {
  let root: string;
  let worktree: string;

  beforeEach(async () => {
    clearOutstandingViolationsCache();
    root = await realpath(await mkdtemp(join(tmpdir(), 'lazy-outstanding-')));
    await git(['init', '-b', 'main'], root);
    await git(['config', 'user.email', 'test@test.com'], root);
    await git(['config', 'user.name', 'Test'], root);
    // The protected file exists at the branch point — a child MODIFYING it is a
    // violation (a file the child created would be exempt as a pure addition).
    await writeFile(join(root, PROTECTED_FILE), 'original\n');
    await writeFile(join(root, 'README.md'), '# seed\n');
    await git(['add', '.'], root);
    await git(['commit', '-m', 'seed'], root);
    await mkdir(join(root, '.lazy', 'worktrees'), { recursive: true });
    worktree = join(root, '.lazy', 'worktrees', 'hub12345');
    await git(['worktree', 'add', '-b', 'lazy/hub', worktree, 'main'], root);
    await writeFile(join(root, 'lazy.toml'), '[permissions]\nprotected = ["*.spec.ts"]\n');
  });

  afterEach(async () => {
    clearOutstandingViolationsCache();
    await rm(root, { recursive: true, force: true });
  });

  /** Commit an accepted child's squash on the hub branch, optionally tagged. */
  async function commitChildSquash(opts: {
    body?: string;
    subject?: string;
    tag?: boolean;
    childId?: string;
    files?: string[];
  }): Promise<void> {
    const childId = opts.childId ?? CHILD_ID;
    for (const file of opts.files ?? [PROTECTED_FILE]) {
      await writeFile(join(worktree, file), opts.body ?? 'from child\n');
      await git(['add', file], worktree);
    }
    await git(['commit', '-m', opts.subject ?? `Accept task ${childId.substring(0, 8)}: child work`], worktree);
    if (opts.tag !== false) {
      const sha = (await git(['rev-parse', 'HEAD'], worktree)).trim();
      await git(['tag', '-a', '-m', 'accepted', acceptTagName(childId), sha], worktree);
    }
  }

  function buildStorage(env?: ReturnType<typeof childEnvironment>, children?: Task[]): FakeStorage {
    return storageWith(children ?? [childTask()], env);
  }

  async function resolveWith(storage: Storage, turns: Turn[] = []) {
    return resolveOutstandingViolations(
      root,
      hubTask(),
      { upstream_merge_sha: undefined } as unknown as Session,
      turns,
      storage,
    );
  }

  function resolve(env?: ReturnType<typeof childEnvironment>, children?: Task[], turns: Turn[] = []) {
    const { storage, sessionTurnCalls } = buildStorage(env, children);
    return { result: resolveWith(storage, turns), sessionTurnCalls };
  }

  function filesOf(violations: { file: string }[]): string[] {
    return violations.map((v) => v.file).sort();
  }

  // INVARIANT: an agent-audience child's protected files are owed the hub's
  // review — the child's push-back is not a human approval decision.
  // The hub changed nothing itself; only the deferred-child union keeps the
  // scan alive where the pre-slice-4 shortcut would have answered "nothing".
  test('an agent-audience child\'s protected file is asked at the parent', async () => {
    await commitChildSquash({});
    const { result } = resolve(childEnvironment('agent'));
    const state = await result;
    expect(state.degraded).toBe(false);
    expect(filesOf(state.outstanding)).toEqual([PROTECTED_FILE]);
    expect(state.detected).toHaveLength(1);
    expect(state.approved).toEqual([]);
  });

  // INVARIANT (§4.2): an agent-audience child's approval is its agent's answer
  // to its own prompt, not a human decision — it never joins the hub's union.
  test('an agent-audience child\'s approval does not clear the question', async () => {
    await commitChildSquash({});
    const { result } = resolve(childEnvironment('agent', [PROTECTED_FILE]));
    const state = await result;
    expect(filesOf(state.outstanding)).toEqual([PROTECTED_FILE]);
    expect(state.approved).toEqual([]);
  });

  // INVARIANT (§4.2): a human-audience child's approvals were decided by a
  // human at that child's accept — the hub must not re-ask them. With no
  // direct changes of its own and nothing deferred, the narrowed shortcut
  // answers empty while still reporting the child's approval.
  test('a human-audience child\'s approval joins and clears', async () => {
    await commitChildSquash({});
    const { result } = resolve(childEnvironment('human', [PROTECTED_FILE]));
    const state = await result;
    expect(state.degraded).toBe(false);
    expect(state.outstanding).toEqual([]);
    expect(state.approved).toEqual([PROTECTED_FILE]);
    expect(state.detected).toEqual([]);
  });

  test('the narrowed shortcut still fills the cache with the union', async () => {
    await commitChildSquash({});
    const env = childEnvironment('human', [PROTECTED_FILE]);
    const { storage, sessionTurnCalls } = buildStorage(env);
    const first = await resolveWith(storage);
    expect(first.approved).toEqual([PROTECTED_FILE]);
    const fillCalls = sessionTurnCalls();
    expect(fillCalls).toBeGreaterThan(0);

    const again = await resolveWith(storage);
    expect(again).toEqual(first);
    // INVARIANT: a warm read opens no child records — the union rides the
    // detection cache value.
    expect(sessionTurnCalls()).toBe(fillCalls);
  });

  test('a new commit re-fills the cache (child reads happen again)', async () => {
    await commitChildSquash({});
    const env = childEnvironment('agent');
    const { storage, sessionTurnCalls } = buildStorage(env);
    await resolveWith(storage);
    const fillCalls = sessionTurnCalls();
    // HEAD moves → the cache misses → child contributions are read again.
    await writeFile(join(worktree, 'README.md'), '# changed\n');
    await git(['add', 'README.md'], worktree);
    await git(['commit', '-m', 'hub own commit'], worktree);
    const state = await resolveWith(storage);
    expect(sessionTurnCalls()).toBeGreaterThan(fillCalls);
    // The hub's own commit adds README.md to the direct set; the child's
    // deferred file is still asked.
    expect(filesOf(state.outstanding)).toEqual([PROTECTED_FILE]);
  });

  test('no protected patterns: authoritative empty answer with no child reads', async () => {
    await rm(join(root, 'lazy.toml'));
    await commitChildSquash({});
    const env = childEnvironment('agent');
    const { result, sessionTurnCalls } = resolve(env);
    const state = await result;
    expect(state.outstanding).toEqual([]);
    expect(state.approved).toEqual([]);
    expect(state.degraded).toBe(false);
    expect(sessionTurnCalls()).toBe(0);
  });

  // INVARIANT: the degraded records-only answer still honours child approvals.
  // The hub's final push-back writes pending records for child files — those
  // are a question asked, not a decision made, and a human-audience child's
  // approval answers them.
  test('degraded path: parent pending record cleared by a human child\'s approval', async () => {
    await commitChildSquash({});
    // The parent's own push-back recorded the child's file as pending...
    const turns = [
      turn({
        sequence: 1,
        role: 'agent',
        violations: [{ file: PROTECTED_FILE, base_sha: '', status: 'pending' as const }],
      }),
    ];
    const env = childEnvironment('human', [PROTECTED_FILE]);
    // ...and the worktree is gone, so the scan cannot run.
    await rm(worktree, { recursive: true, force: true });
    const { result } = resolve(env, [childTask()], turns);
    const state = await result;
    expect(state.degraded).toBe(true);
    expect(state.outstanding).toEqual([]);
    expect(state.approved).toEqual([PROTECTED_FILE]);
  });

  test('degraded path: an agent child\'s approval does not clear the parent\'s pending record', async () => {
    await commitChildSquash({});
    const turns = [
      turn({
        sequence: 1,
        role: 'agent',
        violations: [{ file: PROTECTED_FILE, base_sha: '', status: 'pending' as const }],
      }),
    ];
    const env = childEnvironment('agent', [PROTECTED_FILE]);
    await rm(worktree, { recursive: true, force: true });
    const { result } = resolve(env, [childTask()], turns);
    const state = await result;
    expect(state.degraded).toBe(true);
    expect(filesOf(state.outstanding)).toEqual([PROTECTED_FILE]);
    expect(state.approved).toEqual([]);
  });

  // INVARIANT: this task's own latest record wins per file. A file the hub
  // itself rejected stays outstanding even when a human-audience child
  // approved it — and is not reported as approved.
  test('own rejected record beats a child approval (scan path)', async () => {
    await commitChildSquash({});
    // The hub's own edit keeps the file in the direct path set, so the scan
    // detects it regardless of the child.
    await writeFile(join(worktree, PROTECTED_FILE), 'hub own edit\n');
    await git(['add', PROTECTED_FILE], worktree);
    await git(['commit', '-m', 'hub edits the file too'], worktree);
    const turns = [
      turn({
        sequence: 1,
        role: 'agent',
        violations: [{ file: PROTECTED_FILE, base_sha: '', status: 'rejected' as const }],
      }),
    ];
    const { result } = resolve(childEnvironment('human', [PROTECTED_FILE]), [childTask()], turns);
    const state = await result;
    expect(state.degraded).toBe(false);
    expect(filesOf(state.outstanding)).toEqual([PROTECTED_FILE]);
    expect(state.approved).toEqual([]);
  });

  // INVARIANT: a child's approval clears only paths the PARENT did not itself
  // change. The human approved the child's edit of this file; the parent then
  // edited the same file on a later turn, and nobody has approved THAT. The
  // parent's own edit is what puts the file back in its direct path set, and
  // that is exactly the signal. Clearing it would narrow the gate silently.
  test('a child approval does not clear a file the parent itself edited afterwards', async () => {
    await commitChildSquash({});
    await writeFile(join(worktree, PROTECTED_FILE), 'hub own edit on a later turn\n');
    await git(['add', PROTECTED_FILE], worktree);
    await git(['commit', '-m', 'hub edits the file too'], worktree);
    // No record of the parent's own: the human was never asked about this edit.
    const { result } = resolve(childEnvironment('human', [PROTECTED_FILE]));
    const state = await result;
    expect(state.degraded).toBe(false);
    expect(filesOf(state.outstanding)).toEqual([PROTECTED_FILE]);
    // And it is not reported approved either — the two surfaces must agree.
    expect(state.approved).toEqual([]);
  });

  // The other direction, unchanged: a path only the child touched is cleared
  // by the child's approval and never re-asked at the parent.
  test('a child-only path stays cleared when the parent changes something else', async () => {
    await commitChildSquash({});
    await writeFile(join(worktree, 'b.spec.ts'), 'parent own protected file\n');
    await git(['add', 'b.spec.ts'], worktree);
    await git(['commit', '-m', 'hub adds its own file'], worktree);
    const { result } = resolve(childEnvironment('human', [PROTECTED_FILE]));
    const state = await result;
    expect(state.degraded).toBe(false);
    // b.spec.ts is a pure addition by the parent, so nothing is detected there;
    // the child's file is cleared by the child's approval.
    expect(state.outstanding).toEqual([]);
    expect(state.approved).toEqual([PROTECTED_FILE]);
  });

  // An unattributed child (no tag, no subject match) is not excluded from the
  // direct set either — its files are inside plan.paths, so the hub is still
  // asked. Show twice, never hide.
  test('an unattributed agent child is still asked via the direct path set', async () => {
    await commitChildSquash({ tag: false, subject: 'unrelated work' });
    const { result } = resolve(childEnvironment('agent'));
    const state = await result;
    expect(state.degraded).toBe(false);
    expect(filesOf(state.outstanding)).toEqual([PROTECTED_FILE]);
  });

  // INVARIANT: a human-audience child's approval answers for ITS edit of the
  // file, not for a sibling's. An agent-audience child's edit of the same path
  // was deferred to this final — never asked of anyone, which is why it widens
  // the scan at all (§14) — and that child's OWN approval does not clear it, so
  // a sibling's must not either. A hub with one child of each audience touching
  // CHANGELOG.md is the ordinary release case, and clearing here would merge an
  // unreviewed protected edit while reporting the file approved.
  test('a sibling\'s approval does not clear an agent-audience child\'s deferred file', async () => {
    await commitChildSquash({ childId: CHILD_ID, body: 'from the agent-audience child\n' });
    await commitChildSquash({ childId: SIBLING_ID, body: 'from the human-audience child\n' });
    const { storage } = buildStorage(
      childEnvironments(
        childEnvironment('agent', [], { id: CHILD_ID, session: 'sess-child' }),
        childEnvironment('human', [PROTECTED_FILE], { id: SIBLING_ID, session: 'sess-sibling' }),
      ),
      [childTask(), siblingTask()],
    );
    const state = await resolveWith(storage);
    expect(state.degraded).toBe(false);
    expect(filesOf(state.outstanding)).toEqual([PROTECTED_FILE]);
    expect(state.approved).toEqual([]);
  });

  // The other direction, so the narrowing is precise rather than wholesale: the
  // same human child's approval of a path NO agent child deferred still counts.
  test('a sibling\'s approval still clears a path no other child deferred', async () => {
    await commitChildSquash({ childId: CHILD_ID, body: 'from the agent-audience child\n' });
    await commitChildSquash({
      childId: SIBLING_ID,
      body: 'from the human-audience child\n',
      files: [PROTECTED_FILE, 'b.spec.ts'],
    });
    const { storage } = buildStorage(
      childEnvironments(
        childEnvironment('agent', [], { id: CHILD_ID, session: 'sess-child' }),
        childEnvironment('human', [PROTECTED_FILE, 'b.spec.ts'], { id: SIBLING_ID, session: 'sess-sibling' }),
      ),
      [childTask(), siblingTask()],
    );
    const state = await resolveWith(storage);
    expect(state.degraded).toBe(false);
    // The deferred path is still asked; the sibling's own file keeps its clear.
    expect(filesOf(state.outstanding)).toEqual([PROTECTED_FILE]);
    expect(state.approved).toEqual(['b.spec.ts']);
  });

  // INVARIANT (deliberate, and the reason the restriction tests `plan.paths`
  // rather than per-child attribution): when a child's accept cannot be
  // attributed, its paths stay in the parent's DIRECT set — `lazy diff` shows
  // them as the parent's own change — and its approvals stop clearing, so the
  // human is asked again. The two answers are the same range on purpose: a
  // file the hub's diff presents as its own work and the gate silently does
  // not ask about is the narrowed-gate failure this whole area exists to
  // prevent. Over-asking costs a reviewer one decision on files they can see;
  // under-asking merges a protected change nobody looked at.
  test('an unattributed human child\'s approval stops clearing (asked again, not hidden)', async () => {
    await commitChildSquash({ tag: false, subject: 'unrelated work' });
    const { result } = resolve(childEnvironment('human', [PROTECTED_FILE]));
    const state = await result;
    expect(state.degraded).toBe(false);
    expect(filesOf(state.outstanding)).toEqual([PROTECTED_FILE]);
    expect(state.approved).toEqual([]);
  });

  // The same child, ATTRIBUTED: its approval clears, and the hub is not
  // re-asked. This is the pair that shows attribution is what moves the answer.
  test('the same child\'s approval clears once its accept can be attributed', async () => {
    await commitChildSquash({});
    const { result } = resolve(childEnvironment('human', [PROTECTED_FILE]));
    const state = await result;
    expect(state.degraded).toBe(false);
    expect(state.outstanding).toEqual([]);
    expect(state.approved).toEqual([PROTECTED_FILE]);
  });

  // A tag that exists but points OUTSIDE the walked range: the seed commit is
  // the walk's merge-base (exclusive), so the tag is not on the first-parent
  // line. Attribution fails — and so does the exclusion, which skips its
  // subject fallback the moment a tag is found — so the child's squash stays
  // in the direct set and the question survives. Show twice, never hide.
  test('a tag pointing outside the walked range still leaves the file asked', async () => {
    await commitChildSquash({ tag: false });
    const seedSha = (await git(['rev-parse', 'main'], root)).trim();
    await git(['tag', '-a', '-m', 'accepted', acceptTagName(CHILD_ID), seedSha], worktree);
    const { result } = resolve(childEnvironment('agent'));
    const state = await result;
    expect(state.degraded).toBe(false);
    expect(filesOf(state.outstanding)).toEqual([PROTECTED_FILE]);
  });

  test('worktree present but HEAD unresolvable degrades to records', async () => {
    // A directory whose .git points at a nonexistent gitdir: pathExists passes,
    // HEAD fails, the plan is never computed. (Neither an empty directory nor a
    // corrupt .git/HEAD is enough — git walks up or falls through to the parent
    // repo and resolves fine.)
    await rm(worktree, { recursive: true, force: true });
    await mkdir(worktree, { recursive: true });
    await writeFile(join(worktree, '.git'), 'gitdir: /nonexistent/nowhere\n');
    const { result } = resolve(childEnvironment('agent'));
    const state = await result;
    expect(state.degraded).toBe(true);
    expect(state.outstanding).toEqual([]);
  });
});
