# lazy protect

This page is generated from `lazy protect --help`.

```text
Usage: lazy protect [<branch|task>] [on|off] [--branch|--task]

Manage branch protection — which merges require a HUMAN approval (the
passphrase typed at 'lazy accept''s own prompt). All settings live in the
[protection] section of lazy.toml; this command edits that section, preserving
its comments.

The passphrase itself is NOT configured here or anywhere in the repository: it
lives hashed outside every repo, one per machine. Enroll it once with
'lazy system passphrase set'.

With no arguments, prints the current protection state.

Two directions, one verb:
  BRANCH   protects merges coming IN — accepting any task into that branch
           requires approval.
  TASK     protects that task's work going OUT — merging its branch upward
           requires approval regardless of the target branch.

<branch|task> resolves as a task code or short id FIRST, then as a branch
name. Pass --branch or --task to settle it explicitly.

Protection is opt-in — off until something turns it on. Turning any target ON
also sets [protection] enabled = true (announced, never silent), so
'lazy protect main on' is the one step from a stock project to a gated one.
Turning a target OFF never touches that switch; while protection is disabled
such an edit is saved but has no effect, and the command says so.

Arguments:
  <branch|task>  Branch name, or task code / short id
  on|off         Add or remove protection for that target

Options:
  --branch       Treat the argument as a branch name, never a task
  --task         Treat the argument as a task, never a branch

Examples:
  lazy protect                          # Show current protection state
  lazy protect release on               # Protect merges INTO 'release'
  lazy protect add-auth on              # Protect merges OUT OF task 'add-auth'
  lazy protect --branch main off        # Stop protecting the 'main' branch
  lazy protect add-auth off             # Remove the task gate

This command has no MCP equivalent on purpose: the builder must not manage
its own gates.

Documentation: https://docs.getlazy.dev/protected-branches
```
