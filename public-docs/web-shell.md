# Web shell

This page is for anyone reviewing tasks in the local daemon dashboard. The
dashboard can open an interactive terminal **inside a task's container**,
right from the browser. It is the same thing as running
`lazy shell <task>` at the command line — a shell in the exact
sandbox the task's agent worked in — so you can try the work by hand while
you review.

The **Shell tab** (`/tasks/:task/shell`) is the home for terminals you open
directly, plus Pair and Chat. Verification steps mount a terminal **under the
step**, not in this tab; the tab lists those sessions and links to them. The
tab is hidden when the task's runner has no container.

Sessions live in this browser document. Reload or leave the page and they
close — there is no server-side registry. `lazy shell <task>` survives.

## Opening a shell

On the **Shell tab**, **+ New** opens a full-height terminal in the task's
container. Bash is used when the container has it, otherwise `sh`. You land in
the task's working directory (its worktree), with `TERM=xterm-256color`, so
full-screen programs like `vi`, `less` and `htop` render correctly.

The tab also lists every session this page already has open — label, where it
came from (a verification step, Services, opened here, Pair, Chat), and whether
it is connected — with **go to** and close. A session renders in exactly one
place; the list is an index, not a second terminal.

**Maximise** enlarges that same terminal as an overlay. The element never moves
in the page, so focus and scrollback stay put.

## Pair and Chat

**Pair** takes over the agent's session in the same terminal, with the same
lock as `lazy pair`: unblock and accept refuse until you stop, and a dropped
connection ends pairing within 30 seconds so the task cannot stay locked
forever. Only one Pair session per task.

**Chat** opens a read-only conversation with the task's agent (`lazy chat`).
It does not lock the task and does not change the task's agent, model, or
effort. A working task's agent owns the session — Chat refuses then, with the
same message as the CLI.

Both ride the same WebSocket as a plain shell, not a second exec path.

## Copy and paste

The panel takes the shortcuts a terminal user expects:

- **Paste** — `Ctrl+V` (`Cmd+V` on macOS) or `Shift+Insert`. Right-click paste
  from the browser's own menu works too.
- **Copy** — `Ctrl+C` (`Cmd+C`) *while text is selected*. With nothing selected,
  `Ctrl+C` stays the interrupt and is sent to the running process, as it must be.

Keyboard paste reads the system clipboard through the browser, so the first
paste may raise a clipboard permission prompt — and a browser that refuses
clipboard reads (or a page not served over `localhost`/HTTPS) pastes nothing
from the keyboard. Right-click paste is unaffected either way.

## Running a verification step

The [Verify tab](web-review.md#the-verify-tab) gives every shell command block a
**Run in shell** button next to **Copy**. One click mounts a terminal
**directly under that step** — labelled `Verify 1`, `Verify 2`, … in the order
the runnable blocks appear — and runs the block there. A second click on a live
step offers **Open** (jump to it) and **Re-run** (a fresh session) rather than
stacking another terminal under the same step. Nothing is ever typed into a
shell you were already using.

What goes in is exactly what **Copy** would have put on your clipboard: the `$ `
prompt markers of a console block are stripped, multi-line blocks go in whole
and run in order. Commands always run **inside the task's container**, the same
place its agent worked.

The commands are the ones the agent wrote in its report, so you read them before
they run — the block is rendered right below the button, and the terminal prints
the lines again as it feeds them in. Nothing runs until you click: opening the
page never executes anything. When the block finishes, the shell prints
`[lazy] exit status: N`, so a step that failed quietly still says so — and the
terminal stays open and interactive for whatever you want to try next.

Run is offered only for blocks that could be shell input (a `json`, `toml` or
`ts` block has no Run), and is disabled with the same reason as the Shell tab
when no shell can be opened. A stopped container is not one of those reasons —
Run starts it, and says so in the terminal it opens.

If the connection drops, **Reconnect** opens a fresh shell (the previous one is
gone; a terminal session does not survive the socket closing, and a reconnected
session does not re-run its block). Closing the terminal, leaving the page, or
typing `exit` ends the session.

## Starting the container

The shell needs a **running container**, and opening one is how you ask for it:
if the container is down, the panel starts it and shows the progress on its own
status line — pulling or building the image included — then connects. Watch,
Pair and Chat do the same. Two panels opened together share one start; they
never race two containers for the same task.

If the start fails — Docker not running, an image that will not build — the
panel shows the failure text and its **Reconnect** button becomes **Start
container**, so you can retry once you have fixed the cause. That is the only
place a Start button appears next to a terminal.

## When a shell cannot be opened

Two things a start cannot fix, which the page says instead of failing silently:

- **The task hasn't started**, so it has no session yet.
- **The task runs without a container** — for example on the host-process
  runner, where there is nothing to enter.

## What a shell can reach

The terminal is a `docker exec` into the task's **own** container — nothing
more. It is not a shell on the machine running the daemon, and it cannot be
pointed at another task's container: which container to enter is decided
entirely by the daemon from the task's session, and the browser has no say in
it. The only things the browser sends are your keystrokes and the terminal size.

When you close the terminal, the shell inside the container is torn down with
it. Reload the page and every session is gone — the Shell tab says so in one
line. `lazy shell <task>` is the one that survives.

## Access and security

The shell is behind the same gate as every other dashboard page: a **signed-in
browser session**, obtained by running `lazy dashboard` in the project (it
opens your browser with a one-time login link that becomes a session cookie).
No session, no shell — the terminal connection is refused before the daemon
even looks at which task you asked for. Anyone signed in can already unblock,
accept and edit tasks; a shell into the agent's own sandbox is in the same
class.

On a managed (Lazy Teams) daemon the dashboard does not exist, and the
shell answers 404 along with the rest of it.

See [Serve ports](serve-ports.md) for how the daemon binds and
[Surface asymmetries](surface-asymmetries.md) for why there is no agent-facing
(MCP) version of this — a shell is a human tool.
