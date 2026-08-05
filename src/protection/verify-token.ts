/**
 * verifyHumanToken seam — pluggable verification of the human-supplied token
 * that satisfies the edge gate.
 *
 * The one property the mechanism must have: the token originates OUTSIDE the
 * builder's context (the human's eyes/keyboard, not an MCP tool result). The
 * first-cut mechanism is a static passphrase in a file the human writes
 * out-of-band; a TOTP verifier can replace it behind this same interface
 * without touching enforcement or the CLI.
 *
 * Friction-grade by design: no hashing, no rate limiting, no replay defense —
 * those answer a security question this feature deliberately does not ask
 * (docs/spikes/protected-tasks-and-epics.md §1.1).
 */

import { readFile } from 'fs/promises';
import { resolve } from 'path';
import type { ResolvedConfig } from '../config';

export interface HumanTokenVerification {
  ok: boolean;
  /**
   * Actionable message when verification fails. NEVER contains the expected
   * token — this message travels back over channels the builder can read.
   */
  message: string;
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
  /** Mechanism name, for logs and error context (e.g. "static-passphrase"). */
  readonly kind: string;
  /**
   * Where the human gets the token, for the interactive prompt (e.g.
   * `.lazy/approve-passphrase`). `null` when the mechanism has no
   * user-visible source worth naming.
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

/**
 * Static passphrase verifier: compares the supplied token against the contents
 * of a file the human created out-of-band. The file lives under `.lazy/`
 * (gitignored) and is never surfaced through MCP tools.
 */
class StaticPassphraseVerifier implements HumanTokenVerifier {
  readonly kind = 'static-passphrase';

  readonly sourceLabel: string;

  constructor(
    private readonly passphrasePath: string,
    /** Config-relative path, for user-facing messages. */
    private readonly displayPath: string,
  ) {
    this.sourceLabel = displayPath;
  }

  /**
   * Read the enrolled passphrase. Shared by verify() and probeEnrollment() so
   * the pre-flight message and the verification message can never drift apart.
   */
  private async readEnrolled(): Promise<{ ok: true; expected: string } | { ok: false; message: string }> {
    let raw: string;
    try {
      raw = await readFile(this.passphrasePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          ok: false,
          message:
            `No approval passphrase is enrolled. Create one (as the human, out-of-band) with:\n\n` +
            `  echo "your-passphrase" > ${this.displayPath}\n\n` +
            `then re-run \`lazy approve\`. The path is configurable via [protection].passphrase_file in lazy.toml.`,
        };
      }
      throw new Error(
        `Failed to read approval passphrase file ${this.passphrasePath}: ` +
        `${err instanceof Error ? err.message : err}`,
      );
    }

    const expected = raw.trim();
    if (!expected) {
      return {
        ok: false,
        message:
          `The approval passphrase file ${this.displayPath} is empty. ` +
          `Write a non-empty passphrase to it, then re-run \`lazy approve\`.`,
      };
    }

    return { ok: true, expected };
  }

  async probeEnrollment(): Promise<EnrollmentProbe> {
    const enrolled = await this.readEnrolled();
    return enrolled.ok
      ? { status: 'enrolled' }
      : { status: 'not-enrolled', message: enrolled.message };
  }

  async verify(token: string): Promise<HumanTokenVerification> {
    const enrolled = await this.readEnrolled();
    if (!enrolled.ok) {
      return { ok: false, message: enrolled.message };
    }
    const expected = enrolled.expected;

    if (token.trim() !== expected) {
      return { ok: false, message: 'Approval passphrase does not match.' };
    }

    return { ok: true, message: '' };
  }
}

/**
 * Create the configured human-token verifier. Static passphrase is the only
 * mechanism today; alternatives (TOTP) plug in here by returning a different
 * implementation based on config.
 */
export function createHumanTokenVerifier(
  config: ResolvedConfig,
  projectRoot: string,
): HumanTokenVerifier {
  const displayPath = config.protection.passphrase_file;
  return new StaticPassphraseVerifier(resolve(projectRoot, displayPath), displayPath);
}
