/**
 * Every CLI command that asks a human to TYPE something and then writes to the
 * store must ask the daemon who they are FIRST.
 *
 * WHY A SOURCE SCAN, in the shape of `cli-flag-alias-coverage` and
 * `cli-subcommand-usage-coverage`: this is the project's most important
 * invariant (CLAUDE.md, "Never Lose Human Feedback") and the failure is
 * invisible until it costs somebody their words. The daemon refuses a write it
 * cannot attribute; a command that collects a sign-off reason, a task prompt or
 * a journal entry BEFORE finding that out throws the text away. Six commands
 * had the check when the identity gate landed and eleven did not, while
 * CLAUDE.md already claimed all of them did — so the rule is now enforced
 * rather than described.
 *
 * A new command that prompts for content is failed by this test until it is
 * classified: it either calls `requireActorIdentity()` or says here why it does
 * not need to.
 */

import { describe, test, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const COMMANDS_DIR = join(import.meta.dir, '..', '..', 'src', 'cli', 'commands');

/**
 * Prompts that collect CONTENT — something a human composes and would have to
 * type again.
 *
 * `promptYesNo` is deliberately absent: answering a confirmation again costs
 * one keystroke, and the commands whose only prompt is a confirmation
 * (`lazy upgrade`, `lazy pair`) would otherwise be dragged in for nothing.
 */
const CONTENT_PROMPTS = [
  'openEditor',
  'promptLine',
  'promptSecret',
  'getEditorFeedback',
  'runFeedbackFlow',
];

/**
 * Files that prompt for content and correctly do NOT preflight, each with the
 * reason. Anything here is a deliberate decision; anything NOT here and not
 * calling `requireActorIdentity` fails the test.
 */
const EXEMPT: Record<string, string> = {
  // Credential entry. The secret goes to a keychain/env, not to the store —
  // and being unable to record WHO stored a credential is not a reason to
  // refuse someone the credential they need to work at all.
  'auth.ts': 'stores a credential, writes no task row',
  'env.ts': 'stores a credential, writes no task row',
  'system-agent.ts': 'stores a credential, writes no task row',
  // Confirmations and menu picks, not composed text: "Type 'yes' to proceed",
  // "Press Enter when ready", "Pick a session [1-3]".
  'pair.ts': 'prompts only to confirm, nothing typed is lost',
  'builder.ts': 'prompts only to confirm, nothing typed is lost',
  'upgrade.ts': 'prompts only to confirm, nothing typed is lost',
  // Not a command: the shared editor/feedback helpers these commands call.
  // Its callers (`unblock`, `loop`) carry the check.
  'shared.ts': 'shared helper, not a command — its callers check',
};

describe('CLI identity preflight coverage', () => {
  // INVARIANT: a command that collects typed content and writes to the store
  // calls requireActorIdentity() before the prompt. Never after — the point is
  // that the editor does not open on a write the daemon will refuse.
  test('every content-prompting command preflights the identity', () => {
    const missing: string[] = [];

    for (const file of readdirSync(COMMANDS_DIR).filter(f => f.endsWith('.ts')).sort()) {
      const source = readFileSync(join(COMMANDS_DIR, file), 'utf8');
      const prompts = CONTENT_PROMPTS.filter(p => new RegExp(`\\b${p}\\s*\\(`).test(source));
      if (prompts.length === 0) continue;
      if (file in EXEMPT) continue;
      if (!source.includes('requireActorIdentity(')) {
        missing.push(`${file} (prompts with ${prompts.join(', ')})`);
      }
    }

    expect(missing).toEqual([]);
  });

  // Importing the check and never calling it is the one way to satisfy the
  // scan above without satisfying the rule.
  //
  // WHERE the call sits is NOT scanned, deliberately: several of these commands
  // prompt from a helper defined above the command function (`promptForReason`
  // in `close`, `obtainQuestion` in `ask`), so source ORDER says nothing about
  // call order and a position test flags them wrongly. That half is proven
  // behaviourally instead, in test/e2e/git-identity.test.ts, which installs an
  // `$EDITOR` that leaves a marker file and asserts the marker never appears.
  test('a command that imports the check also calls it', () => {
    const unused = readdirSync(COMMANDS_DIR)
      .filter(f => f.endsWith('.ts'))
      .filter(file => {
        const source = readFileSync(join(COMMANDS_DIR, file), 'utf8');
        return source.includes('identity-preflight')
          && !source.includes('await requireActorIdentity(');
      });

    expect(unused).toEqual([]);
  });

  // An exemption that names a file nobody prompts in any more is a rule nobody
  // is applying — it should be deleted with the prompt it excused.
  test('every exemption still names a prompting command', () => {
    const stale = Object.keys(EXEMPT).filter(file => {
      let source: string;
      try {
        source = readFileSync(join(COMMANDS_DIR, file), 'utf8');
      } catch {
        return true;
      }
      return !CONTENT_PROMPTS.some(p => new RegExp(`\\b${p}\\s*\\(`).test(source));
    });

    expect(stale).toEqual([]);
  });
});
