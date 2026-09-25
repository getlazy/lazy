# Starter tasks

Eight small tasks to try lazy on. Each is a change you could review in a few
minutes, with a clear way to tell whether it is done. `tasks.json` has the same
list; `lazy playground up` creates these tasks for you when it uses this repository,
or you can create any one by hand:

```sh
lazy create --code fix-mixed-case-slugs --type fix \
  --goal "Short links with capital letters in their slug do not work" \
  --prompt "…the prompt below…"
```

| Task | Type | What it shows off |
| --- | --- | --- |
| `fix-mixed-case-slugs` | fix | a bug fixed test-first |
| `link-expiry` | feature | a feature with schema, route and tests |
| `route-table` | refactor | a change that must keep every test unchanged |
| `api-docs` | document | a docs-only change |
| `spike-accounts` | spike | a written investigation, no code |
| `stats-chart` | feature | a change you review in the running app |
| `paginate-home` | feature | a UI change with edge cases worth checking |
| `link-titles` | feature | a change to a protected file |

## fix-mixed-case-slugs — Short links with capital letters in their slug do not work

Creating a link with a custom slug like `Docs` succeeds and the response says
the short link is `/docs`, but visiting `/Docs` returns 404 (and so does
`/links/Docs/stats`). Slugs are stored lowercase, so lookups should be
case-insensitive too.

First add a test to `test/app.test.ts` that creates `{"slug": "Docs"}` and
asserts that both `/Docs` and `/docs` redirect; confirm it fails. Then fix the
lookups so it passes. Done when `bun test` is green and the new test would have
caught the bug.

## link-expiry — Links can expire after a number of days

Let `POST /links` accept an optional `expiresInDays` (a positive integer).
Visiting an expired link returns 410 Gone with a short JSON error instead of
redirecting, and its stats show when it expired. Links without the field never
expire.

The schema lives in `src/schema.sql`; add to it rather than changing existing
columns, and make sure an existing database still opens. Cover: a link that has
not expired yet, one that has (pass a fixed `now` rather than sleeping), and a
link with no expiry.

## route-table — Replace the chain of ifs in the router with a route table

`src/app.ts` decides which handler runs with a long sequence of
`if (method === ... && path ...)` checks and regexes. Replace it with a small
route table: a list of `{ method, pattern, handler }` entries where patterns
like `/links/:slug/stats` bind named parameters. Keep every route's behaviour
exactly the same — no test should need to change. No new dependencies.

## api-docs — Document the HTTP API with runnable examples

Write `docs/api.md` describing every route: method and path, request body, the
responses it can give (with status codes) and a curl example for each that
works against `bun run start`. Link it from the README's "What it does" section.
Check each example by running it.

## spike-accounts — How would we add user accounts?

Today every link is public and anyone can delete any link. Investigate what it
would take to give links owners: sign-in options that fit a Bun + SQLite app
with no dependencies, how ownership would change the schema, what the delete and
stats routes would check, and how existing links would be migrated.

Deliver `docs/spikes/accounts.md` with a recommendation and the two
alternatives you rejected, each with a reason. No code changes.

## stats-chart — Show a clicks-per-day chart on a link's stats page

The stats page (`/links/<slug>/stats` in a browser) only shows a total. Add a
small bar chart of clicks per day for the last 14 days, drawn as inline SVG — no
chart library. Days with no clicks show as empty bars.

Start the app with `bun run dev` so the reviewer can open it: the project's
`lazy.toml` publishes port 3000 as the `web` service (`lazy url <task> web`).
Add a store-level test for the per-day counts.

## paginate-home — Page through links on the home page

The home page shows only the newest 20 links. Add "Newer" and "Older" links
under the table, driven by a `?page=N` query parameter, using the same paging
the `GET /links` JSON route already has. Hide "Older" on the last page and
"Newer" on the first. Cover the page boundaries with tests, including a store
with exactly 20 and exactly 40 links.

## link-titles — Give links an optional title shown on the home page

Let `POST /links` and the home page form take an optional `title` (up to 100
characters). Show it on the home page instead of the raw URL when present, with
the URL beneath it in smaller text.

Add `title TEXT` as the last column of the `links` table definition in
`src/schema.sql` (after `created_at`), not as a separate `ALTER TABLE`. The
project protects that file, so editing its existing lines is held for a human
decision: explain the schema change in your summary, including what happens to
a database created before it.
