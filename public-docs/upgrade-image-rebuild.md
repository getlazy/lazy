# How `lazy upgrade` rebuilds the container image

`lazy upgrade` used to do its work strictly in order: find running containers,
ask the human what to do about the working ones, wait for them to block, stop
everything — and only *then* start a container image rebuild that can take
several minutes. None of that waiting is an input to the build: the image is
built from the Dockerfile, not from the state of your tasks. So the build now
starts first and runs in the background while the rest of the upgrade proceeds.

## The sequence

1. **Preflight** — credential gate, container runtime availability, discovery of
   this project's running containers. Nothing has changed yet, and an abort here
   costs nothing.
2. **Start the rebuild, in the background, to a staging tag.** The build writes
   `<repository>:<tag>-upgrade` (e.g. `lazy-runner:0.21-upgrade`), always
   with `--no-cache` — the Dockerfile text is unchanged when a new version of
   the configured agent's CLI ships, so only busting the cache actually
   re-fetches it.

   This happens **unconditionally**: no version comparison, no Dockerfile-hash
   check, no age check. Upgrading lazy rebuilds the image, always. That is what
   makes the image tag safe to keep coarse (`major.minor`) — the tag is an
   identity, and this is the freshness mechanism.
3. **Foreground flow continues**: the stop/wait/cancel prompt, waiting for
   working agents to block, the builder pre-stop warning, stopping containers.
4. **Collect and promote.** The upgrade waits for the background build (usually
   already finished), then points the canonical tags — `lazy-runner:<major.minor>`
   and, for the base repository, `lazy-runner:latest` — at the staged image and
   drops the staging tag. The agent binary is rebuilt alongside this.
5. **Stop the daemon**, then purge any pre-v0.20 MCP configs left in the repo and
   rotate the shared daemon token they leaked — the one window where no
   container and no daemon holds it.
6. **Restart the daemon**, which reconciles and auto-resumes interrupted tasks.

## Why this is safe

**Nothing running is disturbed by the build.** A container holds its image by ID
from the moment it launches, and any container created while the build is in
flight resolves the *canonical* tag — which still points at the current image.
The staging tag is invisible to every launch path.

**The canonical tag only moves after you commit.** Promotion happens in step 4,
past the point where you chose to proceed. Cancel the upgrade, ctrl-c out of a
prompt, or hit any failure before that, and `lazy-runner:<major.minor>` still points
exactly where it did. The abandoned build's layers stay in the container
runtime's build cache, so the next upgrade starts warm instead of from scratch;
the staging tag itself is removed.

**A failed build fails the upgrade, loudly.** There is no fallback to "keep the
old image and carry on" — that would produce an upgrade that upgraded nothing.
If the build has already failed by the time you answer the prompt, the upgrade
aborts *before* stopping anything, so your builders and agents keep running on
the intact image. If it fails while the upgrade is collecting it, the failure is
reported with the staging tag that was not promoted.

## Builds have no time limit

An image build runs for as long as it needs to. `docker build` has no timeout of
its own, and lazy does not add one: a build killed on a timer wasted every second
it ran and produced nothing, which is strictly worse than one that runs long and
succeeds. A slow build is usually a slow network, not a stuck build.

So that an unbounded build never *looks* stuck, lazy streams the build's step
headers as they happen and prints a "still building…" line with the elapsed time
when a single step goes quiet for a while.

If you genuinely want a bound — an unattended CI machine, say — every command
that triggers a build takes an opt-in `--timeout <seconds>`:

```bash
lazy upgrade --timeout 1800
lazy upgrade --images --timeout 1800
lazy system build lazy-runner --timeout 1800
```

`--timeout 0` spells out the default (no limit), so a script computing the value
never has to special-case zero. If the bound does fire, the error says plainly
that *lazy* killed the build, after how long, and that the limit is yours to
raise or drop — it never surfaces as a bare Docker failure. Layers built before
the kill stay in the build cache, so retrying resumes rather than starting over.

Builds that lazy starts on its own — a task launching when the Dockerfile hash
changed, or the 14-day age backstop below — are always unbounded. There is no
config key for them: nobody is watching those builds, and a stale configured
limit killing them is the exact failure this default exists to prevent.

## Related

- `lazy upgrade --images` is the separate **non-disruptive** path: it rebuilds
  only the image, in the foreground, and stops nothing and restarts nothing.
  Only newly-created containers pick the new image up (`lazy upgrade --images
  --dry-run` prints the exact boundary).
- Image tags are versioned, never bare `:latest` — see the rationale in
  `src/capture/image-tag.ts` and `docs/agent-container.md`.
- An upgrade is not the only thing that refreshes the image — see "When else the
  image gets rebuilt" below.

## When else the image gets rebuilt

An upgrade is the main path, but not the only one. Three triggers rebuild a
runner image, on three different axes:

| Trigger | What it catches |
| --- | --- |
| `lazy upgrade` | Everything. Unconditional, `--no-cache`, described above |
| The image is more than 14 days old | Unpinned contents drifting on a host nobody upgrades |
| The Dockerfile's content hash changed | You edited the Dockerfile |

`lazy system build lazy-runner --no-cache` forces one at any time.

The age backstop exists because a Dockerfile's *text* is not what goes stale.
What it installs is unpinned — apt packages, the agent CLI's installer, the base
image — so identical text yields a materially different image weeks later. Only
wall-clock time sees that, which is why freshness is time-based and the tag
(lazy's `major.minor`) is only an identity.

None of this can leave you running an old *lazy*. The image contains no lazy
code: `lazy-agent` is bind-mounted into the container at launch, so it is
current the moment lazy is.
