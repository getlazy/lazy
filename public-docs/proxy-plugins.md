# Proxy request plugins

Lazy runs a local Anthropic-native passthrough proxy that every agent's model
traffic flows through. A **request plugin** receives the parsed JSON body of each
outbound request just before it is forwarded upstream, and may return a
replacement body.

Lazy ships the **seam**, not plugins. There is no built-in plugin and nothing to
turn off: a project extends the proxy by dropping a module into
`.lazy/plugins/`, and a project that does not is byte-for-byte identical to a
build without the seam.

## Installing a plugin

Presence is the enable switch. There is no `lazy.toml` key.

```
<project>/.lazy/plugins/
  10-redact-secrets.ts
  20-tag-system.ts
```

- Every `.ts` / `.mts` / `.js` / `.mjs` module in that directory is loaded, in
  **sorted-filename order**. The chain is a fold: each plugin sees the previous
  one's output, so a numeric prefix gives an explicit, reviewable order.
- Dotfiles, `_`-prefixed files (shared helpers), `*.d.ts` and `*.test.*` /
  `*.spec.*` are **not** loaded — so a plugin's test can live right next to it.
- `.lazy/` is deliberately not gitignored. Commit your plugins and the whole team
  gets them.
- Plugins are loaded **once per daemon process**. After editing one, run
  `lazy daemon restart`.

Scaffold one with:

```bash
lazy customize proxy-plugin redact-secrets
```

That writes a working no-op plugin plus a smoke test into `.lazy/plugins/`, and
prints a guide prompt you can hand to your own agent to develop it further.

## The module shape

The default export is either the plugin object:

```ts
// .lazy/plugins/tag-system.ts
export default {
  name: 'tag-system',
  transformRequest(body, ctx) {
    const b = body as { system?: unknown };
    if (typeof b.system !== 'string') return null;   // null = no change
    return { ...(body as object), system: `[tagged] ${b.system}` };
  },
};
```

…or a zero-argument factory returning one, useful when the plugin needs to
precompute something at load time:

```ts
export default () => {
  const table = buildTable();          // runs ONCE, at daemon startup
  return { name: 'my-plugin', transformRequest: (body) => rewrite(body, table) };
};
```

`ctx` carries read-only request facts: `method`, `path`, and `endpoint`
(`"messages"`, `"count_tokens"` or `"other"`).

## The contract

1. **Pure, synchronous, deterministic.** Same body in, same body out. No I/O, no
   clock, no random, no state carried between calls. This is not style: the
   upstream caches on the request prefix, so a transform that varies between
   turns invalidates that cache on every single request and costs more than any
   transform is likely to save. A pure transform invalidates it exactly once.
2. **Never mutate `body` in place.** Build and return a new object.
3. **Return `null` when there is nothing to do.** That is the cheap path, and it
   is what keeps requests you do not care about forwarded byte-for-byte — the
   proxy only re-serialises when a plugin actually changed something.
4. **Treat `messages`, `tools[].input_schema`, `cache_control`, `model`,
   `max_tokens`, `stream`, `tool_choice`, `metadata` and non-text content blocks
   as off limits** unless changing them is the explicit point of your plugin.
   `messages` is the conversation transcript; rewriting it falsifies the record
   the model itself produced and moves the cached prefix every turn.

## Failure posture: loud at load, open at run

The two halves are deliberately different.

**Load time fails loud.** A file that will not import, does not default-export
the expected shape, has no `name`, has no `transformRequest`, or duplicates
another plugin's name aborts the daemon's proxy startup with an error naming the
file — the same posture as a malformed `lazy.toml`. You wrote that file on
purpose; a proxy that comes up healthy while your transform silently never runs
is the worst possible outcome.

**Run time fails open.** Once loaded, a plugin that throws on a request is logged
and skipped, and the original body is forwarded unmodified. The proxy is on every
agent's critical path, so a buggy transform degrades to passthrough, never to a
failed request.

When any plugins are loaded, the daemon announces them at startup by name and in
chain order. A transform rewriting outbound requests is never silently active.

## Trust and scope

Plugin code runs **inside the lazy daemon process, on the host, with the daemon's
privileges. It is not sandboxed.** Installing a plugin is exactly as much of a
trust decision as running any other code from the repository — review it as such,
and keep it small enough to read in one sitting.

Plugins are loaded from the **main project checkout only**, never from a task
worktree. A worktree is agent output; a plugin appearing there would let one task
agent rewrite every other agent's outbound requests.

## Measure before you keep one

A transform that sounds like it should help, sitting on every agent's critical
path, is a liability until it is measured. `lazy stats audit` and
`lazy stats tokens` show the real effect on real traffic. A transform that saves
tokens can still cost more than it saves — for example by invalidating the
upstream's prompt cache — so keep only what the numbers support.
