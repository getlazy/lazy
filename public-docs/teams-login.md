# Logging a machine in to Lazy Teams

`lazy login` connects a machine to a Lazy Teams install and binds the clone you
run it in to one project on that install. Nothing secret is typed, pasted or
displayed: you approve a short code in a browser that is already signed in, and
the credential travels from the install to the machine directly.

## Logging in

Run it inside a clone of the repository:

```
$ cd ~/src/api-server
$ lazy login https://teams.example.com

  Open https://teams.example.com/device and enter:  KTPX-9QFD
  (or, with the code already in it: https://teams.example.com/device?code=KTPX-9QFD)

  ✓ Approved as ada@example.com

  Which project is this clone?
    1) acme/api-server
    2) acme/web
  > 1

  Bound to acme/api-server on teams.example.com.
```

What happens, step by step:

1. Lazy asks the install to start a login and prints a short code.
2. You open the URL in a browser — on this machine or any other — and type the
   code. You see a page naming the machine that is asking, where it asked from,
   and who you would be approving as. The second link has the code already in
   it; it is a convenience, and typing the code yourself is the safer habit,
   because it means you know which request you are approving.
3. You approve. The install creates an API token named after the machine.
4. Lazy collects the token, asks which project this clone is, and saves both.

The code expires after 15 minutes. If nobody approves it in time, run
`lazy login` again for a fresh one. Expiry is the whole window, not just the
approval: a code approved but never collected stops working at the same moment.

A brief network or server hiccup while lazy is waiting does not end the login —
it keeps waiting until the code expires. If the install asks it to check less
often, it waits progressively longer between checks, so several people logging in
from one network at the same time do not crowd each other out.

If a login ends after you approved it — you interrupt it, the install becomes
unreachable, or the project you named is not one you are a member of — the token
it created still exists. Lazy says so, and you can retire it at
**Settings → API tokens**.

**Only you can approve your own logins.** An administrator viewing the site as
you cannot approve one on your behalf, even with writes enabled — approving puts
a long-lived token on a machine, and that token would keep working long after
they stopped viewing as you. The approval page says so instead of offering the
button.

## What a bound clone can do

Once a clone is bound, the ordinary commands work exactly as they do against a
local project — `lazy list`, `lazy show`, `lazy diff`, `lazy create`,
`lazy edit`, `lazy unblock`, `lazy accept`, and the rest — except they run
through your Teams install instead of a daemon on your machine. Everything you
do is authenticated as you and shows up under your name, the same as if you
had used the browser.

A bound clone has no daemon of its own, so a handful of commands that manage
*this machine* refuse instead of trying to operate infrastructure that was
never there: `lazy daemon start` / `stop` / `status`, `lazy init`,
`lazy doctor` (there is nothing local left to diagnose), and `lazy dashboard`
(there is no local dashboard to open — the install's own web pages are it).
Each one says the clone is bound and points at `lazy logout` as the way back
to working locally.

A bound clone can never do more than the browser can. A few task settings have
no control in the browser, so the command-line options that set them are
refused from a bound clone: `--runner` and the `--review` settings on
`lazy create` / `lazy edit`, and `--parent` naming a git branch rather than a
task. You can still set a task's parent task, or clear it, the same way the
browser's edit page does.

For the same reason, the options that let a command skip a check the browser
enforces are refused too: `lazy accept --allow-broken` and
`--allow-review-issues`, `lazy start --force-local`, `lazy unblock --agent`,
and `lazy review --auto-fix` / `--model`. The refusal says what was refused, and the
command works without it.

## Your builder, from a bound clone

`lazy builder` in a bound clone does not start anything on your machine. Your
builder runs on the Teams install, next to the project, and `lazy builder`
opens a terminal on it. Running `lazy builder` again — from this clone, another
machine, or the **Builder** page in your browser — reaches the same session, so
you can start something on your laptop and pick it up from your phone. Its
conversation is kept with the project, like any other builder conversation.

- **ctrl-]** leaves the terminal. The builder keeps running.
- `lazy builder stop` stops it and keeps its conversation; the next
  `lazy builder` resumes it.
- `lazy builder end` ends it for good.

A builder runs until you stop or end it — there is no idle timeout. It runs on
your own Claude account, so connect one in Teams first. Options that choose how
a local builder runs (`--model`, `--effort`, `--resume`, `--no-autonomous`)
are refused from a bound clone: the server decides how its sessions run.

To use a Claude Code you run yourself against the project instead, see
[Claude Code against a Lazy Teams project](teams-bound-clone-agents.md) — it
works, with fewer capabilities than the server-side builder.

`lazy pair` and `lazy shell` likewise go through Teams rather than opening
anything locally. On a Teams install they are refused: a task's
container runs on the account of whoever started the task, so entering it in
your name is not offered.

## Which project this clone is

**Lazy never guesses from the git remote.** Two clones of the same repository can
belong to different projects, so the project is always chosen out loud: from the
list when there is a terminal to ask, or with `--project` when there is not.

```
lazy login teams.example.com --project acme/api-server
```

In a script or anywhere without a terminal, `--project` is required. A login
without it is an error rather than a guess, and it is refused before anything is
created on the install.

**One clone, one project.** Logging in again replaces the binding and says so.
There is no command to switch a clone between projects: if you work on two
projects, you have two clones — which you have anyway, because a clone is a
checkout of one repository.

## Seeing where a clone points

Run `lazy login` with no arguments. It prints the binding and starts nothing:

```
$ lazy login
Bound to acme/api-server on https://teams.example.com
  bound 12/03/2026, 09:41:00
  lazy logout unbinds this clone
```

## Logging out

```
lazy logout
```

This deletes the stored login, which is also how the clone is unbound. If a clone
somehow ends up holding more than one login — a state every other command refuses
to act on — `lazy logout` clears all of them and says how many it removed. It stops
*this machine* using the token; it does not retire the token. To end access
altogether, revoke it at **Settings → API tokens** on the install — that takes
effect on the next request, from anywhere.

## Where the login is kept

In lazy's own [credential store](credentials.md), for this project, split the
same way every credential there is:

- the **token** goes to the OS keychain (macOS Keychain, libsecret on Linux, or a
  mode-0600 file on a host with neither), and
- the **binding** — which install, which project, when — sits beside it in the
  non-secret index.

That split is why `lazy login` with no arguments can tell you where a clone
points without unlocking a keychain to do it.

## The tokens this creates

A login creates an ordinary API token with **CLI and MCP** access, named after
the machine. It appears at **Settings → API tokens** alongside any token you
created by hand, showing when it was last used, and it is revoked there like any
other. Logging the same machine in twice gives the second token a distinguishing
suffix rather than failing.

A CLI token is not a git password: tokens carry separate access for git and for
the command line, and one is refused where the other is expected. If you also
clone over HTTPS from the install, that needs a git-capable token — see
[hosting repositories](self-hosting-lazy-teams.md#hosting-repositories-on-the-install).

## Approving from the browser

The approval page lives at `/device` on your install and is also reachable from
**Settings → API tokens**. Open it and type the code in — it is case-insensitive
and the dash is optional. The prefilled link lazy prints underneath works too,
and is a convenience rather than the mechanism.

If you did not just run `lazy login`, **deny it**. Approving would let whoever
did act as you.

## Human-only, deliberately

There is no MCP tool for logging in or out. Connecting a machine to an install is
a decision a person makes at a keyboard, in a browser they are already signed in
to; an agent must never do it. See
[surface asymmetries](surface-asymmetries.md).
