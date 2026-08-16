/**
 * The error type every daemon route understands.
 *
 * Lives in its own module (rather than in rpc-handlers.ts, where it was
 * defined) so that input-validation helpers — ./rpc-params, ./http-body — can
 * raise it without importing the whole handler graph and forming an import
 * cycle with it. `rpc-handlers.ts` re-exports it, so existing importers are
 * unaffected.
 *
 * The `status` is load-bearing: routes map it to the HTTP status verbatim, so a
 * caller's bad argument stays a 400 instead of flattening into a 500 that reads
 * as a daemon crash (see test/e2e/mcp-route-status.test.ts).
 */
export class RpcError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
