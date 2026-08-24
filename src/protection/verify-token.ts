/**
 * verifyHumanToken seam — pluggable verification of the human-supplied token
 * that satisfies the edge gate.
 *
 * The one property the mechanism must have: the token originates OUTSIDE the
 * builder's context (the human's eyes/keyboard, not an MCP tool result). The
 * mechanism today is a passphrase the human enrolls once per machine with
 * `lazy system passphrase set` and types at `lazy approve`'s own prompt; a TOTP
 * verifier can replace it behind this same interface without touching
 * enforcement or the CLI.
 *
 * Friction-grade by design: no rate limiting, no replay defense — those answer
 * a security question this feature deliberately does not ask
 * (docs/spikes/protected-tasks-and-epics.md §1.1). The passphrase IS hashed at
 * rest, which is a different question: the store is readable by a host-process
 * agent, so it must not hand that agent the secret verbatim (see
 * src/protection/passphrase-store.ts).
 */

import {
  verifyPassphrase,
  isPassphraseEnrolled,
  legacyPassphraseFileExists,
  legacyPassphrasePath,
} from './passphrase-store';

export interface HumanTokenVerification {
  ok: boolean;
  /**
   * Actionable message when verification fails. NEVER contains the expected
   * token — this message travels back over channels the builder can read.
   */
  message: string;
  /**
   * True ONLY when a token was checked against an enrolled secret and did not
   * match — i.e. a retryable human typo, not "nothing is enrolled here". The
   * two need different remedies: retype vs go enroll.
   */
  mismatch?: boolean;
}

/**
 * Result of asking a verifier "could any token possibly succeed right now?"
 * without asking the human for one.
 *
 * `unknown` is the honest answer for mechanisms that cannot tell without a
 * token in hand (a TOTP verifier has no file to probe). Callers MUST treat it
 * as "carry on and ask" — i.e. the pre-v0.20 behavior — never as a failure.
 */
export type EnrollmentProbe =
  | { status: 'enrolled' }
  | { status: 'not-enrolled'; message: string }
  | { status: 'unknown' };

export interface HumanTokenVerifier {
  /** Mechanism name, for logs and error context (e.g. "global-passphrase"). */
  readonly kind: string;
  /**
   * Where the human gets the token, for the interactive prompt. `null` when the
   * mechanism has no user-visible source worth naming — which is the case for
   * the machine-global passphrase: there is no path to read it from, only the
   * human's memory.
   */
  readonly sourceLabel: string | null;
  verify(token: string): Promise<HumanTokenVerification>;
  /**
   * Cheap pre-flight probe, run BEFORE the human is prompted. Never asks for
   * or inspects a token. See CLAUDE.md: checks that can fail must run before
   * we ask a human to type something the check would have rejected anyway.
   */
  probeEnrollment(): Promise<EnrollmentProbe>;
}

/** How every "nothing is enrolled" message tells the human what to do. */
function enrollmentInstructions(): string {
  return (
    `No approval passphrase is enrolled on this machine. As the human, at your own terminal, run:\n\n` +
    `  lazy system passphrase set\n\n` +
    `then re-run \`lazy approve\`. The passphrase is stored hashed, outside every repository, ` +
    `and covers every lazy project on this machine — enroll it once.`
  );
}

/**
 * Global passphrase verifier: compares the supplied token against the hash in
 * the machine-level store (`~/.lazy/passphrase.json`).
 *
 * `projectRoot` is used for ONE thing: noticing a leftover pre-v0.23
 * `.lazy/approve-passphrase` plaintext file so the not-enrolled message can
 * tell the human it is dead and must be deleted. That file is NEVER read.
 */
class GlobalPassphraseVerifier implements HumanTokenVerifier {
  readonly kind = 'global-passphrase';

  /**
   * Nothing to name: the passphrase lives in the human's head, and the store
   * holds only a hash. A path here would invite them to go read it.
   */
  readonly sourceLabel: string | null = null;

  constructor(private readonly projectRoot: string) {}

  /**
   * Append the "your old plaintext file is dead" note when one is lying
   * around. Migration is hard on purpose — the old file is not consulted, so
   * the human must re-enroll and delete it.
   */
  private async withLegacyNote(message: string): Promise<string> {
    if (!(await legacyPassphraseFileExists(this.projectRoot))) return message;
    return (
      `${message}\n\n` +
      `Note: ${legacyPassphrasePath(this.projectRoot)} still exists. That file is no longer ` +
      `consulted — it held your passphrase in PLAINTEXT inside the repo, where every task ` +
      `agent could read it. Enroll the same phrase with \`lazy system passphrase set\` ` +
      `(which offers to delete the old file), or delete it yourself.`
    );
  }

  async probeEnrollment(): Promise<EnrollmentProbe> {
    if (await isPassphraseEnrolled()) return { status: 'enrolled' };
    return { status: 'not-enrolled', message: await this.withLegacyNote(enrollmentInstructions()) };
  }

  async verify(token: string): Promise<HumanTokenVerification> {
    if (!(await isPassphraseEnrolled())) {
      return { ok: false, message: await this.withLegacyNote(enrollmentInstructions()) };
    }
    // Passed RAW: the store normalizes both what it hashes and what it checks,
    // and it is the only place that may (see normalize() there).
    if (!(await verifyPassphrase(token))) {
      return { ok: false, message: 'Approval passphrase does not match.', mismatch: true };
    }
    return { ok: true, message: '' };
  }
}

/**
 * Create the configured human-token verifier. The machine-global passphrase is
 * the only mechanism today; alternatives (TOTP) plug in here by returning a
 * different implementation.
 */
export function createHumanTokenVerifier(projectRoot: string): HumanTokenVerifier {
  return new GlobalPassphraseVerifier(projectRoot);
}
