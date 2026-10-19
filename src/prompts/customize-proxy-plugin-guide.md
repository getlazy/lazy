Develop the lazy proxy request plugin scaffolded at `{{pluginPath}}`.

## What this plugin is

Lazy runs a local Anthropic-native passthrough proxy that every agent's model
traffic flows through. A **request plugin** gets the parsed JSON body of each
outbound request just before it is forwarded upstream, and may return a
replacement body. Plugins live in `.lazy/plugins/`, run in sorted filename
order, and the chain is a fold: each plugin sees the previous one's output.

{{notRunNotice}}
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
5. **Keep the module importable.** A file that will not import, or that does
   not export the expected shape, is a load error for the plugin loader.

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
5. Do not restart the daemon expecting the plugin to load — it will not, and
   there is no real traffic to verify it against. The smoke test is the whole
   verification today.

## Before you call it done

Report what the plugin changes and what its tests prove. Keep it small enough
to read in one sitting.
