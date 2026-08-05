import { parseFlags } from '../helpers';
import { isTTY, promptLine, readStdinIfPiped } from '../editor';
import { queryApproveTask, queryApproveTaskPreflight } from '../../daemon/rpc-fallback';
import { theme } from '../theme';

/**
 * `lazy approve <task>` — record a one-shot human approval that unlocks
 * exactly one accept into a protected branch (see docs/protected-branches.md).
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

  // Token sources: piped stdin, else interactive prompt. There is no flag on
  // purpose — a flag value would sit in shell history and agent transcripts.
  let token = await readStdinIfPiped();
  if (token === null) {
    if (!isTTY()) {
      console.error('Error: no approval passphrase provided.');
      console.error('Run interactively, or pipe the passphrase: echo "..." | lazy approve <task>');
      process.exit(1);
    }
    // Name the source of truth so the human knows what they are being asked
    // for and where to change it.
    token = await promptLine(
      sourceLabel ? `Approval passphrase (from ${sourceLabel})` : 'Approval passphrase',
    );
  }

  if (!token.trim()) {
    console.error('Error: the approval passphrase must not be empty.');
    process.exit(1);
  }

  try {
    const result = await queryApproveTask({ taskId, token: token.trim() });

    console.log(theme.success(`\nApproval recorded for task ${result.displayId}.`));
    if (result.replacedPending) {
      console.log('(A previous unconsumed approval was replaced.)');
    }
    console.log(`The next ${theme.command('lazy accept ' + result.displayId)} into a protected branch will consume it.`);
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

The approval passphrase is read from piped stdin or an interactive prompt and
checked against the file configured by [protection].passphrase_file
(default: .lazy/approve-passphrase — create it out-of-band, it is gitignored).

Arguments:
  <task_id>    ID of the task whose next protected accept should be unlocked

Examples:
  lazy approve abc12345                 # Prompts for the passphrase
  echo "s3cret" | lazy approve abc12345 # Passphrase from stdin

  # CI / scripting: keep the passphrase in a secret, never on the command line
  echo "$LAZY_APPROVE_PASSPHRASE" | lazy approve abc12345

There is deliberately NO --yes for this command, and no MCP equivalent: the
approval token must originate outside the builder/agent context, or the gate is
decoration. Piped stdin is the supported script-friendly path — the passphrase
comes from your secret store, not from anything an agent can reach.
See docs/protected-branches.md.`);
}
