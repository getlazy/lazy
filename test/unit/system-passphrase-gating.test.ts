/**
 * Unit tests for the gates inside `lazy system passphrase`
 * (src/cli/commands/system-passphrase.ts).
 *
 * WHY THESE ARE UNIT TESTS AND NOT E2E TESTS. Every mutating path of that
 * command refuses outright when LAZY_FORCE_TTY, LAZY_PROMPT_DEFAULTS or
 * LAZY_PROMPT_SECRET is set, and reads process.stdin.isTTY directly — so no
 * test can type a passphrase at the real command, which is exactly the point
 * (anything a test can drive, an agent running lazy from source can drive too).
 * Injection at the function boundary is the SUPPORTED substitute: the functions
 * below take their prompt as a parameter defaulting to the real one, so a test
 * reaches the behavior without any of it existing at runtime.
 *
 * The behaviors covered here are the ones that lost their e2e coverage when
 * that gate went in. The rotation gate in particular is load-bearing: without
 * it, "delete, then enroll my own" is a one-step way around a passphrase the
 * attacker does not know.
 *
 * `LAZY_PASSPHRASE_BASE_DIR` — the store's own seam — is pinned to a temp dir,
 * so nothing here reads or clobbers the developer's own enrollment.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  requireCurrentPassphrase,
  promptAndStore,
  offerLegacyCleanup,
  type SecretPrompt,
  type ConfirmPrompt,
} from '../../src/cli/commands/system-passphrase';
import {
  writePassphrase,
  verifyPassphrase,
  isPassphraseEnrolled,
  legacyPassphraseFileExists,
  legacyPassphrasePath,
} from '../../src/protection/passphrase-store';

const PASSPHRASE = 'correct-horse-battery';

/** A masked prompt that "types" the given answers, in order. */
function typing(...answers: string[]): SecretPrompt & { asked: string[] } {
  const asked: string[] = [];
  const prompt = (async (message: string) => {
    asked.push(message);
    const next = answers.shift();
    if (next === undefined) throw new Error(`unexpected extra prompt: ${message}`);
    return next;
  }) as SecretPrompt & { asked: string[] };
  prompt.asked = asked;
  return prompt;
}

/** A yes/no prompt that always answers the same way, recording what it was asked. */
function answering(yes: boolean): ConfirmPrompt & { asked: string[] } {
  const asked: string[] = [];
  const prompt = (async (message: string) => {
    asked.push(message);
    return yes;
  }) as ConfirmPrompt & { asked: string[] };
  prompt.asked = asked;
  return prompt;
}

/** Run `fn` with console output captured, so a refusal's wording is assertable. */
async function capturing<T>(fn: () => Promise<T>): Promise<{ result: T; output: string }> {
  const realLog = console.log;
  const realError = console.error;
  let output = '';
  const sink = (...args: unknown[]) => {
    output += args.map(String).join(' ') + '\n';
  };
  console.log = sink;
  console.error = sink;
  try {
    return { result: await fn(), output };
  } finally {
    console.log = realLog;
    console.error = realError;
  }
}

describe('system passphrase gating', () => {
  let baseDir: string;
  let previousBaseDir: string | undefined;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'passphrase-gating-'));
    previousBaseDir = process.env.LAZY_PASSPHRASE_BASE_DIR;
    process.env.LAZY_PASSPHRASE_BASE_DIR = baseDir;
  });

  afterEach(async () => {
    if (previousBaseDir === undefined) delete process.env.LAZY_PASSPHRASE_BASE_DIR;
    else process.env.LAZY_PASSPHRASE_BASE_DIR = previousBaseDir;
    await rm(baseDir, { recursive: true, force: true });
  });

  describe('requireCurrentPassphrase', () => {
    // INVARIANT: rotation and deletion are both gated on proving knowledge of
    // the CURRENT passphrase. This is what stops "delete, then enroll my own"
    // from being a one-step way around the gate. Its two call sites in
    // system-passphrase.ts must exit on a false return — do not weaken either.
    test('accepts the enrolled passphrase', async () => {
      await writePassphrase(PASSPHRASE);

      const prompt = typing(PASSPHRASE);
      const { result } = await capturing(() => requireCurrentPassphrase('changed', prompt));

      expect(result).toBe(true);
      expect(prompt.asked).toEqual(['Current approval passphrase']);
    });

    test('rejects a wrong passphrase and says nothing was changed', async () => {
      await writePassphrase(PASSPHRASE);

      const { result, output } = await capturing(() =>
        requireCurrentPassphrase('changed', typing('not-the-passphrase')),
      );

      expect(result).toBe(false);
      expect(output).toContain('not the current approval passphrase');
      expect(output).toContain('nothing was changed');
      // The reset path is in the failure message: there is no recovery, so the
      // human has to be told the way forward at the moment they discover it.
      expect(output).toContain('lazy system passphrase set');
      // The store is untouched — a failed attempt must not un-enroll anything.
      expect(await verifyPassphrase(PASSPHRASE)).toBe(true);
    });

    test('the verb comes from the caller, so delete says "deleted"', async () => {
      await writePassphrase(PASSPHRASE);

      const { output } = await capturing(() =>
        requireCurrentPassphrase('deleted', typing('wrong')),
      );

      expect(output).toContain('nothing was deleted');
    });

    // Fails CLOSED: with nothing enrolled, verification is false for every
    // input, so a caller that reaches this cannot be talked past it.
    test('refuses everything when nothing is enrolled', async () => {
      const { result } = await capturing(() =>
        requireCurrentPassphrase('changed', typing(PASSPHRASE)),
      );

      expect(result).toBe(false);
    });
  });

  describe('promptAndStore', () => {
    test('stores the passphrase when both entries agree', async () => {
      const prompt = typing(PASSPHRASE, PASSPHRASE);
      const { result } = await capturing(() => promptAndStore(false, prompt));

      expect(result).toBe(true);
      expect(prompt.asked).toEqual(['New approval passphrase', 'Confirm approval passphrase']);
      expect(await verifyPassphrase(PASSPHRASE)).toBe(true);
    });

    // INVARIANT: a minimum length, checked BEFORE anything is written. Friction,
    // not cryptography — but a one-character passphrase would make the prompt
    // theatre.
    test('refuses a too-short passphrase and stores nothing', async () => {
      const prompt = typing('short');
      const { result, output } = await capturing(() => promptAndStore(false, prompt));

      expect(result).toBe(false);
      expect(output).toContain('at least 8 characters');
      expect(output).toContain('Nothing was changed');
      // It gave up at the first prompt: there is no point confirming a value
      // that is already rejected.
      expect(prompt.asked).toEqual(['New approval passphrase']);
      expect(await isPassphraseEnrolled()).toBe(false);
    });

    test('refuses when the two entries disagree, and stores nothing', async () => {
      const { result, output } = await capturing(() =>
        promptAndStore(false, typing(PASSPHRASE, `${PASSPHRASE}-typo`)),
      );

      expect(result).toBe(false);
      expect(output).toContain('do not match');
      expect(await isPassphraseEnrolled()).toBe(false);
    });

    // The length rule and the agreement check both run on the NORMALIZED form,
    // because that is what gets hashed. Two entries differing only by an
    // invisible trailing space are the same passphrase to the store, so
    // rejecting them here would be rejecting something that would have worked.
    test('two entries differing only in surrounding whitespace agree', async () => {
      const { result } = await capturing(() =>
        promptAndStore(false, typing(`  ${PASSPHRASE}`, `${PASSPHRASE}\t`)),
      );

      expect(result).toBe(true);
      expect(await verifyPassphrase(PASSPHRASE)).toBe(true);
    });

    test('an existing enrollment is left intact when the entries disagree', async () => {
      await writePassphrase(PASSPHRASE);

      const { result } = await capturing(() =>
        promptAndStore(true, typing('a-new-passphrase', 'a-different-one')),
      );

      expect(result).toBe(false);
      expect(await verifyPassphrase(PASSPHRASE)).toBe(true);
    });
  });

  describe('offerLegacyCleanup', () => {
    let projectRoot: string;

    beforeEach(async () => {
      projectRoot = await mkdtemp(join(tmpdir(), 'passphrase-legacy-'));
      await mkdir(join(projectRoot, '.lazy'), { recursive: true });
    });

    afterEach(async () => {
      await rm(projectRoot, { recursive: true, force: true });
    });

    // The old file is never consulted, so leaving it costs nothing functionally
    // — but it is the human's OLD passphrase in the clear in a tree every agent
    // can read, which is the exact hazard this move removed.
    test('deletes the leftover plaintext file when the human says yes', async () => {
      await writeFile(legacyPassphrasePath(projectRoot), `${PASSPHRASE}\n`);

      const confirm = answering(true);
      const { output } = await capturing(() => offerLegacyCleanup(confirm, projectRoot));

      expect(confirm.asked).toEqual(['Delete it now?']);
      expect(output).toContain('leftover plaintext passphrase file');
      expect(await legacyPassphraseFileExists(projectRoot)).toBe(false);
    });

    // Saying no leaves it alone — it is the human's file — but the command they
    // need is printed, so declining now is not a dead end.
    test('leaves it in place when the human says no, and names the rm', async () => {
      await writeFile(legacyPassphrasePath(projectRoot), `${PASSPHRASE}\n`);

      const { output } = await capturing(() => offerLegacyCleanup(answering(false), projectRoot));

      expect(output).toContain(`rm ${legacyPassphrasePath(projectRoot)}`);
      expect(await legacyPassphraseFileExists(projectRoot)).toBe(true);
    });

    test('asks nothing when there is no leftover file, or no project', async () => {
      const noFile = answering(true);
      await capturing(() => offerLegacyCleanup(noFile, projectRoot));
      expect(noFile.asked).toEqual([]);

      const noProject = answering(true);
      await capturing(() => offerLegacyCleanup(noProject, null));
      expect(noProject.asked).toEqual([]);
    });
  });
});
