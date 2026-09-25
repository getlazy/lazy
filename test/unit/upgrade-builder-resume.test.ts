/**
 * Unit tests: `lazy upgrade` builder pre-stop prompt.
 *
 * Upgrade no longer stops builder containers — they reconnect in place via
 * src/builder/continuity.ts — but the pre-stop prompt still warns the human to
 * submit any in-progress message before Claude relaunches.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { promptBuilderPreStop } from '../../src/cli/commands/upgrade';

describe('promptBuilderPreStop', () => {
  let logs: string[];
  const origLog = console.log;
  const origForceTty = process.env.LAZY_FORCE_TTY;
  const origPromptDefaults = process.env.LAZY_PROMPT_DEFAULTS;

  beforeEach(() => {
    logs = [];
    console.log = (...args: unknown[]) => { logs.push(args.join(' ')); };
  });

  afterEach(() => {
    console.log = origLog;
    if (origForceTty === undefined) delete process.env.LAZY_FORCE_TTY;
    else process.env.LAZY_FORCE_TTY = origForceTty;
    if (origPromptDefaults === undefined) delete process.env.LAZY_PROMPT_DEFAULTS;
    else process.env.LAZY_PROMPT_DEFAULTS = origPromptDefaults;
  });

  test('no builders → no output, no prompt', async () => {
    await promptBuilderPreStop(0, false);
    expect(logs).toEqual([]);
  });

  // INVARIANT: --force must never block on a prompt — it is the non-interactive
  // path. It still WARNS that unsent builder input may be lost (we don't silently
  // discard the risk), then proceeds.
  test('--force warns but does not block', async () => {
    // No LAZY_PROMPT_DEFAULTS set: if this awaited promptLine it would hang the
    // test (no stdin). It returns, proving the prompt path was skipped.
    await promptBuilderPreStop(2, /* force */ true);
    const out = logs.join('\n');
    expect(out).toContain('2 live builder sessions will reconnect in place');
    expect(out).toContain('Proceeding without prompting');
    expect(out).not.toContain('Press Enter');
  });

  // INVARIANT: no TTY must never block either (e.g. CI, piped invocation).
  test('non-TTY warns but does not block', async () => {
    delete process.env.LAZY_FORCE_TTY; // ensure isTTY() is false
    await promptBuilderPreStop(1, /* force */ false);
    const out = logs.join('\n');
    expect(out).toContain('1 live builder session will reconnect in place');
    expect(out).toContain('Proceeding without prompting');
    expect(out).not.toContain('Press Enter');
  });

  // Interactive TTY, not --force: the human IS prompted to submit in-progress
  // input before the stop. LAZY_PROMPT_DEFAULTS makes promptLine return without
  // real stdin so the test exercises the blocking path without hanging.
  test('interactive TTY prompts the human to submit before stopping', async () => {
    process.env.LAZY_FORCE_TTY = '1';
    process.env.LAZY_PROMPT_DEFAULTS = '1';
    await promptBuilderPreStop(1, /* force */ false);
    const out = logs.join('\n');
    expect(out).toContain('1 live builder session will reconnect in place');
    expect(out).toContain('submit it now');
    expect(out).toContain('Press Enter when ready to continue');
    expect(out).not.toContain('Proceeding without prompting');
  });

  // INVARIANT: a blocking prompt must be re-stated below docker build output,
  // not assumed visible after a long background rebuild scrolls it away.
  test('interactive TTY re-prompts below simulated build output', async () => {
    process.env.LAZY_FORCE_TTY = '1';
    process.env.LAZY_PROMPT_DEFAULTS = '1';

    const { BackgroundImageBuild, stagingTagFor } = await import('../../src/upgrade/background-image-build');
    const build = new BackgroundImageBuild(stagingTagFor(), {
      build: async () => {
        console.log('#13 DONE 10.0s');
        console.log('#14 DONE 24.5s');
        await new Promise(resolve => setTimeout(resolve, 10));
        return 'lazy-runner:0.22-upgrade';
      },
      canonicalTags: async () => ['lazy-runner:0.22'],
      tag: async () => {},
      untag: async () => true,
      now: () => Date.now(),
    });

    await promptBuilderPreStop(1, /* force */ false, [], build);
    const out = logs.join('\n');
    expect(out).toContain('Image build finished');
    expect(out).toContain('#14 DONE 24.5s');
    const buildDoneAt = out.lastIndexOf('#14 DONE 24.5s');
    const repromptAt = out.lastIndexOf('Image build finished. Press Enter when ready');
    expect(buildDoneAt).toBeGreaterThanOrEqual(0);
    expect(repromptAt).toBeGreaterThan(buildDoneAt);
  });
});
