# The playground

The playground is a small, real project for trying lazy without pointing it at
your own code. It is **Linkshelf**, a tiny link shortener written in TypeScript
on [Bun](https://bun.sh): a few HTTP routes, two HTML pages and a SQLite
database, with unit tests, an end-to-end test and CI. You can read all of it in
five minutes, and the changes it invites look like real work.

It lives at <https://github.com/getlazy/playground> and is already set up for lazy:

- **`lazy.toml`** publishes the dev server's port 3000 as the `web` service, so
  `lazy url <task> web` opens a task's running copy of the app. It protects
  `src/schema.sql`, so an agent that modifies or deletes what is already in the
  schema is held for your decision, and it runs `bun test` after every agent turn.
- **`Dockerfile.lazy`** is the image agents work in: Debian with Bun and a headless Chromium.
- **`tasks.md`** lists eight starter tasks, and **`tasks.json`** is the same list
  in a form lazy can create tasks from.

## Using it on your laptop

For real agent turns, clone it and set it up like any other project:

```sh
git clone https://github.com/getlazy/playground.git
cd playground
lazy init
```

Then create a starter task from `tasks.md` and start it:

```sh
lazy create --code fix-mixed-case-slugs --type fix \
  --goal "Short links with capital letters in their slug do not work" \
  --prompt "$(sed -n '/^## fix-mixed-case-slugs/,/^## /p' tasks.md | sed '1d;$d')"
lazy start fix-mixed-case-slugs
```

To look around first without spending anything, a lazy source checkout can
bring the playground up as a throwaway project. It clones the repository, creates
all eight starter tasks in the backlog and prints a dashboard link. Turns there
run a stand-in agent that makes no model calls:

```sh
lazy playground up --repo https://github.com/getlazy/playground.git
lazy playground down        # removes everything it created
```

Each stand-in turn takes a few seconds, so you can watch a task working before it
stops for review. Set `LAZY_PLAYGROUND_AGENT_PACING_MS` when you run `up` to change
that (in milliseconds; `0` makes turns finish at once).

The clone's `origin` is removed, so nothing in that project can push back to the
repository.

## Using it on Lazy Teams

Add `https://github.com/getlazy/playground.git` as a project, the same way you
would add any repository (see [Setting up Lazy Teams](lazy-teams-setup.md)).
The first task builds the agent image from `Dockerfile.lazy`; after that, open
the `web` service from a task's Services card to see its copy of the app.

## The starter tasks

| Task | Type | What it shows off |
| --- | --- | --- |
| `fix-mixed-case-slugs` | fix | a bug fixed test-first |
| `link-expiry` | feature | a feature touching the schema, a route and tests |
| `route-table` | refactor | a change that must keep every existing test unchanged |
| `api-docs` | document | a docs-only change |
| `spike-accounts` | spike | a written investigation with no code |
| `stats-chart` | feature | a change you review in the running app |
| `paginate-home` | feature | a UI change with edge cases worth checking |
| `link-titles` | feature | a change to the protected schema file |

Each one is small enough to review in a few minutes and says how to tell it is
done. The full goal and prompt for each is in `tasks.md` in the repository.
