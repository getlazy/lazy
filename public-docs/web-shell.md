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

The terminals live in this browser document, but the shell does not: on an
image with `tmux`, a shell is the container's `shell` tmux session, which keeps
running when you reload or leave the page. Opening a shell again — here, or
with `lazy shell <task>`, which enters the same session — takes you back to it.

Terminals have no idle or lifetime limit. In Teams, your own environment and its
sessions stay when you close the page or disconnect, however long they are idle.
The environment ends when you exit its last shell or explicitly end its sessions,
when the task ends, or when you leave the team. A project restart reuses it when
it can be recovered. The agent keeps working while your terminals are open.

## Opening a shell

On the **Shell tab**, **+ New** opens a full-height terminal in the task's
container, attached to its `shell` tmux session (created the first time).
Bash is used when the container has it, otherwise `sh`; an image without
`tmux` gets a plain shell that ends with its terminal. You land in
the task's working directory (its worktree), with `TERM=xterm-256color`, so
full-screen programs like `vi`, `less` and `htop` render correctly.

The tab also lists every session this page already has open — label, where it
came from (a verification step, Services, opened here, Pair, Chat), and whether
it is connected — with **go to** and close. A session renders in exactly one
place; the list is an index, not a second terminal.

**Fill window** makes that same terminal cover the whole browser window, width
and height; **Exit full window** (or **Esc**, when the terminal itself is not focused — inside it Esc goes to your program) puts it back. The element never moves
in the page, so focus and scrollback stay put. Every browser terminal in Lazy
— the task Shell, Watch, a verification step's shell, and the terminals in Lazy
Teams — has the same controls: **Fill window**, **Paste** (not on the read-only
Watch), **Page Up** / **Page Down** to scroll back, **Ctrl/Cmd+C** to copy a
selection (with none it stays the interrupt), **Ctrl/Cmd+V** or **Shift+Insert**
to paste, and a draggable bottom edge to change the height.

## Pair and Chat

**Pair** takes over the agent's session in the same terminal, with the same
lock as `lazy pair`: unblock and accept refuse until you stop. A dropped
connection reconnects to the same session by itself (see
[When the connection drops](#when-the-connection-drops)); if it cannot within
5 minutes, pairing ends 30 seconds later, so the task cannot stay locked
forever. Only one Pair session per task.

In **Lazy Teams**, **Pair** opens your own conversation in your terminal
container. Its `lazy_*` tools work on the paired task and its direct subtasks;
writes name you, and turns you launch use your own credential. Several members
can pair at once, alongside the task's running agent. Pairing does not lock the
task. Closing the connection revokes that conversation's tool access; reopening
Pair gives it a fresh connection.

Teams Pair and Chat run the task's own agent — Claude Code, Codex, Cursor or Pi —
on any of their profiles, including named endpoints and tier chains. Requests
use the task's profile and your own connections, resolved at account, team or
project level, just like a turn you launch. If a required connection is missing,
click the button to see which endpoint to connect under **Connections**. Pair
resumes the agent's conversation on Claude Code, Codex and Pi; a Cursor session
starts a new conversation.

**Chat** opens a read-only conversation with read-only lazy tools. The daemon
refuses writes even if the agent tries calling a write tool directly. Chat runs
on Claude Code, Cursor and Pi tasks. It is not available on Codex tasks:
Codex's read-only mode needs a sandbox that cannot run inside a task's
container. Clicking Chat there says so; use **Ask** for a read-only question.

In the **solo dashboard**, Pair takes over the task's agent session, with the
same lock as `lazy pair`: unblock and accept refuse until it ends. A dropped
connection releases the lock within 30 seconds. Solo Chat opens only while the
task is paused. Neither mode changes the task's agent, model, or effort.

The **Chat tab** is separate from terminal Chat: it uses read-only Ask turns
and works on all four harnesses, including Codex. See [the Chat tab](reference/teams/task.md#chat).

![Pair and the interactive Chat explanation on a Codex task in Teams](images/teams/teams-task-shell-codex.png)

Both terminal modes ride the same WebSocket as a plain shell.

## Copy and paste

The panel takes the shortcuts a terminal user expects:

- **Paste** — `Ctrl+V` (`Cmd+V` on macOS) or `Shift+Insert`. Right-click paste
  from the browser's own menu works too.
- **Copy** — `Ctrl+C` (`Cmd+C`) *while text is selected*. With nothing selected,
  `Ctrl+C` stays the interrupt and is sent to the running process, as it must be.
- **Copy from a program** — a program that copies by itself (Claude Code does,
  when you select text in it and it reports "characters copied") puts the text
  on your clipboard. When a program takes the mouse, `Shift`-drag (`Option`-drag
  on macOS) selects text in the terminal instead.

A program's full screen — Claude Code's fullscreen view, `vim`, `less` — has
no terminal scrollback, so there **Page Up** and **Page Down** go to the
program, which scrolls itself.

The **Paste** button reads the system clipboard through the browser, so it may
raise a clipboard permission prompt, and a browser that refuses clipboard
access (or a page not served over `localhost`/HTTPS) pastes nothing from it;
the keyboard shortcuts and right-click paste are unaffected. A program's copy
needs the same: an HTTPS or `localhost` page, focused when the copy happens.

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
`ts` block has no Run). If no shell can be opened, clicking Run explains why
and what to do next. A stopped container is not one of those reasons —
Run starts it, and says so in the terminal it opens.

If the connection drops, **Reconnect** attaches to the container's `shell`
session again, with whatever was running in it (a reconnected session does not
re-run its block). Typing `exit` ends the shell; closing the terminal or
leaving the page only detaches from it. On an image without `tmux`, a dropped
connection ends the shell and Reconnect opens a fresh one.

## When the connection drops

A terminal whose connection drops — Wi-Fi changing, a laptop waking from sleep,
a proxy closing a connection — reconnects by itself for **5 minutes**: quick tries first,
then every 30 seconds. The status line says **Connection lost — reconnecting…**
while it does, and typing is paused (nothing you type in that gap is sent).
When it is back, the output you missed is drawn once and the session carries on
where it was. Watch reconnects the same way and redraws its stream.

It does not reconnect when the session really ended: the program exited, you
closed the terminal or left the page, or the server refused it. Then the status
line says what happened and **Open a new session** starts a fresh one. A
terminal that could not reconnect within 5 minutes releases its browser connection.
A shell backed by tmux keeps running; open Shell again to rejoin it. On an
image without tmux, the plain shell ends with its connection.

## Starting the container

The shell needs a **running container**, and opening one is how you ask for it:
if the container is down, the panel starts it and shows the progress on its own
status line — pulling or building the image included — then connects. Watch,
Pair and Chat do the same. Two panels opened together share one start; they
never race two containers for the same task.

If the start fails — Docker not running, an image that will not build — the
panel shows the failure text and a **Start container** button, so you can
retry once you have fixed the cause. That is the only place a Start button appears next to a terminal.

## When a shell cannot be opened

A start cannot fix a task that hasn't started, so it has no session yet; the
page says so instead of failing silently.

## What a shell can reach

The terminal is a `docker exec` into the task's **own** container — nothing
more. It is not a shell on the machine running the daemon, and it cannot be
pointed at another task's container: which container to enter is decided
entirely by the daemon from the task's session, and the browser has no say in
it. The only things the browser sends are your keystrokes and the terminal size.

When you close the terminal, the shell inside the container keeps running in
its tmux session until you `exit` it or the container is recreated. Without
`tmux` in the image, it is torn down with the terminal.

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

Tools that speak SSH — VS Code Remote-SSH, JetBrains Gateway, `scp`, `ssh -L` —
reach the same environment through `lazy shell <task> --ssh-config`; see
[How to SSH into a task](how-to/ssh-into-a-task.md).

See [Serve ports](serve-ports.md) for how the daemon binds and
[Surface asymmetries](surface-asymmetries.md) for why there is no agent-facing
(MCP) version of this — a shell is a human tool.
