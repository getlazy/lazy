/**
 * "Is a PERSON at a real terminal running this?" — for the few CLI commands
 * whose whole point is that a model cannot run them: setting the approval
 * passphrase (src/cli/commands/system-passphrase.ts) and setting the one-shot
 * usage-pause override (src/cli/commands/daemon-config.ts).
 *
 * An agent or the builder runs lazy from a tool call: no terminal on stdin,
 * usually inside a container, and — when it runs lazy from source, as every
 * agent working on lazy itself does — with the test prompt seams available.
 * Each is refused, with the reason and what to do instead.
 */

import { isRunningInContainer } from '../utils/container';
import { getActor } from '../constants';
import type { Actor } from '../types';

/**
 * The test-only prompt seams. `LAZY_FORCE_TTY` makes isTTY() lie,
 * `LAZY_PROMPT_DEFAULTS` makes every prompt auto-answer, and
 * `LAZY_PROMPT_SECRET` supplies the value a masked prompt "types". Together
 * they are a complete non-interactive route through a prompt. They are compiled
 * out of released binaries (see RELEASE_BUILD in src/cli/editor.ts); this list
 * is the belt to those braces, and also covers running from source.
 */
export const PROMPT_TEST_SEAMS = ['LAZY_FORCE_TTY', 'LAZY_PROMPT_DEFAULTS', 'LAZY_PROMPT_SECRET'] as const;

/**
 * Why this process is NOT a person at their own terminal, or null when it is.
 *
 * Reads process.stdin.isTTY directly, never isTTY(): that helper honours
 * `LAZY_FORCE_TTY`, and reading stdin directly means a future seam cannot
 * quietly reopen this. The consequence — the happy path cannot be driven from
 * an e2e test — is the point: anything a test can drive, an agent can drive.
 */
export async function notAHumanTerminal(): Promise<string | null> {
  if (await isRunningInContainer()) {
    return 'it is running inside a container, where lazy\'s agents and builder run';
  }
  const seam = PROMPT_TEST_SEAMS.find((name) => process.env[name]);
  if (seam) {
    return `${seam} is set — a test seam that makes lazy's prompts answerable without a human, never set on a real machine`;
  }
  if (!process.stdin.isTTY) {
    return 'there is no interactive terminal on stdin (a script, a pipe or an agent\'s tool call)';
  }
  return null;
}

/**
 * The channel to name when a command asks the daemon to admit it past the
 * usage pause (`lazy report`, `lazy ask <conversation>`, `lazy pair`,
 * `lazy chat`): this CLI's channel when a person is at a real terminal, and
 * NONE otherwise.
 *
 * INVARIANT: only a person at their own terminal may TAKE the one-shot
 * usage-pause override, not merely set it. `getActor()` answers `human` for any
 * CLI process without `LAZY_ACTOR=builder` — an agent's tool call included — so
 * naming it unconditionally let any process spend the override a person had
 * set. A call that names no channel is judged on the configured threshold
 * alone (src/daemon/usage-pause.ts), which is exactly the refusal it would get
 * without an override.
 */
export async function overrideEligibleActor(): Promise<Actor | undefined> {
  return (await notAHumanTerminal()) === null ? getActor() : undefined;
}

/**
 * May this CLI process be TOLD about the one-shot usage-pause override — the
 * command that sets it? Only when it could use it: a person on the human
 * channel at a real terminal.
 *
 * INVARIANT: the CLI never names the override to a caller the daemon would not
 * name it to. The builder (and an agent) runs `lazy unblock` or `lazy daemon
 * config get` from its own shell; the daemon's refusal is careful not to spell
 * out the escape hatch to it, and a CLI hint that did would undo that.
 */
export async function mayOfferUsagePauseOverride(): Promise<boolean> {
  return (await overrideEligibleActor()) === 'human';
}

/**
 * What a launch command (`lazy start`, `unblock`, `resume`, `review`,
 * `ask`, `sync`) sends so the daemon lets it TAKE the one-shot usage-pause
 * override: `{ usagePauseOverrideEligible: true }` only for a person at their
 * own terminal, nothing otherwise. The command's ACTOR stays `human` either
 * way — that is attribution, and the daemon no longer reads it as a person
 * asking (src/daemon/usage-pause.ts, `overrideEligible`).
 */
export async function usagePauseOverrideEligibility(): Promise<{ usagePauseOverrideEligible?: true }> {
  return (await mayOfferUsagePauseOverride()) ? { usagePauseOverrideEligible: true } : {};
}
