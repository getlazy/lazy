# lazy fix

This page is generated from `lazy fix --help`.

```text
Usage: lazy fix [--goal <goal>] [--prompt <text>] [--model <model>] [--code <code>] [--parent <task_id>]

Create a debugging/fix task with experimental debugging methodology.
Enforces: reproduce first, instrument to prove hypotheses, verify fix with tests.

The agent is constrained to prove everything through execution rather than
assuming behavior by reading code. This methodology is designed for fixing
subtle bugs that resist traditional debugging approaches.

Options:
  --goal <goal>      Bug or issue to fix (what's broken and symptoms)
  --prompt <text>    Additional context (reproduction steps, error messages, etc.)
  --model <model>    Set model for this task (e.g. opus, sonnet, claude-opus-5-5)
  --code <code>      Human-readable code (e.g. "fix-token-hang", "fix-null-deref")
                     Lowercase alphanumeric + hyphens, 2-63 chars
  --parent <task_id> Parent task ID (creates a child task)

Prompt input priority: --prompt flag > piped stdin > $EDITOR (interactive)

The debugging methodology:
  1. Reproduce the bug first (test, script, or manual steps)
  2. Instrument code with assertions/logs to prove hypotheses
  3. Run and observe actual behavior (don't assume from reading)
  4. Fix with evidence, not theory
  5. Verify fix passes reproduction and full test suite
  6. Leave regression test to prevent reintroduction

Examples:
  lazy fix --goal "Token refresh hangs on expired tokens" --code fix-token-hang
  lazy fix --goal "Null pointer in session cleanup" --prompt "Crashes on logout"
  lazy fix --goal "Race condition in worker pool"
  lazy fix                                    # Interactive mode
  echo "Error: ENOENT when path has spaces" | lazy fix --goal "Path handling bug"
```
