/**
 * `lazy system passphrase` — enroll, inspect, and remove the approval
 * passphrase that `lazy approve` demands when a merge crosses a protected edge.
 *
 * Subcommands:
 *   status (default)  is a passphrase enrolled on this machine, where the store
 *                     lives, when it was last set — and NOTHING about the value
 *   set               enroll or rotate (masked prompt, typed twice; rotation
 *                     first proves knowledge of the current passphrase)
 *   delete            un-enroll (also gated on the current passphrase)
 *
 * DELIBERATE ASYMMETRIES (public-docs/surface-asymmetries.md):
 *
 * - TTY ONLY. No flag, no env var, no piped stdin — unlike `lazy system agent
 *   set-key`, which accepts a pipe. A passphrase reaching the process by any
 *   route a script can drive is a passphrase that can sit in shell history, in
 *   a CI variable, or in an agent transcript, and the whole point of this
 *   credential is that a HUMAN was at the keyboard. `lazy approve`'s prompt
 *   enforces the same rule at the other end.
 *
 * - NO RPC AND NO MCP TOOL. Enrollment writes from this CLI process on the
 *   host and nowhere else. Verification stays daemon-side (approveTaskPreflight
 *   / approveTask). If enrollment went through the daemon, anything that can
 *   reach the daemon — including every task agent, which holds a daemon token
 *   by construction — could enroll a passphrase of its own choosing and then
 *   satisfy the gate with it.
 *
 * - REFUSES INSIDE A CONTAINER. A container is where agents run; a human
 *   enrolling their own credential is at their own terminal. This is a guard
 *   rail rather than a boundary (see src/utils/container.ts).
 *
 * WHAT THIS DOES NOT CLOSE, stated plainly: on a machine where NOTHING is
 * enrolled yet, an agent running under the host-process runner shares the
 * user's HOME and its own terminal is a TTY, so it could in principle enroll
 * first and gate itself. Containerized execution is the real fix for that and
 * is out of scope here. Rotation and deletion are already closed against it —
 * both require the current passphrase, which is only in the human's head.
 */

// No isTTY() here on purpose — requireHumanTerminal reads process.stdin.isTTY
// directly so LAZY_FORCE_TTY cannot answer for a human. See its comment.
import { promptSecret, promptYesNo, PromptCancelledError } from '../editor';
import { findLazyRoot } from '../init';
import { theme } from '../theme';
import { isRunningInContainer } from '../../utils/container';
import {
  readPassphraseEnrollment,
  isPassphraseEnrolled,
  verifyPassphrase,
  writePassphrase,
  normalizePassphrase,
  deletePassphrase,
  passphraseStorePath,
  legacyPassphraseFileExists,
  legacyPassphrasePath,
  removeLegacyPassphraseFile,
} from '../../protection/passphrase-store';

/** Shortest passphrase worth calling one. Friction, not cryptography. */
const MIN_LENGTH = 8;

/**
 * The test-only prompt seams, which this command refuses to run alongside.
 *
 * `LAZY_FORCE_TTY` makes isTTY() lie, `LAZY_PROMPT_DEFAULTS` makes every prompt
 * auto-answer, and `LAZY_PROMPT_SECRET` supplies the value a masked prompt
 * "types". Together they are a complete non-interactive route to enrollment —
 * exactly the thing this command says does not exist. They are compiled out of
 * released binaries (see RELEASE_BUILD in src/cli/editor.ts), so this list is
 * the belt to that braces: it also covers running from source, which is how
 * every agent working on lazy itself runs it.
 */
const PROMPT_TEST_SEAMS = ['LAZY_FORCE_TTY', 'LAZY_PROMPT_DEFAULTS', 'LAZY_PROMPT_SECRET'] as const;

/**
 * Every mutating path runs this first: a human, at a real terminal, on the
 * host. Each refusal names the reason and what to do instead — a bare "not
 * supported" would read as a bug.
 *
 * DELIBERATE, AND THE CONSEQUENCE IS ACCEPTED: this reads process.stdin.isTTY
 * directly rather than isTTY(), and refuses outright if any prompt test seam is
 * set. That makes the happy path of `set` impossible to drive from an e2e test
 * — which is the point, since anything a test can drive, an agent can drive
 * too. Do NOT "fix" this by going back through isTTY() or by adding an
 * escape hatch.
 *
 * THE GAP IS COVERED ELSEWHERE, and this is the supported way to cover it:
 * INJECTION AT THE FUNCTION BOUNDARY. requireCurrentPassphrase, promptAndStore
 * and offerLegacyCleanup each take the prompt as a parameter defaulting to the
 * real one, so test/unit/system-passphrase-gating.test.ts drives rotation,
 * deletion, the length rule and the legacy-cleanup offer by passing a fake
 * prompt — which reaches the behavior without existing at RUNTIME, where an
 * agent could only invoke the real command and hit the refusals above. Suites
 * that need an enrolled machine use test/helpers/passphrase.ts
 * (`enrollPassphrase`); the store itself is unit-tested in
 * test/unit/passphrase-store.test.ts; every REFUSAL path here stays
 * e2e-testable, which is where the security-relevant behavior lives.
 */
async function requireHumanTerminal(action: string): Promise<void> {
  if (await isRunningInContainer()) {
    console.error(
      `Refusing to ${action} the approval passphrase from inside a container.\n` +
      `The passphrase proves a human is at the keyboard, and it is stored per MACHINE — ` +
      `a container's home directory is thrown away with the container.\n` +
      `Run this on the host, at your own terminal:\n\n  lazy system passphrase set`,
    );
    process.exit(1);
  }
  const seam = PROMPT_TEST_SEAMS.find((name) => process.env[name]);
  if (seam) {
    console.error(
      `Refusing to ${action} the approval passphrase with ${seam} set.\n` +
      `That variable makes lazy's prompts answerable without a human, which is the one ` +
      `thing this credential exists to rule out. It is a test seam and is never set on a ` +
      `real machine.\n` +
      `Unset it and run \`lazy system passphrase ${action === 'delete' ? 'delete' : 'set'}\` again.`,
    );
    process.exit(1);
  }
  // Deliberately NOT isTTY(): that helper honours LAZY_FORCE_TTY. See the
  // comment on this function — the seam refusal above already covers it, and
  // reading stdin directly means a future seam cannot quietly re-open this.
  if (!process.stdin.isTTY) {
    console.error(
      `Refusing to ${action} the approval passphrase without an interactive terminal.\n` +
      `There is deliberately no flag, environment variable, or piped-stdin form: a value ` +
      `supplied that way lands in shell history, CI configuration, or an agent transcript, ` +
      `and this credential exists to show a human typed it.\n` +
      `Run \`lazy system passphrase set\` from a terminal.`,
    );
    process.exit(1);
  }
}

/**
 * What a masked prompt is, so tests can supply one.
 *
 * The functions below take the prompt as a parameter rather than reaching for
 * `promptSecret` directly. This is the SUPPORTED substitute for the e2e
 * coverage the seam refusal above deliberately gives up: injection reaches the
 * behavior without existing at runtime, so a test can drive rotation while an
 * agent — which can only run the real command — still cannot.
 */
export type SecretPrompt = (message: string) => Promise<string>;

/** What a yes/no prompt is. Same reasoning as SecretPrompt. */
export type ConfirmPrompt = (message: string, defaultYes?: boolean) => Promise<boolean>;

/**
 * Ask for the currently-enrolled passphrase. Returns false, having said why,
 * when it does not match — callers decide whether that is fatal (both current
 * callers exit). Same contract as promptAndStore below.
 *
 * INVARIANT: rotation and deletion both go through this. Without it, "delete,
 * then enroll my own" is a one-step way around the gate for anything that can
 * reach this command. Unit-tested via the injected prompt in
 * test/unit/system-passphrase-gating.test.ts.
 */
export async function requireCurrentPassphrase(
  verb: string,
  prompt: SecretPrompt = promptSecret,
): Promise<boolean> {
  const current = await prompt('Current approval passphrase');
  if (!(await verifyPassphrase(current))) {
    console.error(
      `That is not the current approval passphrase — nothing was ${verb}.\n` +
      `There is no recovery path by design. If it is genuinely lost, delete the store by hand ` +
      `and enroll again:\n\n  rm ${passphraseStorePath()}\n  lazy system passphrase set`,
    );
    return false;
  }
  return true;
}

/**
 * Offer to delete a leftover pre-v0.23 plaintext passphrase file.
 *
 * The old file is never consulted any more, so leaving it costs nothing
 * functionally — but it is the human's old passphrase sitting in the clear in a
 * tree every agent can read, which is the exact hazard this move removed. The
 * human is at a TTY and in the project right now, so this is the one moment
 * where asking is cheap.
 */
export async function offerLegacyCleanup(
  confirm: ConfirmPrompt = promptYesNo,
  projectRoot: string | null = findLazyRoot(),
): Promise<void> {
  const root = projectRoot;
  if (!root) return;
  if (!(await legacyPassphraseFileExists(root))) return;

  const path = legacyPassphrasePath(root);
  console.log('');
  console.log(theme.warning(`Found a leftover plaintext passphrase file: ${path}`));
  console.log('It is no longer consulted, but it still holds your OLD passphrase in the clear,');
  console.log('inside a repository every task agent can read.');
  if (!(await confirm('Delete it now?', true))) {
    console.log(theme.separator(`Left in place. Delete it yourself with: rm ${path}`));
    return;
  }
  await removeLegacyPassphraseFile(root);
  console.log(theme.success(`Deleted ${path}`));
}

/** The no-recovery warning, printed wherever first enrollment happens. */
function printFirstEnrollmentNotice(): void {
  console.log(theme.separator(
    'It covers every lazy project you work on here, is stored as a hash (never in the clear),',
  ));
  console.log(theme.separator(
    'and CANNOT be recovered — if you forget it, you delete the store and enroll again.',
  ));
}

/**
 * Ask for a new passphrase twice and store it. Returns false (having said why)
 * when the entries are too short or disagree — callers decide whether that is
 * fatal. `lazy system passphrase set` exits; `lazy init`'s offer just moves on.
 */
export async function promptAndStore(
  rotating = false,
  prompt: SecretPrompt = promptSecret,
): Promise<boolean> {
  // Both the length rule and the two-entries-agree check run on the NORMALIZED
  // form, because that is what gets hashed. Comparing the raw strings would
  // reject two entries that differ only by an invisible trailing space — even
  // though the store would have treated them as the same passphrase.
  const next = normalizePassphrase(await prompt('New approval passphrase'));
  if (next.length < MIN_LENGTH) {
    console.error(
      `Approval passphrase must be at least ${MIN_LENGTH} characters. Nothing was changed.`,
    );
    return false;
  }
  const again = normalizePassphrase(await prompt('Confirm approval passphrase'));
  if (again !== next) {
    console.error('The two entries do not match. Nothing was changed.');
    return false;
  }
  const path = await writePassphrase(next);
  console.log(theme.success(rotating ? 'Approval passphrase rotated.' : 'Approval passphrase enrolled.'));
  console.log(theme.separator(`  ${path} (hashed, mode 0600, outside every repository)`));
  return true;
}

/**
 * Enrollment as offered by `lazy init` when the human turns protection on.
 *
 * Returns 'already' without asking anything when this machine is enrolled —
 * the passphrase is machine-global, so a second `lazy init` in a second repo
 * must not re-ask for a credential that already exists. Never exits the
 * process: init has more to do afterwards, and a mistyped confirmation is not
 * a reason to abandon initialization.
 *
 * Deliberately does NOT take requireHumanTerminal's hard refusal of the prompt
 * test seams: init's own TTY gate already decided a human is here, and the
 * offer has to stay e2e-testable end to end. In a released binary the seams do
 * not exist at all (RELEASE_BUILD in src/cli/editor.ts), which is what actually
 * closes the non-interactive route on a user's machine.
 */
export async function enrollAtInit(): Promise<'already' | 'enrolled' | 'failed'> {
  if (await isPassphraseEnrolled()) return 'already';
  printFirstEnrollmentNotice();
  try {
    return (await promptAndStore()) ? 'enrolled' : 'failed';
  } catch (err) {
    if (err instanceof PromptCancelledError) {
      console.log('Cancelled — no passphrase was enrolled.');
      return 'failed';
    }
    throw err;
  }
}

async function setPassphrase(): Promise<void> {
  await requireHumanTerminal('set');

  const enrollment = await readPassphraseEnrollment();
  if (enrollment.enrolled) {
    console.log(`Rotating the approval passphrase enrolled on this machine.`);
    if (!(await requireCurrentPassphrase('changed'))) process.exit(1);
  } else {
    console.log('Enrolling an approval passphrase for this machine.');
    printFirstEnrollmentNotice();
  }

  if (!(await promptAndStore(enrollment.enrolled))) process.exit(1);
  console.log('Every lazy project on this machine uses it. `lazy approve` asks for it when a');
  console.log('merge crosses a protected branch or task.');

  await offerLegacyCleanup();
}

async function deleteEnrollment(): Promise<void> {
  await requireHumanTerminal('delete');

  const enrollment = await readPassphraseEnrollment();
  if (!enrollment.enrolled) {
    console.log('No approval passphrase is enrolled on this machine — nothing to delete.');
    return;
  }

  // Gated on the current passphrase for the same reason rotation is: otherwise
  // "delete, then enroll my own" is a one-step way around the gate for anything
  // that reaches this command.
  if (!(await requireCurrentPassphrase('deleted'))) process.exit(1);
  await deletePassphrase();
  console.log(theme.success('Approval passphrase deleted.'));
  console.log(
    'Protected merges now fail closed: `lazy approve` will refuse and point back at ' +
    '`lazy system passphrase set`.',
  );
}

/**
 * `status` says whether a passphrase exists, where the store is, and when it
 * was last set. It deliberately says nothing about the VALUE — not its length,
 * not a prefix, not a hint. A status command is the one surface an agent can
 * reach freely, so it must leak nothing that narrows a guess.
 */
async function showStatus(): Promise<void> {
  const enrollment = await readPassphraseEnrollment();

  if (enrollment.enrolled) {
    console.log(theme.success('Approval passphrase: enrolled'));
    console.log(theme.separator(`  Store:    ${enrollment.path} (hashed, mode 0600)`));
    if (enrollment.updatedAt) {
      console.log(theme.separator(`  Last set: ${enrollment.updatedAt}`));
    }
    console.log(theme.separator('  Scope:    every lazy project on this machine'));
  } else {
    console.log('Approval passphrase: not enrolled');
    console.log(theme.separator(`  Store:    ${enrollment.path} (does not exist)`));
    console.log('');
    console.log('Merges into a protected branch or task will fail closed until you run:');
    console.log('  lazy system passphrase set');
  }

  const root = findLazyRoot();
  if (root && (await legacyPassphraseFileExists(root))) {
    console.log('');
    console.log(theme.warning(
      `Leftover plaintext passphrase file: ${legacyPassphrasePath(root)}`,
    ));
    console.log('It is no longer consulted. Delete it — it holds a passphrase in the clear');
    console.log('inside a repository every task agent can read.');
  }
}

export async function commandSystemPassphrase(args: string[]): Promise<void> {
  const sub = args[0];

  try {
    switch (sub) {
      case undefined:
      case 'status':
        await showStatus();
        break;
      case 'set':
        await setPassphrase();
        break;
      case 'delete':
        await deleteEnrollment();
        break;
      default:
        console.error(`Unknown subcommand: system passphrase ${sub}`);
        systemPassphraseUsage();
        process.exit(1);
    }
  } catch (err) {
    // Ctrl-C at a masked prompt is "the human said no", not a crash to report.
    if (err instanceof PromptCancelledError) {
      console.log('\nCancelled — nothing was changed.');
      process.exit(1);
    }
    throw err;
  }
}

export function systemPassphraseUsage(): void {
  console.log(`Usage: lazy system passphrase [status|set|delete]

Manage the approval passphrase that \`lazy approve\` asks for when a merge
crosses a protected branch or task.

The passphrase is stored HASHED at ${passphraseStorePath()}
(mode 0600), outside every repository, and covers every lazy project on this
machine — enroll it once. It is never stored in the clear and cannot be
recovered; a forgotten passphrase is re-enrolled, not recovered.

Subcommands:
  status (default)  Whether a passphrase is enrolled, where the store lives,
                    and when it was last set. Never reveals or hints at the
                    value itself.
  set               Enroll or rotate. Typed twice at a masked prompt; rotating
                    first asks for the current passphrase.
  delete            Un-enroll (also requires the current passphrase). Protected
                    merges then fail closed until you enroll again.

Forgot it? There is no recovery — the store holds a hash, not the passphrase.
Both \`set\` (rotation) and \`delete\` ask for the current one, so the way back is
to remove the store yourself and enroll again:

  rm ${passphraseStorePath()}
  lazy system passphrase set

That is a local file only you can write; it resets the passphrase, nothing else.

Interactive terminal ONLY: there is deliberately no flag, environment
variable, or piped-stdin form, and the command refuses to run inside a
container. A passphrase supplied non-interactively lands in shell history, CI
config, or an agent transcript — this credential exists to show a human typed
it. For the same reason there is no MCP tool and no daemon RPC: enrollment
happens in this process, on the host, while verification stays daemon-side.

Examples:
  lazy system passphrase              # is anything enrolled on this machine?
  lazy system passphrase set          # enroll, or rotate an existing one
  lazy system passphrase delete       # un-enroll`);
}
