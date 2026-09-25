# Linkshelf

A tiny link shortener: paste a long address, get a short one, and see how often
it is clicked. It is the playground project for [lazy](https://getlazy.dev): small
enough to read in five minutes, real enough that the changes you ask an agent
to make here look like real work.

## What it does

- `GET /` — a page with a form and the newest links
- `POST /links` — shorten a URL (`{"url": "...", "slug": "optional-name"}`)
- `GET /<slug>` — redirect to the original address and count the click
- `GET /links/<slug>/stats` — click count and last click (JSON, or a page in a browser)
- `GET /links?page=2` — every link as JSON, newest first, 20 per page
- `DELETE /links/<slug>` — delete a link
- `GET /healthz` — `ok`

## Running it

You need [Bun](https://bun.sh) 1.1 or later. There are no other dependencies:
the database is SQLite, which is built into Bun.

```sh
bun install          # only the type definitions and TypeScript, for `typecheck`
bun run start        # http://localhost:3000, data in ./linkshelf.sqlite
```

`PORT` and `DATABASE` change where it listens and where it keeps its data.

```sh
curl -s localhost:3000/links -H 'content-type: application/json' \
  -d '{"url": "https://bun.sh/docs", "slug": "bun"}'
curl -si localhost:3000/bun | head -3
```

## Tests

```sh
bun test             # unit tests plus one end-to-end test that starts the server
bun run typecheck
```

CI runs both on every push and pull request.

## Layout

| File | What it is |
| --- | --- |
| `src/server.ts` | entry point: reads `PORT`/`DATABASE`, starts the server |
| `src/app.ts` | the routes, as one fetch handler (tests call it directly) |
| `src/store.ts` | the SQLite store |
| `src/schema.sql` | the database schema (protected — see below) |
| `src/slug.ts` | slug generation and validation |
| `src/rate-limit.ts` | limits how fast links can be created |
| `src/html.ts` | the two HTML pages |
| `test/` | unit tests; `test/e2e/` starts the real server |

## Working on it with lazy

This repository is set up for lazy already:

- `lazy.toml` publishes the dev server's port as the `web` service, protects
  `src/schema.sql` (modifying or deleting what is there needs a human's approval), and runs `bun test` after every agent turn.
- `Dockerfile.lazy` is the image agents work in: Debian plus Bun.
- `tasks.md` lists starter tasks worth trying — a bug, a feature, a refactor, a
  docs change, a spike and more. `tasks.json` is the same list in a form
  `lazy playground up` reads to create them for you.

Inside a task, start the app with `bun run dev`; `lazy url <task> web` prints
where that task's copy answers.
