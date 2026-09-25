/**
 * Generic WebSocket upgrade seam for the daemon's Bun.serve.
 *
 * The web request handler is a plain `(req) => Response` chain that knows
 * nothing about the `Server` handle a WebSocket upgrade needs. Rather than
 * thread `server` through every layer, a single {@link WebSocketUpgrader} is
 * handed to {@link tryBindTcpPort}: it gets first refusal on every request, and
 * when a request matches a WS route it resolves whatever it needs and calls
 * `server.upgrade()`. The HTTP handler runs only for requests it declines.
 *
 * One upgrader per bind. There are two WS features today — the web shell
 * (`src/server/shell-ws.ts`) and the live watch panel (`src/server/watch-ws.ts`)
 * — and they are composed with {@link composeUpgraders} rather than teaching
 * Bun.serve about two, because `Bun.serve` takes exactly one `websocket`
 * handler per bind.
 */

import type { Server } from 'bun';

/**
 * Outcome of offering a request to the upgrader:
 *  - `'upgraded'` — the connection was upgraded; the HTTP handler must not run
 *    and `fetch` returns undefined.
 *  - a `Response` — the request matched a WS route but was refused (bad method,
 *    missing token, no such task, container not running); send this response.
 *  - `null` — not a WS route; run the ordinary HTTP handler.
 */
export type UpgradeOutcome = 'upgraded' | Response | null;

export interface WebSocketUpgrader {
  tryUpgrade(req: Request, server: Server<unknown>): Promise<UpgradeOutcome>;
  /** The Bun WebSocket handler for connections this upgrader opened. */
  handler: import('bun').WebSocketHandler<unknown>;
}

/**
 * The key the composite stamps on each connection's `data` so the single Bun
 * handler can route a socket back to the upgrader that opened it. Non-enumerable
 * would be tidier, but `data` is an ordinary object each sub-upgrader built and
 * one extra key is invisible to them.
 */
const OWNER_KEY = '__lzWsOwner';

/**
 * Fold several upgraders into the one `Bun.serve` accepts.
 *
 * Routing is by ORIGIN, not by re-matching the path: whichever upgrader called
 * `server.upgrade()` owns that socket for its whole life, so a future route
 * whose path overlaps another's cannot deliver frames to the wrong feature. Each
 * sub-upgrader is offered the request in order and the first non-null outcome —
 * an upgrade OR a refusal — wins, so a route that recognizes a request but
 * rejects it (bad method, unknown task) is never silently retried by the next.
 */
export function composeUpgraders(upgraders: WebSocketUpgrader[]): WebSocketUpgrader {
  const ownerOf = (ws: { data?: unknown }): WebSocketUpgrader | null => {
    const data = ws.data as Record<string, unknown> | undefined;
    const index = data?.[OWNER_KEY];
    return typeof index === 'number' ? upgraders[index] ?? null : null;
  };

  // Bun calls only the callbacks present on the handler object, so every
  // callback any sub-handler defines has to exist here; each is a pass-through.
  const handler = {
    open(ws: unknown) { void ownerOf(ws as { data?: unknown })?.handler.open?.(ws as never); },
    message(ws: unknown, message: string | Buffer) {
      void ownerOf(ws as { data?: unknown })?.handler.message?.(ws as never, message as never);
    },
    close(ws: unknown, code: number, reason: string) {
      void ownerOf(ws as { data?: unknown })?.handler.close?.(ws as never, code, reason);
    },
    drain(ws: unknown) { void ownerOf(ws as { data?: unknown })?.handler.drain?.(ws as never); },
  };

  return {
    handler: handler as unknown as import('bun').WebSocketHandler<unknown>,

    async tryUpgrade(req: Request, server: Server<unknown>): Promise<UpgradeOutcome> {
      for (let i = 0; i < upgraders.length; i++) {
        // Hand the sub-upgrader a server whose upgrade() stamps ownership on the
        // data it passes; everything else is the real server.
        const tagging = new Proxy(server, {
          get(target, prop) {
            if (prop === 'upgrade') {
              return (upgradeReq: Request, options?: { data?: unknown }) => {
                const data = options?.data;
                if (data && typeof data === 'object') {
                  (data as Record<string, unknown>)[OWNER_KEY] = i;
                }
                return target.upgrade(upgradeReq, options as never);
              };
            }
            // Bun's Server is a NATIVE object: its methods and getters read
            // internal slots off `this`, and `this` inside a proxied call is
            // the Proxy — so a plain pass-through throws "Expected this to be
            // instanceof Server" the moment an upgrader calls one. Read every
            // other property off the real server, and hand back methods bound
            // to it, so `requestIP()`, `timeout()` and `publish()` work here
            // exactly as they do in a `fetch` handler.
            const value = Reflect.get(target, prop, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        }) as Server<unknown>;

        const outcome = await upgraders[i]!.tryUpgrade(req, tagging);
        if (outcome !== null) return outcome;
      }
      return null;
    },
  };
}
