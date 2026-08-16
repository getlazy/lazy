# The documentation site

`https://docs.getlazy.dev` is this repository's `docs/` tree, rendered to static
HTML and published to the `gh-pages` branch of the public `getlazy/lazy` repo on
every release.

It exists because lazy's error messages and command help print documentation
URLs. A pointer that 404s is worse than no pointer at all, so the site, the URL
builder and the tests that check them are one system rather than three.

## Layout

```
/                   a copy of the newest version — bare links keep working
/v0.21/             the snapshot lazy 0.21.x's own messages point at
/v0.20/             …and every earlier minor, untouched forever
/CNAME /.nojekyll   GitHub Pages plumbing
```

One directory per **minor** release. A patch release inside a minor refreshes
its own directory and nothing else; a published directory is never rebuilt from
newer sources. That is what makes a version-pinned URL safe to bake into a
binary: `lazy 0.21.4` prints `/v0.21/troubleshooting`, and that page keeps saying
what 0.21 actually did no matter how far the docs move on.

Pages are written as `<path>/index.html` and linked without a trailing slash
(`/v0.21/troubleshooting`), which relies on GitHub Pages redirecting a directory
request to its trailing-slash form. That is standard Pages behaviour and the
smoke check exercises it on every release, so a hosting change that dropped it
would fail the release rather than quietly 404 for users.

The site root is a copy of the newest version, so an unpinned link (an old blog
post, someone's bookmark) still lands somewhere useful. The root copy is only
refreshed when the version being published is the highest on the branch —
re-running an old tag's release must not roll the front page backwards.

## Where the URLs come from

`src/docs/links.ts` is the single URL builder. Nothing in the codebase builds a
documentation URL by hand.

- `DOCS_PAGES` is the registry: one entry per page lazy links to, with the
  `docs/` source file it renders from and the site path (optionally with a
  `#fragment`).
- `DEFAULT_DOCS_URL` is `https://docs.getlazy.dev/v<major.minor>`, where the
  segment comes from `majorMinor(VERSION)` — the same helper the runner image
  tag uses, so one place decides what "the minor this build belongs to" means.
- A `[docs] url` in `lazy.toml` is used **verbatim**: lazy appends the page path
  and never adds a version segment. Mirrors own their own layout. See
  [`[docs]` in lazy.toml](lazy-toml.md#docs).
- `""` or `false` disables pointers entirely. Every message that carries one
  reads correctly without it.

## Generator

`src/docs/site.ts` (`buildDocsSite`) renders the tree; `scripts/build-docs-site.ts`
is a thin CLI over it. Plain Bun, `marked` and `github-slugger` — no SSG
framework.

```bash
bun run scripts/build-docs-site.ts --out /tmp/site --version v0.21 --clean
```

Properties that are load-bearing, each covered by `test/unit/docs-site.test.ts`:

- **Heading ids are GitHub's slugs.** `github-slugger` gives the exact algorithm,
  including the per-document duplicate counter (`notes`, `notes-1`, …), so a
  fragment written by reading a heading in the repo resolves on the site.
- **Every emitted link is relative.** The same HTML is served from `/v0.21/` and
  from `/`, so a root-absolute path could only be correct in one of them.
- **Links are rewritten from the *rendered* page directory.** `docs/a/b.md`
  becomes `a/b/index.html`, so a sibling link resolved against the source
  directory would be one level too high once served.
- **Output is deterministic.** No timestamps; a rebuild that changed nothing
  produces an empty git diff, so `gh-pages` does not churn.
- **Links that leave the tree are reported, not fatal.** A stale cross-reference
  is a content bug, not a reason to block a release. `--strict` makes them fatal
  for anyone who wants that gate.

The build also writes `manifest.json`: every page path, its source, its output
file and its anchor slugs. That is the machine-readable contract the tests and
the smoke check consume.

## What gets published

The whole `docs/` tree except the directories in `DEFAULT_EXCLUDED_DIRS`
(`src/docs/site.ts`). This is a **deny** list, unlike `.releaseinclude`, which is
an allowlist for the source tarball. If a directory under `docs/` should not be
on a public website, it has to be named there — nothing else keeps it off.

## Publishing

`scripts/publish-docs-site.sh` builds the site, clones the publish branch, writes
`/v<major.minor>/`, refreshes the root copy when appropriate, writes `CNAME` and
`.nojekyll`, and pushes. It refuses to run if the version directory disagrees
with the `DOCS_VERSION_SEGMENT` the build's own binaries will print — that drift
would 404 every pointer in the release and stay invisible until a user hit one.

`.github/workflows/release.yml` runs it after the source publish succeeds, using
the same deploy key, then runs `scripts/smoke-docs-site.ts` against the live site:
every `DOCS_PAGES` URL must answer 200, and every `#fragment` must exist as an
`id` in the HTML served. Any failure fails the release job. The only tolerance is
time — a first deploy of a custom domain needs minutes for DNS and the
certificate, so the first request is retried up to `--timeout` before anything is
called a failure. See [the release pipeline](release-pipeline.md).

## Adding a page lazy links to

1. Write the page under `docs/`.
2. Add a `DOCS_PAGES` entry in `src/docs/links.ts` — `source` is the file,
   `path` is the file without `.md`, plus `#fragment` if you are linking to a
   heading.
3. If the page is not already covered, add it to `.releaseinclude` so it exists
   in the public repo (where the tests also run).
4. Run `bun test test/unit/docs-links.test.ts`. It builds the real site and
   fails if the page is not emitted or the fragment is not an anchor the
   renderer produced.
5. Use it via `docsUrl(...)` / `docsSuffix(...)` / `docsFooter(...)` — never by
   writing a URL.

Anchors are checked against the **renderer**, not against a grep of the markdown,
because the fragment is not in the markdown: it is derived from the heading by
slugging. `` ## `lazy.toml` won't parse `` becomes `lazytoml-wont-parse` only if
every step of that derivation is right, and a grep would happily confirm a
fragment the site never emits.

## Operating the site

The site is served by GitHub Pages from the `gh-pages` branch of `getlazy/lazy`,
with `docs.getlazy.dev` as the custom domain. That requires, once:

- Pages enabled on `getlazy/lazy` with source **branch `gh-pages`, folder `/`**.
- Custom domain set to `docs.getlazy.dev`, with "Enforce HTTPS" on once the
  certificate is issued.
- DNS for `docs.getlazy.dev` pointing at GitHub Pages (a `CNAME` to
  `getlazy.github.io`).

Until all three are done the smoke step fails the release job, by design: a
release that ships URLs nobody serves is not a release that succeeded.
