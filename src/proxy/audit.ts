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

/**
 * How many consecutive failures with the SAME message are collapsed into one
 * log line. A sink that cannot append at all (an unwritable log path, a full
 * disk) would otherwise emit one warning per forwarded request and drown the
 * daemon log. Every distinct failure is still reported the first time it is
 * seen, and the suppressed count is reported when the run of identical
 * failures is summarized.
 */
const REPEAT_WARN_INTERVAL = 100;

export class AuditQueue {
  private sink: AuditSink;
  // Serial promise chain: each enqueue() tacks on a new .then() so appends
  // never overlap even when many requests are in-flight simultaneously.
  private chain: Promise<void> = Promise.resolve();
  private lastFailure: string | null = null;
  private repeatCount = 0;

  constructor(sink: AuditSink) {
    this.sink = sink;
  }

  /** Fire-and-forget: enqueue a record. Returns immediately; write is async. */
  enqueue(record: ProxyAuditRecord): void {
    this.chain = this.chain.then(async () => {
      try {
        await this.sink.append(record);
        this.lastFailure = null;
        this.repeatCount = 0;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message !== this.lastFailure) {
          this.lastFailure = message;
          this.repeatCount = 0;
          logger.warn(`[proxy] audit append failed for seq=${record.seq}: ${message}`);
          return;
        }
        this.repeatCount++;
        if (this.repeatCount % REPEAT_WARN_INTERVAL === 0) {
          logger.warn(
            `[proxy] audit append still failing (${this.repeatCount} more records dropped, latest seq=${record.seq}): ${message}`,
          );
        }
      }
    });
  }

  /** Drain: wait for all enqueued writes to complete (used in tests / shutdown). */
  async flush(): Promise<void> {
    await this.chain;
  }
}
