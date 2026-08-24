import { parseFlags } from '../helpers';
import { isTTY, promptSecret, PromptCancelledError } from '../editor';
import { queryApproveTask, queryApproveTaskPreflight } from '../../daemon/rpc-fallback';
import { theme } from '../theme';
import { docsFooter } from '../../docs/links';

/**
 * `lazy approve <task>` — record a one-shot human approval that unlocks
 * exactly one accept into a protected branch (see public-docs/protected-branches.md).
 *
 * This command is the deliberate human act branch protection requires. It is
 * CLI-only by design: there is NO MCP equivalent, so the builder cannot
 * approve its own work. The passphrase is verified by the daemon through the
 * verifyHumanToken seam and never appears in any output the builder reads.
 */
export async function commandApprove(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [], 'approve');

  const taskId = parsed.positional[0];
  if (!taskId) {
    approveUsage();
    process.exit(1);
  }

  // Pre-flight BEFORE asking for anything (CLAUDE.md: checks that can fail run
  // before we prompt a human). Without an enrolled passphrase no token can
  // possibly verify, so prompting for one only wastes the human's typing.
  let sourceLabel: string | null = null;
  try {
    const preflight = await queryApproveTaskPreflight({ taskId });
    if (preflight.enrollment === 'not-enrolled') {
      console.error(`Error: ${preflight.message}`);
      process.exit(1);
    }
    // 'unknown' (a mechanism that cannot tell without a token, e.g. TOTP)
    // falls through to the normal ask-then-verify path.
    sourceLabel = preflight.sourceLabel;
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  // The prompt is TTY-only BY DESIGN: there is no flag, env var, or stdin
  // route for the passphrase. Any non-interactive value sits in shell history,
  // CI logs and agent transcripts — and the one property this mechanism must
  // keep is that the token originates OUTSIDE anything an agent can reach. The
  // piped-stdin route that used to exist here was exactly such a hole.
  if (!isTTY()) {
    console.error(
      'Error: the approval passphrase is only ever typed at an interactive prompt — there is ' +
      'deliberately no flag, env var, or stdin route for it. Run `lazy approve ' +
      `${taskId}\` from a terminal.`,
    );
    process.exit(1);
  }

  // Name the source of truth (when there is one worth naming) so the human
  // knows what they are being asked for. promptSecret, never promptLine: this
  // is a secret, and an echoed one is visible in scrollback and screen shares.
  let token: string;
  try {
    // Sent RAW below — the store is the one place that normalizes a
    // passphrase, so nothing here may trim it. The emptiness check trims only
    // to decide whether the human just pressed Enter.
    token = await promptSecret(
      sourceLabel ? `Approval passphrase (from ${sourceLabel})` : 'Approval passphrase',
    );
  } catch (err) {
    if (err instanceof PromptCancelledError) {
      console.error('Aborted: no approval recorded.');
      process.exit(130);
    }
    // promptSecret can fail three ways, and only ONE of them is "this is not
    // a terminal": it also rejects on a genuine stdin I/O error, and when the
    // terminal refuses raw mode (EIO and friends). Naming the not-a-TTY cause
    // for all three would be a guess presented as an explanation — so anything
    // we cannot identify surfaces its real message. The pointer at a terminal
    // is appended either way, because it is the only route to this prompt.
    const message = err instanceof Error ? err.message : String(err);
    const notATerminal = message.includes('not an interactive terminal');
    console.error(
      notATerminal
        ? 'Error: cannot read the approval passphrase without echoing it: stdin is not an ' +
          'interactive terminal.'
        : `Error: could not read the approval passphrase: ${message}`,
    );
    console.error(`Run \`lazy approve ${taskId}\` from a terminal.`);
    process.exit(1);
  }

  if (!token.trim()) {
    console.error('Error: the approval passphrase must not be empty.');
    process.exit(1);
  }

  try {
    const result = await queryApproveTask({ taskId, token });

    console.log(theme.success(`\nApproval recorded for task ${result.displayId}.`));
    if (result.replacedPending) {
      console.log('(A previous unconsumed approval was replaced.)');
    }
    console.log(
      `The next ${theme.command('lazy accept ' + result.displayId)} into a protected branch ` +
      `will consume it — but only if it completes. A failed accept leaves the approval pending, ` +
      `so you can retry without approving again.`,
    );
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

export function approveUsage(): void {
  console.log(`Usage: lazy approve <task_id>

Record a one-time HUMAN approval for accepting into a protected branch.

Branch protection is opt-in: it engages only when [protection].enabled = true
in lazy.toml (or after 'lazy protect <branch> on'). When enabled, merging into
the repo's default branch (plus any branches listed in
[protection].protected_branches) requires human approval — 'lazy accept'
refuses until a human records one with this command. One approval unlocks
exactly one accept of the task.

The approval passphrase is enrolled once per MACHINE, hashed and stored outside
every repository ('lazy system passphrase set'). It is NOT a file in the repo
and is not configured in lazy.toml. With nothing enrolled on this machine, this
command refuses and says so — a fresh clone of a protected repo is protected.

The passphrase is typed at this command's own masked prompt and NOWHERE else:
there is deliberately no flag, no env var, and no piped-stdin route. Anything
non-interactive would sit in shell history, CI logs and agent transcripts, and
the one property this gate must keep is that the token comes from outside
anything an agent can reach.

Arguments:
  <task_id>    ID of the task whose next protected accept should be unlocked

Examples:
  lazy approve abc12345         # Prompts (masked) for the passphrase
  lazy system passphrase set    # Enroll this machine's passphrase first

There is deliberately NO --yes for this command, and no MCP equivalent: the
approval token must originate outside the builder/agent context, or the gate is
decoration.${docsFooter('protected-branches')}`);
}
