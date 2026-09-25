# Leaked pre-v0.20 MCP configs, and the token rotation that closes them

If your project was created before lazy v0.20, `lazy upgrade` may tell you:

```
Removed 820 leaked pre-v0.20 MCP config(s) from /path/to/repo/.lazy/tmp
  (each contained the shared daemon token and was readable by every agent).
  Rotated the shared daemon token — the leaked one no longer works.
```

This page explains what those files were, why they mattered, and why the
rotation is safe.

## What leaked

Before v0.20, every agent launch wrote its MCP config to
`<project>/.lazy/tmp/daemon-mcp-<name>.json` — inside the repository, at the
default `0644`, containing the **shared daemon bearer token**.

Three facts turned that into a live problem rather than clutter:

- the shared token is reused across daemon restarts and never rotates on its own;
- every task container bind-mounts the whole repository read-only, so every agent
  that has ever run could read every one of those files;
- the daemon's `/rpc/*` routes accept `Bearer <shared token>`.

So any agent could lift the token out of the repo and call `/rpc/acceptTask`,
`/rpc/closeTask` and the rest **as the daemon** — bypassing the ownership gates
that stop an agent acting on tasks that are not its own.

v0.20 moved new configs to the daemon state dir
(`~/.lazy/daemon/<slug>/mcp/`), which is deliberately never mounted into an
agent. It did not remove the files already sitting in the repo. That is what the
purge does.

## What the purge touches

Only `<project>/.lazy/tmp/daemon-mcp-*.json` — the historical in-repo path.

It never touches `~/.lazy/daemon/<slug>/mcp/`. Those are the live per-identity
configs, bind-mounted into running containers; deleting one takes an agent's
tools away mid-turn.

Files in `.lazy/tmp` that do not match that name are left alone.

The purge is idempotent: a project with nothing to clean removes nothing,
rotates nothing, and prints nothing.

## Why the token is rotated too

Deleting the files does not un-leak a credential that every agent has been able
to read for months. Any agent that copied it still holds a working key, so the
token itself has to be replaced. The rotation happens only on an upgrade that
actually removed leaked files — a project that never leaked keeps its token.

If some files could not be deleted, the token is **not** rotated and the upgrade
says so: rotating while readable copies remain would claim a fix that was not
made.

## Why nothing is stranded by the rotation

Chat, pair, builder and running agents all keep working. Who holds the shared
token, and what happens to each:

| Holder | Effect of rotation |
| --- | --- |
| Host CLI clients (`lazy …`, the builder's host side) | Heal automatically — the client re-reads the token file on a 401 and retries. |
| Task and builder **agents** | Unaffected. Their `lazy_*` tools go to `/mcp/*`, which authenticates against the per-identity token registry (`~/.lazy/daemon/<slug>/mcp-tokens.json`) and refuses the shared token outright. |
| A process **inside a container** holding the shared token | Cannot re-read a host-side file — the one class that could be stranded. |

The last row is why the purge runs where it does: after `lazy upgrade` has
stopped every task and builder container and the old daemon has exited, and
before the new daemon starts and adopts a token. In that window the un-healable
class is empty by construction. Rotating any earlier would 401 the upgrade's own
shutdown call.

## Seeing it before it happens

`lazy upgrade --dry-run` names the count and the rotation without changing
anything.
