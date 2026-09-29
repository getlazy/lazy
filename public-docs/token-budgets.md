# Token budgets

`lazy stats budget` shows how much of your model usage allowance is left and
where the tokens went. The same view appears on the dashboard (the **Token
budget** box), on a Lazy Teams project's **Usage** page (the "Token usage" link on the project page), and to the builder agent through
the `lazy_usage_limits` tool, which uses it to plan batches of work.

```
lazy stats budget          # human-readable
lazy stats budget --json   # machine-readable
```

## What it shows

**Credential windows.** For each credential lazy has seen a usage-limit
reading for — for example a Claude subscription's 5-hour and 7-day windows, or
a ChatGPT subscription used by Codex — the percentage used and when it resets,
the tokens lazy saw spent on that credential inside the window, and from those
an estimate:

- **tokens left** — the unused percentage × tokens spent per percent so far;
- **typical turns left** — tokens left ÷ the median size of a recent agent turn
  on that harness.

These are estimates for planning. The provider meters usage by its own rules.
Only tokens lazy can tie to that exact credential are counted, and anything
spent on the same account outside lazy makes the estimate come out lower than
the real headroom.

When lazy cannot make an estimate it says why instead of guessing: the
provider reported no percentage, the window has reset since the last reading,
the window's length is unknown, lazy no longer has a record of the spend in the
window, or too little of the window is used to extrapolate from.

**By harness, by day, by task (last 7 days).** Tokens and turns from each agent
turn's recorded usage. A harness with no usage window reading (for example
Cursor, or Pi on a local model) is marked *tokens only*: its spend is shown and
no budget is invented for it.

Figures are tokens and percentages only; lazy never shows money amounts.

## Planning with it

Before starting a batch of tasks, the builder reads the budget, estimates the
batch as tasks × likely turns × typical turn size, and — if it would not fit
before the window resets — proposes starting the most important work first and
holding the rest. Cluster tasks do the same for their waves of subtasks. This is
advice to you, not a gate: to have lazy actually hold new turns near a limit,
configure `[usage_pause]` in `lazy.toml` (see `lazy stats limits`).

## Who sees what

On a single-person install you see every credential. On Lazy Teams, a member
sees the project's shared credential and their own, never another member's. A
task agent sees only the credential its own turn spends and, in the task list,
only its own task; the harness and day totals and the typical turn size are
project-wide figures that name no credential.
