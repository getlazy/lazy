/**
 * Async audit queue for the Anthropic passthrough proxy.
 *
 * Appends ProxyAuditRecords to storage one at a time (serialised via promise
 * chaining) so concurrent requests never interleave writes. Errors in a single
 * append do not block the queue — they are logged and discarded, because the
 * proxy's primary job is forwarding requests, not auditing them.
 *
 * Usage: call enqueue() from the hot path and return immediately; the write
 * completes asynchronously. This satisfies CLAUDE.md: no sync I/O on the
 * daemon's event loop.
 */

import type { Storage } from '../storage/interface';
import type { ProxyAuditRecord } from '../storage/types';
import { logger } from '../utils/logger';

export class AuditQueue {
  private storage: Storage;
  // Serial promise chain: each enqueue() tacks on a new .then() so appends
  // never overlap even when many requests are in-flight simultaneously.
  private chain: Promise<void> = Promise.resolve();

  constructor(storage: Storage) {
    this.storage = storage;
  }

  /** Fire-and-forget: enqueue a record. Returns immediately; write is async. */
  enqueue(record: ProxyAuditRecord): void {
    this.chain = this.chain.then(async () => {
      try {
        await this.storage.appendAuditRecord(record);
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
