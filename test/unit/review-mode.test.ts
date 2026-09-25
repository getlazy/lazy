/**
 * Unit tests for which review mode a task is in.
 *
 * The decision these pin (engineer, 2026-09-21, reversing the 2026-09-19
 * "human time first, tokens second" default):
 *
 *   "The performance per token is just down the drain. We proclaimed that
 *    human's time is most important, but if we spend so many tokens that we
 *    have to keep pausing, which leads to hours of empty waiting, then we
 *    aren't advancing. Money is also limited, same as time, same as attention.
 *    Low-high should be the default option if reviewing is enabled: less token
 *    usage and less re-reading of what is already in context. Fast first,
 *    ponderously slow as an optimization on quality."
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  DEFAULT_REVIEW_GATE,
  DEFAULT_REVIEW_MODE,
  REVIEW_GATES,
  REVIEW_MODES,
  isReviewMode,
  parseReviewMode,
  resolveReviewMode,
  reviewDispatchOf,
  reviewGateApplies,
  reviewModeFromLegacyMetadata,
  reviewOverrideMetadata,
  reviewSettingsMetadata,
  parseReviewGate,
  parseReviewToggle,
  resolveReviewSettings,
  resolveReviewSettingsWithSources,
  reviewSettingsChosenBy,
  reviewSettingsExplanations,
  reviewSettingsResolutionOf,
  reviewSourcesMetadata,
  reviewExplanationLine,
  encodeReviewSource,
  parseReviewSource,
  type ReviewModeMetadataLike,
  type ReviewSettings,
} from '../../src/review/mode';
import { loadConfig } from '../../src/config/loader';
import { enableInProcessTestMode } from '../helpers/in-process-test-mode';
import { pinConfig } from '../helpers/pin-config';

enableInProcessTestMode();

describe('the mode vocabulary', () => {
  // INVARIANT: the default is the FAST one. See the decision in the header —
  // the slow default did not merely cost more, it stopped the work: a cluster
  // under it hit the org spend limit twice and landed 2 of 13 children in four
  // hours.
  test('the default is low_high', () => {
    expect(DEFAULT_REVIEW_MODE).toBe('low_high');
  });

  test('there are exactly three modes', () => {
    expect([...REVIEW_MODES]).toEqual(['off', 'low_high', 'separate']);
  });

  // Both spellings, because TOML and metadata say `low_high` while a person at
  // a command line or a web form types `low-high`.
  test('parseReviewMode accepts either spelling and refuses anything else', () => {
    expect(parseReviewMode('low-high')).toBe('low_high');
    expect(parseReviewMode('low_high')).toBe('low_high');
    expect(parseReviewMode('  SEPARATE ')).toBe('separate');
    expect(parseReviewMode('off')).toBe('off');
    expect(parseReviewMode('banana')).toBeNull();
    expect(parseReviewMode('')).toBeNull();
    expect(parseReviewMode(undefined)).toBeNull();
    expect(parseReviewMode(3)).toBeNull();
  });

  test('isReviewMode is the stored spelling only', () => {
    expect(isReviewMode('low_high')).toBe(true);
    expect(isReviewMode('low-high')).toBe(false);
  });
});

describe('resolveReviewMode', () => {
  test('falls through to the project default', () => {
    expect(resolveReviewMode(undefined, 'separate')).toBe('separate');
    expect(resolveReviewMode({}, 'low_high')).toBe('low_high');
  });

  // INVARIANT: the task's own recorded mode beats the project default. It is
  // written on the task's first launch, which is what keeps a task in ONE arm
  // for its whole life — a project default changed mid-flight must not move a
  // running task, or its later turns run under rules its earlier ones did not.
  test("the task's own mode beats the project default", () => {
    expect(resolveReviewMode({ review_mode: 'off' }, 'separate')).toBe('off');
  });

  test('an explicit override beats both', () => {
    expect(resolveReviewMode({ review_mode: 'off' }, 'separate', 'low_high')).toBe('low_high');
  });

  // INVARIANT: a task from before `[review]` existed reads back as the mode it
  // was ACTUALLY running under. The old resolver persisted `low_high_loop` as
  // 'on' | 'off' on EVERY task, including 'off' for every task that never
  // opted into the experiment — and 'off' meant "no in-session loop, the daemon
  // dispatches its own reviewer", which is `separate`. Reading it as the new
  // default would move every in-flight task into a different arm the moment
  // this code shipped, which is the silent arm-flip the per-task pin exists to
  // prevent.
  test('a pre-existing low_high_loop flag maps to the arm it was running', () => {
    expect(reviewModeFromLegacyMetadata('off')).toBe('separate');
    expect(reviewModeFromLegacyMetadata('on')).toBe('low_high');
    expect(reviewModeFromLegacyMetadata('banana')).toBeNull();

    expect(resolveReviewMode({ low_high_loop: 'off' }, 'low_high')).toBe('separate');
    expect(resolveReviewMode({ low_high_loop: 'on' }, 'separate')).toBe('low_high');
    // Older still — the flag's own pre-rename spelling.
    expect(resolveReviewMode({ ivan_loop: 'on' }, 'separate')).toBe('low_high');
  });

  test('the current key wins over the legacy one', () => {
    expect(resolveReviewMode({ review_mode: 'off', low_high_loop: 'on' }, 'separate')).toBe('off');
  });

  // An unreadable stored value must not pin a task to nonsense: fall through
  // to the next source rather than throwing on a launch path.
  test('an unrecognised stored mode falls through', () => {
    expect(resolveReviewMode({ review_mode: 'banana' }, 'separate')).toBe('separate');
  });
});

describe('the [review] section', () => {
  let root: string;
  let unpin: () => void;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'review-mode-'));
    unpin = pinConfig(root);
  });

  afterEach(async () => {
    unpin();
    await rm(root, { recursive: true, force: true });
  });

  async function writeConfig(body: string): Promise<void> {
    await writeFile(join(root, 'lazy.toml'), body);
  }

  test('defaults: low_high, and auto_fix off', async () => {
    await writeConfig('[agent]\nagent_id = "claude-code"\n');
    const config = await loadConfig(root);
    expect(config.review.mode).toBe('low_high');
    expect(config.review.auto_fix).toBe(false);
    expect(config.review.draft_effort).toBe('low');
    expect(config.review.review_effort).toBe('xhigh');
  });

  test('a project can set every key', async () => {
    await writeConfig(
      '[review]\nmode = "separate"\nauto_fix = true\ndraft_effort = "medium"\nreview_effort = "max"\n',
    );
    const config = await loadConfig(root);
    expect(config.review).toMatchObject({
      mode: 'separate',
      auto_fix: true,
      draft_effort: 'medium',
      review_effort: 'max',
    });
  });

  // INVARIANT: an unrecognised mode fails the LOAD. It decides whether a
  // reviewer container is ever launched, so resolving it to a default would be
  // a project silently getting a review posture it did not choose.
  test('an invalid mode is refused at load, by name', async () => {
    await writeConfig('[review]\nmode = "thorough"\n');
    await expect(loadConfig(root)).rejects.toThrow(/Invalid review mode "thorough"/);
  });

  test('an invalid phase effort is refused at load too', async () => {
    await writeConfig('[review]\nreview_effort = "enormous"\n');
    await expect(loadConfig(root)).rejects.toThrow(/review_effort/);
  });
});

/*
 * THREE-LEVEL INHERITANCE — engineer requirement, 2026-09-21:
 *
 *   "Every review setting is resolved per task with inheritance: project config
 *    → parent task → task. […] A cluster driver therefore sets a mode once on
 *    itself and its children follow unless they override."
 */
describe('resolveReviewSettings — project → parent task → task', () => {
  const project: ReviewSettings = { mode: 'low_high', auto_fix: false, gate: 'auto' };
  /** A parent whose three settings somebody explicitly CHOSE — the only kind a child inherits. */
  const CHOSEN_PARENT: ReviewModeMetadataLike = {
    review_mode: 'separate',
    review_mode_source: 'task',
    review_gate: 'always',
    review_gate_source: 'task',
    review_auto_fix: 'on',
    review_auto_fix_source: 'task',
  };

  test('a task with nothing recorded and no parent takes the project', () => {
    expect(resolveReviewSettings({ project })).toEqual(project);
  });

  // The case the requirement was written for: a cluster driver sets the mode on
  // ITSELF and every child it spawns follows without a flag of its own.
  test('a child with nothing recorded inherits its parent', () => {
    expect(resolveReviewSettings({
      parent: CHOSEN_PARENT,
      project,
    })).toEqual({ mode: 'separate', auto_fix: true, gate: 'always' });
  });

  test("the task's own value beats its parent's", () => {
    expect(resolveReviewSettings({
      own: { review_mode: 'low_high' },
      parent: { review_mode: 'separate', review_mode_source: 'task' },
      project,
    }).mode).toBe('low_high');
  });

  test('an explicit override beats all three', () => {
    expect(resolveReviewSettings({
      overrides: { mode: 'off' },
      own: { review_mode: 'low_high' },
      parent: { review_mode: 'separate', review_mode_source: 'task' },
      project: { ...project, mode: 'separate' },
    }).mode).toBe('off');
  });

  // INVARIANT: the levels are resolved PER KEY, not all-or-nothing. A child
  // that overrides only the mode still inherits its parent's gate — the
  // alternative would make one flag silently reset the other two to the project
  // default, which is a setting nobody asked to change.
  test('each key resolves independently', () => {
    expect(resolveReviewSettings({
      own: { review_mode: 'low_high' },
      parent: CHOSEN_PARENT,
      project,
    })).toEqual({ mode: 'low_high', gate: 'always', auto_fix: true });
  });

  // INVARIANT: `auto_fix: false` recorded on a task is a VALUE, not an absence.
  // A boolean read with `??` chaining is exactly where "off" silently becomes
  // "inherit", so the stated-by helper distinguishes them explicitly.
  test('a recorded auto_fix of off is honoured, not treated as unset', () => {
    expect(resolveReviewSettings({
      own: { review_auto_fix: 'off' },
      parent: { review_auto_fix: 'on', review_auto_fix_source: 'task' },
      project: { ...project, auto_fix: true },
    }).auto_fix).toBe(false);
  });

  // The legacy per-task flag is read at the TASK's own level — it is the same
  // thing the task said about itself, in the old spelling — so a parent cannot
  // override what a pre-existing task already recorded about itself.
  test('the legacy flag counts as the task stating its own mode', () => {
    expect(resolveReviewSettings({
      own: { low_high_loop: 'off' },
      parent: { review_mode: 'low_high', review_mode_source: 'task' },
      project,
    }).mode).toBe('separate');
  });

  // INVARIANT: a PARENT's legacy flag is never inherited. The old resolver
  // pinned `low_high_loop = "off"` on every task alive, so reading a parent's
  // as a decision put every task created under an existing hub into `separate`
  // on a project whose default is `low_high` — a whole tree in an arm nobody
  // picked (engineer report, 2026-09-21). The flag still decides the PARENT's
  // own arm; it decides nothing about its children.
  test("a parent's legacy flag does not reach the child", () => {
    expect(resolveReviewSettings({
      parent: { low_high_loop: 'off' },
      project,
    }).mode).toBe('low_high');
    expect(resolveReviewSettings({
      parent: { ivan_loop: 'off' },
      project,
    }).mode).toBe('low_high');
    // …while the parent itself still runs the arm it recorded.
    expect(resolveReviewSettings({ own: { low_high_loop: 'off' }, project }).mode).toBe('separate');
  });

  // INVARIANT: a parent contributes only what somebody CHOSE. A value pinned by
  // a launch carries a marker saying where it came from: `task` (somebody set
  // it) and `parent:<code>` (that same choice, one or more generations down)
  // propagate; `project`, `legacy` and `pinned` stop at the task holding them.
  // Without the stop, the legacy flag reaches the grandchildren one generation
  // later wearing the current key, which is the same bug with an extra step.
  test('a parent value it merely ended up with is not inherited', () => {
    for (const source of ['project', 'legacy', 'pinned']) {
      expect(resolveReviewSettings({
        parent: { review_mode: 'separate', review_mode_source: source },
        project,
      }).mode).toBe('low_high');
    }
    // A pinned value with no marker at all — every task launched before the
    // markers existed — is in the same position: in force, nobody's choice.
    expect(resolveReviewSettings({
      parent: { review_mode: 'separate' },
      project,
    }).mode).toBe('low_high');
    // …while a value the parent holds BY INHERITANCE is still somebody's
    // choice, and keeps travelling.
    expect(resolveReviewSettings({
      parent: { review_mode: 'separate', review_mode_source: 'parent:release-v022' },
      project,
    }).mode).toBe('separate');
  });

  // INVARIANT: inheritance is the whole chain, not one generation. A hub
  // started with `--review separate` must reach its grandchildren: dropping to
  // the project default two levels down gives LESS review than a human asked
  // for, silently, which is the worst direction for this setting to fail in.
  // The marker names the ORIGINAL chooser at every depth, so one lookup per
  // launch still answers it — nothing walks the tree.
  test('a choice made on a hub reaches its grandchildren, still naming the hub', () => {
    // Generation 1: the hub, chosen explicitly.
    const hub = { review_mode: 'separate', review_mode_source: 'task' };

    // Generation 2 resolves it and pins what it resolved.
    const child = resolveReviewSettingsWithSources({ parent: hub, parentCode: 'hub', project });
    expect(child.settings.mode).toBe('separate');
    expect(child.sources.mode).toEqual({ origin: 'parent', parent: 'hub' });
    const childMetadata = {
      ...reviewSettingsMetadata(child.settings),
      ...reviewSourcesMetadata(child.sources),
    };

    // Generation 3 reads the child, not the hub — and gets the hub's choice,
    // attributed to the hub rather than to the intermediary.
    const grandchild = resolveReviewSettingsWithSources({
      parent: childMetadata,
      parentCode: 'child',
      project,
    });
    expect(grandchild.settings.mode).toBe('separate');
    expect(grandchild.sources.mode).toEqual({ origin: 'parent', parent: 'hub' });
  });

  test("a parent's explicit choice still reaches the child", () => {
    expect(resolveReviewSettings({
      parent: { review_mode: 'separate', review_mode_source: 'task' },
      project,
    }).mode).toBe('separate');
    expect(resolveReviewSettings({
      parent: { review_auto_fix: 'on', review_auto_fix_source: 'task' },
      project,
    }).auto_fix).toBe(true);
  });

  test('reviewSettingsChosenBy is the inheritable subset', () => {
    expect(reviewSettingsChosenBy({
      review_mode: 'separate',
      review_mode_source: 'task',
      review_gate: 'always',
      review_gate_source: 'project',
      review_auto_fix: 'on',
      review_auto_fix_source: 'parent:hub',
      low_high_loop: 'off',
    })).toEqual({ mode: 'separate', auto_fix: true });
    expect(reviewSettingsChosenBy({ low_high_loop: 'off' })).toEqual({});
    expect(reviewSettingsChosenBy(undefined)).toEqual({});
  });
});

/*
 * WHERE A VALUE CAME FROM. The engineer's question on seeing an unexpected
 * `Review:` line was not "what does separate mean" but "why would it be
 * separate — I was explicit about this?" (2026-09-21). The values alone cannot
 * answer that, so the resolution carries the provenance.
 */
describe('resolveReviewSettingsWithSources', () => {
  const project: ReviewSettings = { mode: 'low_high', auto_fix: false, gate: 'auto' };

  test('each level names itself', () => {
    expect(resolveReviewSettingsWithSources({ project }).sources.mode).toEqual({ origin: 'project' });
    expect(resolveReviewSettingsWithSources({
      overrides: { mode: 'off' },
      project,
    }).sources.mode).toEqual({ origin: 'task' });
    expect(resolveReviewSettingsWithSources({
      own: { review_mode: 'off', review_mode_source: 'task' },
      project,
    }).sources.mode).toEqual({ origin: 'task' });
    expect(resolveReviewSettingsWithSources({
      own: { low_high_loop: 'off' },
      project,
    }).sources.mode).toEqual({ origin: 'legacy' });
  });

  // The parent is named, not merely pointed at: "inherited" without a code
  // leaves the reader to go and find which ancestor decided it.
  test('an inherited value names the parent it came from', () => {
    const { settings, sources } = resolveReviewSettingsWithSources({
      parent: { review_mode: 'separate', review_mode_source: 'task' },
      parentCode: 'release-v022',
      project,
    });
    expect(settings.mode).toBe('separate');
    expect(sources.mode).toEqual({ origin: 'parent', parent: 'release-v022' });
    expect(encodeReviewSource(sources.mode)).toBe('parent:release-v022');
  });

  // INVARIANT: an unmarked pinned value reads as `pinned`, never as `task`. It
  // is in force and nobody's choice is on record — claiming a human set it
  // would be the page asserting intent the store does not carry, and it is
  // also what keeps such a value from being inherited.
  test('a value pinned before the markers existed reads as pinned', () => {
    expect(resolveReviewSettingsWithSources({
      own: { review_mode: 'separate' },
      project,
    }).sources.mode).toEqual({ origin: 'pinned' });
  });

  test('round-trips through metadata', () => {
    const { sources } = resolveReviewSettingsWithSources({
      parent: { review_gate: 'always', review_gate_source: 'task' },
      parentCode: 'hub',
      project,
    });
    const written = reviewSourcesMetadata(sources);
    expect(written).toEqual({
      review_mode_source: 'project',
      review_auto_fix_source: 'project',
      review_gate_source: 'parent:hub',
    });
    expect(parseReviewSource(written.review_gate_source!)).toEqual({ origin: 'parent', parent: 'hub' });
    expect(parseReviewSource('banana')).toBeNull();
  });

  // INVARIANT: a read-only surface shows what the task WILL run under, not what
  // it would run under if it had no parent. An unlaunched task has pinned
  // nothing, so without the parent level `lazy show` told a human "low-high
  // (project default)" about a backlog child whose hub had chosen `separate` —
  // a false provenance claim on exactly the tasks somebody inspects BEFORE
  // starting them. For a LAUNCHED task the parent changes nothing: its own
  // pinned values answer first.
  test('an unlaunched child is shown its parent\'s choice, not the project default', () => {
    const hub = { metadata: { review_mode: 'separate', review_mode_source: 'task' }, code: 'hub' };

    const unlaunched = reviewSettingsResolutionOf({}, project, hub);
    expect(unlaunched.settings.mode).toBe('separate');
    expect(unlaunched.sources.mode).toEqual({ origin: 'parent', parent: 'hub' });

    // No parent in hand — unchanged, and honest about what it knows.
    expect(reviewSettingsResolutionOf({}, project).settings.mode).toBe('low_high');

    // Launched, having pinned its own override: the parent does not move it.
    const launched = reviewSettingsResolutionOf(
      { review_mode: 'low_high', review_mode_source: 'task' },
      project,
      hub,
    );
    expect(launched.settings.mode).toBe('low_high');
    expect(launched.sources.mode).toEqual({ origin: 'task' });
  });

  test('every value is explained in plain words, with where it came from', () => {
    const { settings, sources } = resolveReviewSettingsWithSources({
      own: { review_mode: 'separate', review_mode_source: 'task' },
      project,
    });
    const explanations = reviewSettingsExplanations(settings, sources);
    expect(explanations.map((e) => e.key)).toEqual(['mode', 'gate', 'auto-fix']);
    expect(explanations[0]).toMatchObject({ value: 'separate', source: 'task' });
    expect(explanations[0]!.origin).toBe('set on this task');
    expect(explanations[1]!.origin).toBe('project default');
    // No lazy jargon in the clauses a human reads: no metadata keys, no
    // function names, no file paths.
    for (const e of explanations) {
      expect(e.meaning).not.toMatch(/review_|\.ts|lazy_/);
      expect(reviewExplanationLine(e)).toContain(e.origin);
    }
  });

  test('an unreadable recorded value falls through to the next level', () => {
    expect(resolveReviewSettings({
      own: { review_mode: 'banana', review_gate: 'sometimes' },
      parent: { review_mode: 'separate', review_mode_source: 'task', review_gate: 'never', review_gate_source: 'task' },
      project,
    })).toEqual({ mode: 'separate', gate: 'never', auto_fix: false });
  });
});

describe('the gate vocabulary', () => {
  test('the default is auto — the mode decides', () => {
    expect(DEFAULT_REVIEW_GATE).toBe('auto');
    expect([...REVIEW_GATES]).toEqual(['auto', 'always', 'never']);
  });

  test('parseReviewGate refuses anything outside the three', () => {
    expect(parseReviewGate(' ALWAYS ')).toBe('always');
    expect(parseReviewGate('sometimes')).toBeNull();
    expect(parseReviewGate(undefined)).toBeNull();
  });

  // Narrow on purpose: a typo must be refused by name rather than read as
  // "off" and silently switching a project's fix rounds off.
  test('parseReviewToggle takes the on/off spellings and nothing else', () => {
    for (const yes of [true, 'on', 'TRUE', 'yes', '1']) expect(parseReviewToggle(yes)).toBe(true);
    for (const no of [false, 'off', 'false', 'no', '0']) expect(parseReviewToggle(no)).toBe(false);
    for (const bad of ['maybe', '', 2, undefined]) expect(parseReviewToggle(bad)).toBeNull();
  });
});

/*
 * WHICH REVIEWS COUNT. `reviewGateApplies` is the one rule the accept gate, the
 * web disclosure row and the disregarded-review notice all read.
 */
describe('reviewGateApplies', () => {
  // INVARIANT: a review somebody ASKED for gates in every mode under `auto`.
  // Nobody spends a review turn they did not want, and ignoring what one found
  // because the task is in the fast mode would make `lazy review` a no-op at
  // exactly the moment it was reached for.
  test('auto: the mode decides for a dispatched review, never for a manual one', () => {
    expect(reviewGateApplies('auto', 'separate', 'auto')).toBe(true);
    expect(reviewGateApplies('auto', 'low_high', 'auto')).toBe(false);
    expect(reviewGateApplies('auto', 'off', 'auto')).toBe(false);

    for (const mode of REVIEW_MODES) {
      expect(reviewGateApplies('auto', mode, 'manual')).toBe(true);
    }
  });

  test('always: every recorded review gates, in every mode', () => {
    for (const mode of REVIEW_MODES) {
      for (const dispatch of ['auto', 'manual'] as const) {
        expect(reviewGateApplies('always', mode, dispatch)).toBe(true);
      }
    }
  });

  // INVARIANT: `never` switches off even a MANUAL review's gate — the one
  // setting that does. A config key called "never" that still gated something
  // would be a lie, and this is the only place a human can say "I have read
  // these and I do not want them holding merges".
  test('never: nothing gates, manual reviews included', () => {
    for (const mode of REVIEW_MODES) {
      for (const dispatch of ['auto', 'manual'] as const) {
        expect(reviewGateApplies('never', mode, dispatch)).toBe(false);
      }
    }
  });

  test('an absent recorded dispatch reads as manual — the gating direction', () => {
    expect(reviewDispatchOf({})).toBe('manual');
    expect(reviewDispatchOf(undefined)).toBe('manual');
    expect(reviewDispatchOf({ review_dispatch: 'auto' })).toBe('auto');
  });
});

describe('what a create or edit WRITES', () => {
  // INVARIANT: only what was SUPPLIED is recorded. A create that pinned all
  // three from one flag would silently freeze the task against a project
  // default that may still change — the opposite of inheriting.
  // INVARIANT: each supplied value carries a `task` source marker. This IS
  // somebody choosing, and the marker is what makes it inheritable and what
  // lets a surface say "set on this task" — the one thing a bare value can
  // never establish.
  test('reviewOverrideMetadata writes only the supplied keys, marked as choices', () => {
    expect(reviewOverrideMetadata({ mode: 'separate' })).toEqual({
      review_mode: 'separate',
      review_mode_source: 'task',
    });
    expect(reviewOverrideMetadata({ auto_fix: false })).toEqual({
      review_auto_fix: 'off',
      review_auto_fix_source: 'task',
    });
    expect(reviewOverrideMetadata({})).toEqual({});
  });

  // A resolved set, by contrast, records all three: that is the launch pinning
  // what this task runs under from now on.
  test('reviewSettingsMetadata writes the whole resolved triple', () => {
    expect(reviewSettingsMetadata({ mode: 'off', auto_fix: true, gate: 'never' })).toEqual({
      review_mode: 'off',
      review_auto_fix: 'on',
      review_gate: 'never',
    });
  });
});

describe('[review] gate, at load time', () => {
  let root: string;
  let unpin: () => void;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'review-gate-'));
    unpin = pinConfig(root);
  });

  afterEach(async () => {
    unpin();
    await rm(root, { recursive: true, force: true });
  });

  async function writeConfig(body: string): Promise<void> {
    await writeFile(join(root, 'lazy.toml'), body);
  }

  test('defaults to auto', async () => {
    await writeConfig('[agent]\nagent_id = "claude-code"\n');
    expect((await loadConfig(root)).review.gate).toBe('auto');
  });

  test('a project can set it', async () => {
    await writeConfig('[review]\ngate = "always"\n');
    expect((await loadConfig(root)).review.gate).toBe('always');
  });

  // INVARIANT: same reasoning as the mode — the gate decides whether a review
  // can refuse a merge at all, so an unrecognised value must fail the load
  // rather than resolve to a posture the project did not choose.
  test('an invalid gate is refused at load, by name', async () => {
    await writeConfig('[review]\ngate = "sometimes"\n');
    await expect(loadConfig(root)).rejects.toThrow(/Invalid review gate "sometimes"/);
  });

  test('a stated [agent] effort is the resolved effort, and nothing more', async () => {
    // INVARIANT: the loader records no "was this stated" flag. It used to, and
    // `low_high` read it — which made `draft_effort` dead on every project that
    // states an effort at all. Whether the DRAFT may be cheapened is a per-task
    // question now (`effort_explicit` metadata), not a project-wide one.
    await writeConfig('[agent]\neffort = "high"\n');
    const config = await loadConfig(root);
    expect(config.agent.effort).toBe('high');
    expect('effortExplicit' in (config.agent as Record<string, unknown>)).toBe(false);
  });
});
