Develop the lazy proxy request plugin scaffolded at `{{pluginPath}}`.

## What this plugin is

Lazy runs a local Anthropic-native passthrough proxy that every agent's model
traffic flows through. A **request plugin** gets the parsed JSON body of each
outbound request just before it is forwarded upstream, and may return a
replacement body. Plugins are loaded by convention from `.lazy/plugins/` in the
project — presence is the enable switch, there is no config key — in sorted
filename order, and the chain is a fold: each plugin sees the previous one's
output.

The scaffold has two files:

- `{{pluginPath}}` — the plugin. Its default export is `{ name, transformRequest }`.
- `{{testPath}}` — a smoke test. Run it with `{{testCommand}}`.

## The contract you must not break

1. **Pure, synchronous, deterministic.** Same body in, same body out, always.
   No I/O, no clock, no random, no state carried between calls. This is not
   style: the upstream caches on the request prefix, so a transform that varies
   between turns invalidates the cache on every single request and costs far
   more than any transform can save.
2. **Never mutate `body` in place.** Build and return a new object. A later
   plugin throwing must not be able to leave a half-applied transform behind.
3. **Return `null` when there is nothing to do.** That is the cheap path, and it
   is what keeps requests you do not care about forwarded byte-for-byte.
4. **Fail open.** If the plugin throws at request time, lazy logs it and
   forwards the original body — so a bug degrades to passthrough, never to a
   failed request. Do not rely on that as control flow; do rely on it meaning a
   mistake here cannot take agents down.
5. **Load-time errors are loud.** A file that will not import, or that does not
   export the expected shape, fails the daemon's proxy startup. Keep the module
   importable.

## What is dangerous to touch, and why

- **`messages`** is the conversation transcript, including past assistant turns
  and `tool_result` blocks. Rewriting it falsifies the record the model itself
  produced, and changes the cached prefix on every request. Treat it as
  read-only unless you have a specific reason and have measured the cache cost.
- **`tools[].input_schema`** is JSON Schema, read by machine. Prose
  transformations do not apply to it; editing a property description can change
  what arguments the model sends.
- **`cache_control` markers, `model`, `max_tokens`, `stream`, `tool_choice`, and
  `metadata`** are protocol, not content. Carry them through untouched unless
  changing them is the explicit point of your plugin.
- **Non-text content blocks** (images, documents) are data. Leave them alone.

## How to work

1. Decide precisely WHAT this plugin changes and what it must never touch. Write
   that at the top of `{{pluginPath}}` as a comment before you write code.
2. Implement `transformRequest`. Guard on `ctx.endpoint` if the plugin only
   makes sense for `messages` requests.
3. Extend `{{testPath}}` with a test per behaviour you promised, plus one that
   asserts the untouched fields are carried through identically.
4. Run `{{testCommand}}` until green.
5. Restart the lazy daemon (`lazy daemon restart`). The startup log will name
   your plugin and its position in the chain — confirm it appears. Plugins are
   loaded once per daemon process, so an edit needs a restart to take effect.
6. Verify the real effect against real traffic with `lazy stats audit` and
   `lazy stats tokens`, not against your expectations.

## Before you call it done

Measure. A transform that sounds like it should help and is not measured to help
is a liability sitting on every agent's critical path. Report what changed, by
how much, and on what sample.

Plugin code runs inside the lazy daemon process, on the host, with the daemon's
privileges. It is not sandboxed. Keep it small enough to read in one sitting.
