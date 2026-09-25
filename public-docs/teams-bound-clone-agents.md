# Claude Code against a Lazy Teams project

This page is for Lazy Teams members who want to use Claude Code on a project.
Once a clone is bound to a project on Lazy Teams (see
[logging a machine in](teams-login.md)), there are two ways to drive that
project with Claude Code. They are not equals.

## The primary way: your builder on the server

Run `lazy builder` in the bound clone, or open the **Builder** page in your
browser. Your builder runs on the Teams install, next to the project, and your
terminal attaches to it. This is the full experience:

- it is a real builder session of the project, with the builder instructions
  lazy assembles for it;
- its conversation is kept with the project, where you and your teammates can
  search and read it later;
- it can do everything a builder can, because it runs where the task
  worktrees, containers and branches live;
- you can leave it and come back from any machine, or from your phone.

If you want Claude Code working on a Teams project, start here.

## The secondary way: your own Claude Code on your machine

You can also point a Claude Code you run yourself — in your own editor, with
your own settings — at the bound clone, by registering lazy's MCP server with
it. Run this on your machine, inside the clone:

```
claude mcp add lazy -- lazy mcp --task-id "" --worktree /path/to/your/clone
```

Then start Claude Code from inside the clone. The MCP server works out which
project it serves from the directory it is started in, not from
`--worktree`, so a Claude Code started elsewhere does not reach this project.

Its `lazy_*` tools then reach the project through your Teams install, on your
login. This is supported and useful when you want your own environment, but
know what you are giving up:

- **It is not a builder session.** Teams has no record of it, and it does not
  get the builder instructions a server-side session gets.
- **Its conversation stays on your machine**, in your own Claude Code history,
  not with the project.
- **It acts as you.** Everything it writes is recorded as yours, exactly as if
  you had typed the command — there is no way for Teams to tell your own
  Claude Code from you, so it does not pretend otherwise.
- **It can never do more than the Teams web UI**, and a few things the web UI
  does are not offered to it (listed below).

### What works

Every read: searching, showing, listing, diffs, review regions, waiting on a
task, memory, messages, raised items, artifacts, and listing, searching and
reading past conversations.

The task lifecycle: create, edit, clone, comment, tag, journal, attach
artifacts, and start, unblock, resume, ask, review, stop, accept, reject,
close, reopen and sync a task.

### What refuses, and says so

Each of these answers with an error naming the Teams install and project, and
what to do instead — usually "use your server-side builder" — rather than
failing obscurely:

- **Not in the browser either:** saving shared memory, the builder's scratch
  files, posting system messages, submitting a pull request, reparenting a
  task, linking an existing branch as a task, and promoting a raised item into
  a task. Use a server-side builder for these.
- **In the browser, but not offered to a clone:** dismissing a system message,
  and redoing a task (several steps, not all of them relayed). Use the Teams
  web UI for these.
- **Asking a past conversation a question.** It runs a model on the server,
  which a clone cannot ask for. Use a server-side builder.
- **Switching a task's agent** on edit. Leave `agent` out, or switch it from a
  server-side builder.
- **Some arguments:** a `runner` or review setting on create or edit, a git
  branch (rather than a task) as a parent, and options that skip a check the
  browser enforces. The same call without them works.
- **Tools that belong to a running task's own agent** — committing, declaring
  a task finished, raising items for review, reporting, and progress updates.
  Your own Claude Code has no task of its own, so these are refused the same
  way they are for any builder.

Nothing is left half done: a call that could not complete on Teams refuses
before it writes anything.
