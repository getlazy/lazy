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

When an agent's configuration says when to use it (its `description`), a
**When to use each agent** list opens beneath the field — for example "use this
one whenever a security aspect comes up". It is guidance for your choice; the
form never switches agent on its own. Project settings show the same list
beside **Default agent**.

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

Team **admins** set the default under **Settings → General** on a project page. The control
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

Every turn runs on the account of the person who starts it, **for the agent it
runs on** — never a teammate's, and never one key the project shares. So each
member connects their own credential for each agent they use.

### Your Claude credential

Open **Agent credentials** from your account menu (top right) and connect your
own Anthropic account — subscription token or API key. Lazy Teams stores it
encrypted, never shows it again, and uses it for every Claude agent whose
traffic goes to Anthropic, on every project. Use **Test credential** to check
it before running work.

### Account, team and project credentials

Each credential — Claude or any other agent — can be set at three levels, and
the most specific one you set wins:

1. **Account** (**Agent credentials** in your account menu) — used on every
   project of yours.
2. **Team** (the team page → **Your credentials**) — overrides your account
   credential on that team's projects.
3. **Project** (the project's **Settings → Your credentials**) — overrides both
   on that one project. You never need one; it is there if a project really
   needs a different key.

Each page says which level currently applies ("Using your team credential").
**Copy to team** on a project credential and **Copy to account** on a team
credential copy it up a level on the server — the value is never shown, and you
are asked before an existing credential at that level is replaced. Only your
own credentials are ever read or copied.

A credential set at the team or account level carries the endpoint shown when
you set it; a project whose agent sends its traffic somewhere else does not use
it, and its Your credentials tab says so.

### Credentials for a project's other agents

On the project's **Settings → Your credentials** tab: Pi, Codex (on an OpenAI API key, or on a ChatGPT subscription), Cursor, and
any agent the project defines with an endpoint of its own — for example a
second Claude agent pointed at a gateway. The tab lists exactly the agents the
project offers, and for each one:

- what it needs — an API key, or for a ChatGPT subscription the contents of
  `~/.codex/auth.json` after `codex login` (use a login made for this: lazy
  keeps it renewed, which signs out any other copy);
- **where your credential is sent** — the agent's own endpoint, when it has one;
- whether it runs on your Claude credential instead, or needs no credential at
  all (a model server that takes none).

A credential you connect for an agent is sent only to that agent's endpoint. If
the project later points the agent somewhere else, your credential stops being
used until you connect it again — it never follows the agent to a new place on
its own.

Starting a task on an agent you have not connected is refused before anything
runs, naming the agent, with a link to the Your credentials tab. Leaving a team
removes the credentials you set for that team and its projects; your account
credentials stay yours.


### Agents the project adds

The team owner adds and changes a project's agents on its **Settings → Configuration**
page (`[agents.<name>]` blocks in the project's lazy.toml). An agent added
there appears on every member's Your credentials tab and in the task form's **Agent**
list once the project has picked it up.

### Automations

Each project can designate one member's credentials for **automations** (turns
nobody started). Only an admin can set that, and only from their own connected
account; automations on an agent then run on that member's own credential for
it.

## CLI vs Teams

The lazy CLI chooses agents with `agent_id` in lazy.toml and `--agent` on
`lazy create` / `lazy start`. A **project default agent** set in Lazy Teams
(or via the daemon's project settings) applies when you omit `--agent` on
`lazy create` and on MCP task creation too — the same overlay, not a separate
Teams-only default.
