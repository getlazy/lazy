/**
 * Client side of the live proxy-traffic subscription.
 *
 * The daemon holds a subscription open for a bounded window and then settles
 * (see src/daemon/proxy-watch.ts for why it is bounded). This module keeps the
 * subscription alive across those windows so the caller sees one continuous
 * stream, and de-duplicates the replay each new window opens with — replay is
 * what closes the handover gap, and the cost of closing it that way is a
 * repeated event, which is cheaper to drop here than to lose there.
 */

import { tryRpc, NotALazyProjectError } from '../daemon/client';
import { parseProxyActivityEvent } from '../proxy/activity';
import { PROXY_ACTIVITY_CHANNEL } from '../daemon/proxy-watch';
import { renderProxyActivity, credentialRefusalHint } from './proxy-activity-renderer';
import { dim, yellow } from './theme';

/**
 * Does this error mean the daemon does not know the command at all?
 *
 * Matched on the daemon's own 404 text (`Unknown RPC command: …`) rather than a
 * status code because tryRpc surfaces the message, and a running daemon from an
 * older build is the one skew case a user will actually hit — they upgrade lazy
 * and keep the daemon they already had.
 */
function isUnknownCommand(message: string): boolean {
  return /unknown rpc command/i.test(message) && message.includes('watchProxyActivity');
}

/** Window length asked of the daemon; it clamps to its own maximum. */
const WINDOW_MS = 120_000;

/**
 * Backoff between reconnect attempts; its LENGTH is how many consecutive
 * transport failures the stream tolerates before it gives up.
 *
 * A watch can run for hours, and a daemon restart or one dropped connection is
 * a normal event in that span — treating the first one as terminal silences the
 * load-bearing half of the screen for the rest of the session while supervisor
 * lines keep scrolling, which reads as "the agent stopped making requests".
 * Bounded rather than endless so a daemon that is genuinely gone is reported
 * instead of being retried into the void.
 */
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 8_000];

/**
 * How many event ids are remembered for de-duplication. Comfortably above the
 * daemon's replay ring (200), so an event can never be re-printed because we
 * forgot it before the daemon did.
 */
const SEEN_CAP = 1_000;

export interface ProxyStreamOptions {
  /** Restrict to one task's traffic. Omitted = every task (the firehose). */
  taskId?: string;
  /** Show the task id on each line — on for the firehose, off for one task. */
  includeTask: boolean;
  /** Where lines go. Injected so tests do not capture stdout. */
  write: (line: string) => void;
  /**
   * Backoff schedule between reconnect attempts. Defaults to RETRY_DELAYS_MS;
   * injected so the exhaustion path can be exercised without waiting out the
   * real 23 seconds of backoff.
   */
  retryDelaysMs?: number[];
}

export interface ProxyStreamHandle {
  /**
   * Stop streaming: the in-flight window is ABORTED, not merely abandoned.
   *
   * Without the abort the pending RPC holds its connection — and the process's
   * event loop — for the rest of the window, so `lazy watch` printed "Task X is
   * no longer running" and then sat there for up to two more minutes still
   * printing traffic lines. SIGINT hid it (that path calls process.exit); the
   * natural-completion path had nothing to hide behind.
   */
  stop(): void;
  /** Resolves when the loop has stopped — test use. */
  done: Promise<void>;
}

/**
 * Start streaming. Returns immediately; lines arrive on `write` as they happen.
 *
 * Failures here are NON-FATAL by design: `lazy watch` has other streams
 * (supervisor stdout, the agent's own session log) and losing the traffic layer
 * must not take those down with it. But it is never silent — the reason is
 * printed once, because a stream that stops without saying so is exactly the
 * "is it quiet or is it broken?" ambiguity this whole feature exists to remove.
 */
export function streamProxyActivity(options: ProxyStreamOptions): ProxyStreamHandle {
  const seen = new Map<string, true>();
  const controller = new AbortController();
  let running = true;

  const onEvent = (payload: unknown) => {
    // Events already in the transport buffer when stop() ran must not paint:
    // watch prints its "no longer running" line first, and a net> line after it
    // says the opposite of what the command just told the user.
    if (!running) return;
    const event = parseProxyActivityEvent(payload);
    // Not an activity event, or malformed: dropped rather than rendered as
    // `undefined undefined`. The daemon's payload is opaque to the transport,
    // so this is the boundary that has to check it.
    if (!event) return;

    const key = `${event.kind}:${event.id}`;
    if (seen.has(key)) return;
    seen.set(key, true);
    if (seen.size > SEEN_CAP) {
      // Maps iterate in insertion order, so this drops the oldest ids first.
      const excess = seen.size - SEEN_CAP;
      let dropped = 0;
      for (const k of seen.keys()) {
        seen.delete(k);
        if (++dropped >= excess) break;
      }
    }

    options.write(renderProxyActivity(event, { includeTask: options.includeTask }));
    const hint = credentialRefusalHint(event);
    if (hint) options.write(hint);
  };

  /** Sleep that wakes immediately when stop() fires. */
  const backoff = (ms: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(finish, ms);
    controller.signal.addEventListener('abort', finish, { once: true });
    function finish() {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', finish);
      resolve();
    }
  });

  const done = (async () => {
    let failures = 0;
    while (running) {
      try {
        // `replay: true` on EVERY window, not just the first: the daemon's ring
        // is the only thing covering the gap between windows, and the de-dup
        // above makes asking for it free.
        const result = await tryRpc(
          'watchProxyActivity',
          { taskId: options.taskId, durationMs: WINDOW_MS, replay: true },
          {
            onProgress: (event) => {
              if (event.kind !== 'activity') return;
              if (event.channel !== PROXY_ACTIVITY_CHANNEL) return;
              onEvent(event.payload);
            },
          },
          controller.signal,
        );
        // null means the daemon RPC path is bypassed (LAZY_TEST / the daemon
        // process itself). Returning immediately would spin this loop, so stop
        // and say why rather than burning a core in silence.
        if (result === null) {
          if (running) options.write(dim('(proxy traffic unavailable: daemon RPC is bypassed)'));
          return;
        }
        // A window that completed is proof the daemon is answering again.
        failures = 0;
      } catch (err) {
        if (!running) return;
        const message = err instanceof Error ? err.message : String(err);
        // A daemon that predates traffic streaming answers 404 to this command.
        // Rendering that as a dim aside would leave the user watching a screen
        // that says "traffic here" and never shows any — the exact failure this
        // feature exists to remove. Say it loudly, and name the fix.
        if (isUnknownCommand(message)) {
          options.write(yellow(
            'Proxy traffic is unavailable: this daemon predates traffic streaming.\n' +
            '  Run `lazy daemon restart` to pick up the current build.',
          ));
          return;
        }
        // Not being in a lazy project cannot change while the loop runs —
        // retrying it would just print the same thing five more times.
        if (err instanceof NotALazyProjectError) {
          options.write(dim(`(proxy traffic unavailable: ${message.split('\n')[0]})`));
          return;
        }

        // Everything else is transport-class: a daemon restart, a dropped
        // connection, a window that ended mid-envelope. Those are recoverable
        // and a watch may run for hours, so reconnect with backoff instead of
        // going quiet for the rest of the session. Still never silent — the
        // first failure says so, and exhaustion says so again with the reason.
        const first = message.split('\n')[0];
        const delays = options.retryDelaysMs ?? RETRY_DELAYS_MS;
        failures++;
        if (failures > delays.length) {
          options.write(dim(`(proxy traffic stopped after ${delays.length} reconnect attempts: ${first})`));
          return;
        }
        if (failures === 1) {
          options.write(dim(`(proxy traffic interrupted: ${first} — reconnecting)`));
        }
        await backoff(delays[failures - 1]!);
      }
    }
  })();

  return {
    stop() {
      running = false;
      controller.abort();
    },
    done,
  };
}
