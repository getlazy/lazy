# Agents in Lazy Teams

This page is for Lazy Teams members and admins choosing which coding agent runs
a task and connecting the credentials those agents use. Lazy ships **Claude
Code**, **Codex**, **Cursor** and **Pi**, and a project can define more of its
own. Each agent bills turns to a different account, so the product keeps agent
choice and credentials explicit.

## Choosing an agent for a task

When you create a task, the **Agent** field lets you pick which agent runs it.
The form preselects your project's default (see below). Pick another agent to
override for that task only.

### The agents your project offers

The list is your project's own. A project can name its own agents in its
lazy.toml — a named combination of which agent software drives the work and
which model it asks for — and those are offered first, above the ones lazy
ships with. Each one says what it runs beside its name, so two agents built on
the same software but pointed at different models are told apart without
opening a config file.

You choose an agent by name and nothing else: where its traffic goes and which
key pays for it are set where the project is configured, and are never part of
filling in a task form.

If a project's agents cannot be read just now, the form falls back to the ones
lazy ships with rather than guessing.

The agent is fixed for a task once work has started. Change it only on tasks
still in the backlog, before the first turn.

## Project default agent

Team **admins** set the default under **Settings** on a project page. The control
shows what the repository's lazy.toml specifies and what this Lazy Teams install
overrides, so you always see both values and which one wins.

Clearing the override returns new tasks to the repository default. Changing the
default affects tasks that have not started yet; a task already running keeps the
agent it began with.

## Model and reasoning effort

Beside the agent, the new-task form takes a **Model** and an **Effort** — how
hard the agent thinks before it acts. Leave either blank and the project's own
default decides.

What you pick is kept on the task, not just on the run you are about to start.
A task added to the backlog with **Very high** effort still runs at very high
effort when somebody starts it days later from its own page.

## Agent credentials

Open **Agent credentials** from your account menu (top right).

### Claude Code

Connect your own Anthropic account here — subscription token or API key. Lazy
Teams stores it encrypted, never shows it again, and uses it for Claude Code
turns **you** start. Use **Test credential** to check it before running work.

Each project can also designate one member's credential for **automations**
(turns nobody started). Only an admin can set that, and only from their own
connected account.

### Cursor

Cursor turns use an API key configured **for each project** by your team's
operators — not a personal credential you connect in this menu. Every member on
a Cursor task shares that project's key until per-user Cursor credentials exist.

### Pi

Pi turns have no Pi-specific credential at all: they run on the same Anthropic
(or Ollama) credentials as Claude Code turns, so the per-user credential you
connect for Claude Code covers Pi tasks too.

## CLI vs Teams

The lazy CLI chooses agents with `agent_id` in lazy.toml and `--agent` on
`lazy create` / `lazy start`. A **project default agent** set in Lazy Teams
(or via the daemon's project settings) applies when you omit `--agent` on
`lazy create` and on MCP task creation too — the same overlay, not a separate
Teams-only default.
