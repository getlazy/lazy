/**
 * Async audit queue for the Anthropic passthrough proxy.
 *
 * Appends ProxyAuditRecords to the project-local bounded audit log one at a
 * time (serialised via promise chaining) so concurrent requests never
 * interleave writes — and so the log's rotation bookkeeping only ever sees one
 * append at a time. Errors in a single append do not block the queue — they are
 * logged and discarded, because the proxy's primary job is forwarding requests,
 * not auditing them.
 *
 * Usage: call enqueue() from the hot path and return immediately; the write
 * completes asynchronously. This satisfies CLAUDE.md: no sync I/O on the
 * daemon's event loop.
 */

import type { ProxyAuditRecord } from '../storage/types';
import { logger } from '../utils/logger';

/** Minimal sink the queue writes to — `ProxyAuditLog` satisfies it. */
export interface AuditSink {
  append(record: ProxyAuditRecord): Promise<void>;
}

export class AuditQueue {
  private sink: AuditSink;
  // Serial promise chain: each enqueue() tacks on a new .then() so appends
  // never overlap even when many requests are in-flight simultaneously.
  private chain: Promise<void> = Promise.resolve();

  constructor(sink: AuditSink) {
    this.sink = sink;
  }

  /** Fire-and-forget: enqueue a record. Returns immediately; write is async. */
  enqueue(record: ProxyAuditRecord): void {
    this.chain = this.chain.then(async () => {
      try {
        await this.sink.append(record);
      } catch (err) {
        logger.warn(`[proxy] audit append failed for seq=${record.seq}: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }

  /** Drain: wait for all enqueued writes to complete (used in tests / shutdown). */
  async flush(): Promise<void> {
    await this.chain;
  }
}
