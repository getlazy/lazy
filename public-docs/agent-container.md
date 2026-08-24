# The lazy agent container image

Agents working on the lazy codebase run inside the image built from
`Dockerfile.lazy` (wired up by `[docker] dockerfile = "Dockerfile.lazy"` in
`lazy.toml`). This document records what that image carries beyond a plain
Debian box, and why.

It is *not* the image other projects get. Projects with no `[docker] dockerfile`
build from the embedded default (`src/docker/base.Dockerfile`, exported by
`lazy system export-dockerfile`), which stays deliberately minimal — everything
below is here because lazy's own test suite needs it.

## What's preinstalled

| Package | Why |
| --- | --- |
| `git`, `curl`, `jq`, `wget`, `unzip`, `less`, `openssh-client`, `gnupg`, `sudo` | Base dev utilities |
| `bun` (system-wide, plus `bunx`) | Lazy is a bun/TypeScript project — tests, typecheck, and lazy itself |
| Playwright + Chromium (`/ms-playwright`) | Screenshots for visual verification of UI work |
| Claude Code (`/home/user/.local/bin/claude`) | The agent binary |
| **`bubblewrap`, `socat`** | Claude Code's Linux OS-sandbox backend |
| **PostgreSQL 15 (server + client)** | `PostgresStorage` integration coverage |

The bolded rows are the e2e dependencies. Before they shipped in the image,
agents verifying their work re-installed them by hand, once per container, over
and over — minutes each time, invisible to whoever was waiting.

### There is no `node`, and there never was

Deliberate: lazy is a bun project, and bun runs its TypeScript directly. But
`bun install` still writes `node_modules/.bin/*` shims that start with
`#!/usr/bin/env node`, and bun does **not** put a `node` shim on PATH for
`bun run` (verified on bun 1.4.0). So any `package.json` script that invokes a
dependency's CLI by its bare name — `tsc --noEmit`, `eslint .`, `prettier -c` —
dies at the shebang with **exit 127**, before the tool reads a single file.

Invoke the package's entry module through bun instead:

```json
"typecheck": "bun node_modules/typescript/lib/tsc.js --noEmit"
```

This is not hypothetical. `"typecheck": "tsc --noEmit"` is how
`[checks] post_turn = "bun run build && bun run typecheck"` sat dead: both
halves 127'd every turn, so nothing was typechecked and `scripts/build.ts` never
ran, while the gate's output read as noise rather than as "the gate is not
running". It never reproduced on a dev Mac, where `mise.toml` provisions node.
`test/unit/package-scripts-node-free.test.ts` now fails on that shape.

Adding node to the image would also work, but costs a rebuild for every agent
and diverges from what the engineer's Mac runs.

### bubblewrap and socat

`permission_mode = "sandbox"` (the default posture for host execution) runs the
agent under Claude Code's OS sandbox, which on Linux is bubblewrap plus socat.
`src/runner/host-process-runner.ts` checks for both and fails hard with an
install message rather than silently running unsandboxed.

Suites affected: `test/e2e/agent-binary-seam.test.ts` (its sandbox-posture block
gates itself with `sandboxSuiteSkipped()` — without the binaries it **skips**,
which is not a pass), `test/e2e/builder.test.ts`,
`test/e2e/host-sandbox-posture.test.ts`.

### PostgreSQL

`test/e2e/postgres-storage.test.ts` and `test/e2e/storage-contract.test.ts` are
the only real coverage of the Postgres storage backend, and both skip their
whole suite when `LAZY_POSTGRES_URL` is unset. Debian bookworm ships
PostgreSQL 15, which satisfies the backend's requirements.

**It is installed but not running.** The cluster is initialized at image build
time and left stopped. Nothing in the container's runtime path starts it: there
is no init system, no `ENTRYPOINT`, and Debian's `policy-rc.d` already blocks the
package's own start during the build. A task that never touches storage pays
nothing beyond image size.

To use it:

```bash
LAZY_POSTGRES_URL=$(lazy-pg-start) bun test test/e2e/postgres-storage.test.ts
```

`lazy-pg-start` is idempotent: it starts the cluster if it isn't already
accepting connections and prints
`postgres://user@127.0.0.1:5432/lazy_test` either way.

Authentication is `trust` on the unix socket and loopback. The cluster is
disposable, container-private and unpublished — there is no secret to protect,
and a password would only be one more thing for every agent to rediscover. The
`pg_hba.conf` rewrite is guarded at build time, so if Debian's defaults ever
stop matching, the build fails loudly instead of shipping an image whose
advertised URL cannot connect.

## Cost

Measured on arm64 by installing the same package set into a running container:

- **Image size: ≈ 170 MB larger.** ~180 MB of packages, of which **100 MB is
  `libllvm14`** — a hard `Depends` of `postgresql-15` for JIT that Debian gives
  no way to drop — plus a ~40 MB initialized cluster, minus the ~19 MB of apt
  lists the layer deletes.
- **Build time: under a minute added.** Two apt operations and one
  `initdb`/start/stop cycle. Small next to the existing Playwright and Chromium
  download.

## Rebuilding

Editing `Dockerfile.lazy` changes its content hash, which changes the resolved
image name (`lazy-custom-<hash>`), so lazy rebuilds automatically on the next
task launch — no manual step. If an agent finds `bwrap` or `psql` missing, it is
running on a pre-change image; that is a rebuild, not a reason to `apt-get`.

That covers what this Dockerfile *states*. It does nothing about what it
*pulls* — nothing here is version-pinned, so the same text produces a
materially different image a month later. That is true of any runner image
lazy builds, so lazy handles it generically, with two time-based triggers on
top of the hash:

- **`lazy upgrade` always rebuilds**, from scratch, with no version or hash
  comparison. That is the main path.
- **A backstop at 14 days.** If the image on disk is older than that, the next
  task launch rebuilds it once (with `--no-cache`, since a cached build would
  re-fetch nothing) and then goes quiet again.

Neither can leave you on an old *lazy*: no runner image contains lazy, here or
anywhere else — `lazy-agent` is bind-mounted in at launch.

The image *tag* is only an identity, not a freshness signal: it is lazy's
major.minor version (`lazy-custom-<hash>:0.21`), so it deliberately does not move
on every commit or patch release. `lazy doctor` lists the older images left
behind.
