/**
 * Unit tests: `lazy upgrade` builder-resume handshake.
 *
 * Two behaviors `lazy upgrade` performs before stopping live builder
 * containers (docs/spikes/builder-upgrade-resume.md §3 Implementation surface,
 * task add-upgrade-resume-intent):
 *
 *  1. Write a durable builder-resume-intent per builder so the relaunched
 *     `lazy builder` wrapper (add-builder-relaunch-loop) resumes in place.
 *  2. Synchronously prompt the human to submit any in-progress builder message
 *     before the `--rm` container is killed and its unsent input is lost —
 *     honoring CLAUDE.md "never lose human feedback". The prompt must NOT hang a
 *     non-interactive caller (--force / no TTY).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { FileStorage } from '../../src/storage';
import {
  writeBuilderResumeIntents,
  promptBuilderPreStop,
  stopBuilderContainers,
} from '../../src/cli/commands/upgrade';

describe('writeBuilderResumeIntents', () => {
  let storage: FileStorage;
  let lazyRoot: string;
  let basePath: string;

  beforeEach(async () => {
    lazyRoot = await mkdtemp(join(tmpdir(), 'lazy-ubr-root-'));
    basePath = await mkdtemp(join(tmpdir(), 'lazy-ubr-store-'));
    storage = new FileStorage(lazyRoot, { basePath });
    await storage.initialize();
  });

  afterEach(async () => {
    await storage.close();
    await Promise.all([
      rm(lazyRoot, { recursive: true, force: true }),
      rm(basePath, { recursive: true, force: true }),
    ]);
  });

  // INVARIANT: upgrade writes one durable intent per builder it is about to
  // stop, keyed by the SHORT builder id (the `lazy-builder-` prefix stripped
  // from the discovered run name). This MUST match the key the supervisor's
  // sessionId stamp (add-builder-sessionid-stamp) uses: docker-runner derives
  // the short id as `configBasename.replace('builder-', '')` and launches the
  // supervisor with `--builder-id <short>`, and the stamp updates the intent by
  // that same short id. Writing the full run name here would make the stamp's
  // lookup miss and silently defeat it.
  test('writes one intent per builder, keyed by SHORT id (prefix stripped)', async () => {
    // discoverProjectBuilderRuns returns FULL run names; we must strip the prefix.
    const runNames = ['lazy-builder-aaaa1111', 'lazy-builder-bbbb2222'];
    await writeBuilderResumeIntents(storage, runNames, '/proj/a');

    const intents = await storage.listBuilderResumeIntents();
    expect(intents.map(i => i.builderId).sort()).toEqual(['aaaa1111', 'bbbb2222']);
    for (const i of intents) {
      expect(i.projectRoot).toBe('/proj/a');
      // sessionId is unknown to the host in docker mode (§1.2): it is populated
      // by the supervisor stamp (keyed by the same short id) or resolved by the
      // wrapper from storage. Must be left undefined at write time.
      expect(i.sessionId).toBeUndefined();
      expect(typeof i.createdAt).toBe('string');
    }
  });

  // The short id the intent is keyed by must equal what docker-runner passes as
  // `--builder-id`: the container name with the `lazy-builder-` prefix removed.
  // This guards the upgrade↔stamp key agreement against regression.
  test('intent key equals the container name minus the lazy-builder- prefix', async () => {
    const runName = 'lazy-builder-deadbeef';
    await writeBuilderResumeIntents(storage, [runName], '/proj/a');

    // The full run name is NOT the key — a take by run name finds nothing
    // (checked first so the miss is unambiguous, before anything is consumed).
    expect(await storage.takeBuilderResumeIntent(runName)).toBeNull();
    // The short id IS the key.
    const taken = await storage.takeBuilderResumeIntent('deadbeef');
    expect(taken?.builderId).toBe('deadbeef');
  });

  test('no builders → no intents written', async () => {
    await writeBuilderResumeIntents(storage, [], '/proj/a');
    expect(await storage.listBuilderResumeIntents()).toEqual([]);
  });

  // The intents are scoped per project so a relaunched wrapper only matches its
  // own builders (mirrors discoverProjectBuilderRuns project scoping).
  test('intents carry the project root they were written for', async () => {
    await writeBuilderResumeIntents(storage, ['lazy-builder-x'], '/proj/a');
    await writeBuilderResumeIntents(storage, ['lazy-builder-y'], '/proj/b');

    expect((await storage.listBuilderResumeIntents('/proj/a')).map(i => i.builderId)).toEqual(['x']);
    expect((await storage.listBuilderResumeIntents('/proj/b')).map(i => i.builderId)).toEqual(['y']);
  });
});

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
    expect(out).toContain('2 builder sessions will be restarted');
    expect(out).toContain('Proceeding without prompting');
    expect(out).not.toContain('Press Enter');
  });

  // INVARIANT: no TTY must never block either (e.g. CI, piped invocation).
  test('non-TTY warns but does not block', async () => {
    delete process.env.LAZY_FORCE_TTY; // ensure isTTY() is false
    await promptBuilderPreStop(1, /* force */ false);
    const out = logs.join('\n');
    expect(out).toContain('1 builder session will be restarted');
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
    expect(out).toContain('1 builder session will be restarted');
    expect(out).toContain('submit it now');
    expect(out).toContain('Press Enter when ready to continue');
    expect(out).not.toContain('Proceeding without prompting');
  });
});

describe('stopBuilderContainers', () => {
  const origLog = console.log;
  afterEach(() => { console.log = origLog; });

  // INVARIANT: upgrade stops builders with SIGTERM + a grace period, NEVER with
  // an immediate kill. The builder supervisor's signal handler is what flushes
  // the conversation capture and stamps the resume sessionId onto the intent
  // written moments earlier; `docker kill` skips both, and the relaunched
  // builder then had no session to resume ("relaunch with resume does not work
  // either way"). Do not "optimize away" this grace period.
  test('stops each builder gracefully, with a non-zero grace period', async () => {
    console.log = () => {};
    const calls: { name: string; opts?: { gracefulTimeoutSeconds?: number } }[] = [];
    const runner = {
      stopRun: async (name: string, opts?: { gracefulTimeoutSeconds?: number }) => {
        calls.push({ name, opts });
        return true;
      },
    };

    await stopBuilderContainers(runner, ['lazy-builder-aaaa1111', 'lazy-builder-bbbb2222']);

    expect(calls.map(c => c.name)).toEqual(['lazy-builder-aaaa1111', 'lazy-builder-bbbb2222']);
    for (const c of calls) {
      expect(c.opts?.gracefulTimeoutSeconds).toBeGreaterThan(0);
    }
  });

  // A failed stop is reported, not thrown: upgrade must continue to the rebuild
  // (and the remaining builders) rather than abort half-way through.
  test('reports failure and keeps going', async () => {
    const logs: string[] = [];
    console.log = (...a: unknown[]) => { logs.push(a.join(' ')); };
    const runner = { stopRun: async (name: string) => name.endsWith('ok') };

    await stopBuilderContainers(runner, ['lazy-builder-bad', 'lazy-builder-ok']);

    const out = logs.join('\n');
    expect(out).toContain('lazy-builder-bad');
    expect(out).toContain('lazy-builder-ok');
    expect(out).toContain('failed');
    expect(out).toContain('stopped');
  });
});
