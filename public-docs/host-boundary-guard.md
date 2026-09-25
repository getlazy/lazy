# The host file-tool boundary guard

This page describes the guard that checks whether Claude Code still honours
lazy's file-tool deny rules when an agent runs directly on a host, and how to run
it yourself with `lazy system verify-host-boundary`.

> **Note:** Lazy does not offer a user-facing host-process runner — agents run
> in Docker or Podman containers. The guard remains for operators who want to
> probe Claude Code's file-tool deny posture on a host; the host-runner
> machinery itself exists only for lazy's own test harness.

A host-process runner leans on **one Claude Code behavior that lazy does not
control**: `permissions.deny` rules must keep governing the `Read`/`Edit`/`Write`
tools even when the agent runs with `--dangerously-skip-permissions`.

That dependency is unavoidable, because the two host boundaries cover different
things:

| Boundary | What it covers | Enforced by |
|---|---|---|
| OS sandbox (Seatbelt / bubblewrap) | `Bash` and its children | the OS |
| `permissions.deny` in `--settings` | the `Read` / `Edit` / `Write` **file tools** | Claude Code |

The file tools **bypass the OS sandbox entirely**. So if a Claude Code upgrade ever
stops honoring deny rules under bypass, every host agent silently becomes porous —
able to read `~/.ssh` and write outside its worktree, with no error anywhere and
nothing in lazy's own code to notice. Verified once on v2.1.170 and again on
v2.1.227; not guaranteed for v-next.

This document describes the standing guard against that regression.

> Network is **not** one of these boundaries. `sandbox_allowed_domains` only
> pre-approves domains so Bash doesn't prompt; under bypass a non-allowlisted
> domain is still reachable. Never describe it as network confinement.

## The probe and its exit-code contract

The probe (a shell script built into lazy) drives **real headless `claude` sessions** against
the posture lazy actually emits and observes what the file tools were allowed to
do. Three modes:

| Command | What it does |
|---|---|
| `--check` | one session: can this host run the guard at all? |
| `--guard` | must-deny checks only — the blocking regression gate |
| (no flag) | the full evidence matrix, including expected SILENT-ALLOWs |

Exit codes are the verdict, and there are three of them because "we couldn't
tell" is a distinct outcome from "it's fine":

| Code | Verdict | Meaning |
|---|---|---|
| `0` | `intact` | nothing violated (with `--check`: the guard can run here) |
| `1` | `violation` | a file-tool deny rule was violated — **the boundary is broken** |
| `2` | `inconclusive` | no verdict reached: missing deps, no auth, or a session hung |

**Neither 1 nor 2 is green.** An inconclusive run proved nothing and must never be
reported as a pass — that false-pass mode is the whole reason the guard exists.

The anti-false-pass mechanism inside the probe is the **control vector**, which
runs first in `--guard`/`--check` mode: it confirms a session can do legitimate
work *inside* its own worktree. Without that check, a session that cannot write
anywhere at all (no auth, broken sandbox) would "pass" every deny check trivially.

Lazy's own CI runs the `--guard` check weekly on macOS and Linux against the latest Claude Code; the two checks below let you verify your own host.

## Runtime preflight — opt-in, off by default

`[runner] verify_sandbox_boundary` only affects the host-process runner, which is
not a user-facing option, so in a normal project the key has no effect. It is
still accepted and validated:

```toml
[runner]
type = "docker"
# verify_sandbox_boundary = "off"          # default
# verify_sandbox_boundary = "once-per-version"
```

With it on, the host runner verifies the boundary before an agent launches and
refuses the launch on a violation. The error names
the Claude Code version, the consequence, and the four ways out (pin an older CC,
switch `type = "docker"`, drop to `permission_mode = "bypass"` knowingly, or set
`verify_sandbox_boundary = "off"` and accept the risk).

### Why `off` is the default

Preflight on *every* launch is indefensible: the guard spends **three real headless
Claude sessions** (~1–2 min, billed) per run. Even once-per-machine would stall the
first launch on any host without an interactive `claude` login — including CI
sandboxes and containers — over a check the operator never asked for. The weekly CI check is the
standing signal; the runtime knob is for operators who want a machine that refuses
to run host agents on an unverified Claude Code.

### Inconclusive does not refuse the launch

`violation` is positive evidence of breakage: refuse. `inconclusive` means *this
machine couldn't answer* — usually no interactive login. Refusing there would let a
missing credential brick an otherwise healthy daemon over a check the operator only
asked to be *informed* by, so the guard logs a prominent `logger.warn` ("the
boundary is UNVERIFIED on this launch") and proceeds. This is the one deliberate
narrowing of fail-hard here.

### Caching

Decisive verdicts are cached in `~/.lazy/host-boundary-guard.json` — machine-scoped,
because the verdict is a property of the host's Claude Code install, not of one
project. The cache key is a fingerprint of:

```
claude --version  +  process.platform  +  the exact --settings JSON lazy emits
```

so a Claude Code upgrade, a platform change, or *any* edit to the deny posture
(`sandbox_deny_read`, `sandbox_deny_write`, `permission_mode`, …) invalidates it
automatically. At most 20 entries are kept. **Inconclusive verdicts are never
cached** — an unanswered question must be re-asked, and caching it would make a
one-off missing login look like a permanent state.

Both writers share one cache: the launch preflight and `lazy system
verify-host-boundary` (in guard mode) write through the same helper with the same
rules. That is what makes `--refresh` genuinely *replace* a stale entry, and lets an operator warm
the cache **before** switching `verify_sandbox_boundary` to `"once-per-version"`
— so the first real task launch does not stall on three headless sessions.
`--check` never writes: "this host can run the guard" is not a verdict about the
boundary.

A cache that cannot be *written* (EACCES, a read-only home, a full disk) warns
and lets the run continue, exactly as a corrupt cache does. It holds nothing that
cannot be recomputed, so the cost is a re-probe — never a refused launch. The
verdict itself is unaffected: a violation still refuses, cached or not.

## On demand — `lazy system verify-host-boundary`

```bash
lazy system verify-host-boundary            # verdict for this project's posture
lazy system verify-host-boundary --check    # can this host run the guard at all?
lazy system verify-host-boundary --refresh  # re-probe after a Claude Code upgrade
lazy system verify-host-boundary --json v.json
```

It probes the **exact** `--settings` posture this project would give a host agent
(built from your lazy.toml exactly as the runner builds it
), prints a cached verdict when one exists, and exits `0`/`1`/`2` on the same
contract as the probe — so it composes in scripts. Under
`permission_mode = "bypass"` it exits 2 and says there is no file-tool boundary to
verify in that posture, rather than probing something meaningless.

A decisive verdict from a guard-mode run is cached here, so the launch preflight
sees it.

## One definition of the boundary

The check `lazy system verify-host-boundary` and the runtime preflight run is
the same probe script lazy's CI runs, built into the `lazy` binary, and it is
given the exact deny settings lazy uses for its agents — so what is verified is
what your agents actually run under.

## Requirements

- a logged-in `claude` (or `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY`)
- `jq`
- a working OS sandbox — on Linux, `bubblewrap` and `socat` on PATH

Any of these missing yields exit 2 (`inconclusive`), never 0.

## Related

- [lazy-toml.md](lazy-toml.md) — the `[runner]` host permission keys
