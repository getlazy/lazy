/**
 * E2E tests for `lazy system passphrase` — enrollment of the machine-global
 * approval passphrase (src/cli/commands/system-passphrase.ts).
 *
 * The store is redirected by `LAZY_PASSPHRASE_BASE_DIR`, which `setupTestLazy`
 * pins to a temp dir for every process it spawns (`ctx.passphraseBaseDir`), so
 * nothing here can read or clobber the developer's own enrollment.
 *
 * WHY THERE IS NO HAPPY-PATH TEST FOR `set`, AND WHY THAT IS CORRECT:
 * every mutating path refuses outright when LAZY_FORCE_TTY,
 * LAZY_PROMPT_DEFAULTS or LAZY_PROMPT_SECRET is set, and reads
 * `process.stdin.isTTY` directly rather than through isTTY(). There is
 * therefore no way for a test to type a passphrase — which is the point:
 * anything a test can drive, an agent can drive too.
 *
 * Coverage lives where it can, and the SUPPORTED substitute is injection at the
 * function boundary: test/unit/system-passphrase-gating.test.ts passes a fake
 * prompt to requireCurrentPassphrase / promptAndStore / offerLegacyCleanup and
 * covers rotation and deletion being gated on the current passphrase, the
 * minimum length, and the leftover-plaintext cleanup offer. The store itself is
 * unit-tested (test/unit/passphrase-store.test.ts), suites that need an enrolled
 * machine use `enrollPassphrase`, and every REFUSAL — the security-relevant
 * half — is exercised below. Do NOT "restore coverage" by weakening that gate
 * or re-opening the env route; add to the gating unit test instead.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError } from '../helpers/assertions';
import {
  enrollPassphrase,
  passphraseStoreExists,
  passphraseStoreMode,
  passphraseStorePathFor,
} from '../helpers/passphrase';

const PASSPHRASE = 'correct-horse-battery';

/** Env of a human at a real terminal on the host, "typing" `secret`. */
function typing(secret: string): Record<string, string> {
  return {
    LAZY_FORCE_TTY: '1',
    LAZY_FORCE_CONTAINER: '0',
    LAZY_PROMPT_DEFAULTS: '1',
    LAZY_PROMPT_SECRET: secret,
  };
}

describe('lazy system passphrase', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    // No daemon: enrollment is deliberately CLI/host-only — it never RPCs.
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('status on a fresh machine reports not enrolled and names the command', async () => {
    const result = await ctx.lazy(['system', 'passphrase']);

    expectSuccess(result);
    expectOutput(result, 'not enrolled');
    expectOutput(result, 'lazy system passphrase set');
  });

  test('status on an enrolled machine says so, and says it is machine-wide', async () => {
    await enrollPassphrase(ctx.passphraseBaseDir, PASSPHRASE);

    const result = await ctx.lazy(['system', 'passphrase', 'status']);

    expectSuccess(result);
    expectOutput(result, 'enrolled');
    expectOutput(result, 'every lazy project on this machine');
  });

  // The whole reason the passphrase left the repo: what is stored must not be
  // the passphrase. A store an agent can read must not hand it the secret.
  test('the stored file holds a hash, never the passphrase, at mode 0600', async () => {
    await enrollPassphrase(ctx.passphraseBaseDir, PASSPHRASE);

    const raw = await readFile(passphraseStorePathFor(ctx.passphraseBaseDir), 'utf-8');
    expect(raw).not.toContain(PASSPHRASE);
    expect(JSON.parse(raw).hash).toStartWith('$argon2');
    expect(await passphraseStoreMode(ctx.passphraseBaseDir)).toBe('600');
  });

  // INVARIANT: `status` is the one subcommand anything can reach freely, so it
  // must leak NOTHING that narrows a guess — not the value, not its length.
  test('status never prints or hints at the passphrase', async () => {
    await enrollPassphrase(ctx.passphraseBaseDir, PASSPHRASE);

    const result = await ctx.lazy(['system', 'passphrase', 'status']);

    expectSuccess(result);
    expect(result.stdout).not.toContain(PASSPHRASE);
    // The `Last set:` ISO timestamp is excluded before the length check: its
    // digits collide with a two-digit length by pure chance (a passphrase of
    // 21 characters matches the seconds of any :21 timestamp), which would
    // make this invariant fail on a clock rather than on a leak.
    const withoutTimestamp = result.stdout
      .split('\n')
      .filter((line) => !line.includes('Last set:'))
      .join('\n');
    expect(withoutTimestamp).not.toContain(String(PASSPHRASE.length));
    // Not the hash either — reading that back is an offline attack starter.
    expect(result.stdout).not.toContain('$argon2');
  });

  // INVARIANT: TTY-only. There is deliberately no flag, env var, or piped-stdin
  // route — a value a script can supply lives on in shell history and agent
  // transcripts, which defeats the one property this credential has.
  test('set without a terminal refuses and explains why there is no flag', async () => {
    const result = await ctx.lazy(['system', 'passphrase', 'set'], {
      env: { LAZY_FORCE_CONTAINER: '0' },
    });

    expectFailure(result);
    expectError(result, 'without an interactive terminal');
    expectError(result, 'no flag, environment variable, or piped-stdin form');
    expect(await passphraseStoreExists(ctx.passphraseBaseDir)).toBe(false);
  });

  // INVARIANT: the prompt test seams are a complete non-interactive route to any
  // prompt — LAZY_FORCE_TTY makes isTTY() lie, LAZY_PROMPT_DEFAULTS auto-answers,
  // LAZY_PROMPT_SECRET supplies the masked value. Enrollment refuses outright
  // when ANY of them is set, so no test (and therefore no agent running lazy
  // from source) can enroll a passphrase. Released binaries do not contain the
  // branches at all — test/unit/build-release-flags.test.ts pins that half.
  for (const seam of ['LAZY_FORCE_TTY', 'LAZY_PROMPT_DEFAULTS', 'LAZY_PROMPT_SECRET']) {
    test(`set refuses when ${seam} is set, and stores nothing`, async () => {
      const result = await ctx.lazy(['system', 'passphrase', 'set'], {
        env: { ...typing(PASSPHRASE), LAZY_FORCE_CONTAINER: '0', [seam]: 'x' },
      });

      expectFailure(result);
      expectError(result, 'Refusing to set the approval passphrase with');
      expect(await passphraseStoreExists(ctx.passphraseBaseDir)).toBe(false);
    });
  }

  // Same gate on the way out: otherwise "delete, then enroll my own" would be a
  // non-interactive way around a passphrase the agent does not know.
  test('delete refuses under the prompt seams and leaves the store intact', async () => {
    await enrollPassphrase(ctx.passphraseBaseDir, PASSPHRASE);
    const before = await readFile(passphraseStorePathFor(ctx.passphraseBaseDir), 'utf-8');

    const result = await ctx.lazy(['system', 'passphrase', 'delete'], {
      env: typing(PASSPHRASE),
    });

    expectFailure(result);
    expectError(result, 'Refusing to delete the approval passphrase with');
    expect(await readFile(passphraseStorePathFor(ctx.passphraseBaseDir), 'utf-8')).toBe(before);
  });

  // INVARIANT: refuses inside a container. A container is where AGENTS run.
  // Checked BEFORE the seam refusal, so the container reason is what a human
  // (or an agent) sees first — it is the more actionable of the two.
  test('set inside a container refuses and points at the host terminal', async () => {
    const result = await ctx.lazy(['system', 'passphrase', 'set'], {
      env: { ...typing(PASSPHRASE), LAZY_FORCE_CONTAINER: '1' },
    });

    expectFailure(result);
    expectError(result, 'from inside a container');
    expect(await passphraseStoreExists(ctx.passphraseBaseDir)).toBe(false);
  });

  test('status flags a leftover plaintext passphrase file', async () => {
    await writeFile(join(ctx.root, '.lazy', 'approve-passphrase'), 'old-plaintext-secret\n');

    const result = await ctx.lazy(['system', 'passphrase', 'status']);

    expectSuccess(result);
    expectOutput(result, 'Leftover plaintext passphrase file');
    expectOutput(result, 'no longer consulted');
  });

  // INVARIANT: registered in systemSubcommandUsage, or `-h` silently prints
  // the PARENT's help with no error anywhere (see CLAUDE.md).
  test('--help prints the passphrase help, not the system help', async () => {
    const result = await ctx.lazy(['system', 'passphrase', '--help']);

    expectSuccess(result);
    expectOutput(result, 'Usage: lazy system passphrase');
    expectOutput(result, 'Interactive terminal ONLY');
  });

  // A forgotten passphrase has no recovery path, so the RESET path has to be
  // where someone looks first — not only in the failure message you get after
  // guessing wrong at a masked prompt.
  test('the help text documents the reset path', async () => {
    const result = await ctx.lazy(['system', 'passphrase', '--help']);

    expectSuccess(result);
    expectOutput(result, 'rm ');
    expectOutput(result, 'passphrase.json');
    expectOutput(result, 'lazy system passphrase set');
  });

  test('an unknown subcommand fails with the passphrase usage', async () => {
    const result = await ctx.lazy(['system', 'passphrase', 'rotate']);

    expectFailure(result);
    expectError(result, 'Unknown subcommand');
  });
});
