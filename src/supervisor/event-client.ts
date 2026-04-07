/**
 * Supervisor-side SSE event client.
 *
 * Connects to the daemon's /events/stream endpoint on startup and
 * receives transient event signals in real-time. Events are queued
 * locally and delivered to the agent at turn boundaries (not mid-turn).
 *
 * Connection modes (same as MCP proxy):
 *   - Unix socket: when running on the host
 *   - TCP via host.docker.internal: when running inside a container
 *
 * Reconnection: exponential backoff on disconnect. On reconnect, the
 * daemon sends catchup events derived from current state (not replay).
 */

import { log, logWarn, logError } from './log';
import type { DaemonEvent } from '../daemon/events';

export interface EventClientConfig {
  /** Daemon bearer token for authentication */
  token: string;
  /** Project root path (sent as X-Lazy-Project header) */
  projectRoot: string;
  /** Task ID to subscribe events for */
  taskId: string;
  /**
   * Connection target. Either:
   *   - A unix socket path (e.g., ~/.lazy/daemon/lazy.sock)
   *   - An HTTP URL (e.g., http://host.docker.internal:26024)
   */
  target: string;
}

/** Queued events waiting to be delivered at the next turn boundary. */
const eventQueue: DaemonEvent[] = [];

/** Whether the client is connected. */
let connected = false;

/** Abort controller for the current fetch/connection. */
let abortController: AbortController | null = null;

/** Whether the client has been stopped. */
let stopped = false;

/** Current reconnect delay in ms (exponential backoff). */
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 30_000;
const INITIAL_RECONNECT_DELAY = 1000;

/**
 * Start the SSE event client. Connects to the daemon and begins
 * receiving events. Events are queued for delivery at turn boundaries.
 *
 * Non-blocking: connection runs in the background.
 */
export function startEventClient(config: EventClientConfig): void {
  stopped = false;
  reconnectDelay = INITIAL_RECONNECT_DELAY;

  log(`[event-client] Starting SSE client for task ${config.taskId.substring(0, 8)}`);
  connectWithRetry(config);
}

/**
 * Stop the SSE event client. Closes the connection and clears the queue.
 */
export function stopEventClient(): void {
  stopped = true;
  connected = false;

  if (abortController) {
    abortController.abort();
    abortController = null;
  }

  eventQueue.length = 0;
  log('[event-client] Stopped');
}

/**
 * Drain and return all queued events.
 * Call this at turn boundaries to get events that arrived since last drain.
 */
export function drainEvents(): DaemonEvent[] {
  const events = [...eventQueue];
  eventQueue.length = 0;
  return events;
}

/**
 * Check if there are queued events waiting to be delivered.
 */
export function hasQueuedEvents(): boolean {
  return eventQueue.length > 0;
}

/**
 * Check if the event client is connected to the daemon.
 */
export function isEventClientConnected(): boolean {
  return connected;
}

/**
 * Connect to the daemon SSE endpoint with automatic retry on failure.
 */
async function connectWithRetry(config: EventClientConfig): Promise<void> {
  while (!stopped) {
    try {
      await connect(config);
    } catch (err) {
      if (stopped) return;

      const msg = err instanceof Error ? err.message : String(err);
      logWarn(`[event-client] Connection failed: ${msg}. Retrying in ${reconnectDelay}ms`);
    }

    if (stopped) return;

    // Wait before reconnecting (exponential backoff)
    await new Promise(resolve => setTimeout(resolve, reconnectDelay));
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
  }
}

/**
 * Establish a single SSE connection to the daemon.
 * Resolves when the connection is closed (either by server or client).
 */
async function connect(config: EventClientConfig): Promise<void> {
  abortController = new AbortController();

  const fetchOptions: RequestInit & { unix?: string } = {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${config.token}`,
      'X-Lazy-Project': config.projectRoot,
      'Accept': 'text/event-stream',
    },
    signal: abortController.signal,
  };

  let url: string;
  const encodedTaskId = encodeURIComponent(config.taskId);
  if (config.target.startsWith('http://') || config.target.startsWith('https://')) {
    url = `${config.target}/events/stream?task_id=${encodedTaskId}`;
  } else {
    url = `http://localhost/events/stream?task_id=${encodedTaskId}`;
    (fetchOptions as any).unix = config.target;
  }

  const response = await fetch(url, fetchOptions);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text().catch(() => '')}`);
  }

  if (!response.body) {
    throw new Error('No response body');
  }

  connected = true;
  reconnectDelay = INITIAL_RECONNECT_DELAY; // Reset backoff on successful connection
  log(`[event-client] Connected to daemon SSE stream`);

  // Read the SSE stream
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (!stopped) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete SSE messages (delimited by double newline)
      const messages = buffer.split('\n\n');
      // Keep the last incomplete message in the buffer
      buffer = messages.pop() ?? '';

      for (const message of messages) {
        if (!message.trim()) continue;
        processSSEMessage(message);
      }
    }
  } finally {
    connected = false;
    reader.releaseLock();
    log('[event-client] Disconnected from daemon SSE stream');
  }
}

/**
 * Parse and process a single SSE message.
 *
 * SSE format:
 *   event: <type>
 *   data: <json>
 *
 * Or comment:
 *   : heartbeat
 */
function processSSEMessage(message: string): void {
  const lines = message.split('\n');

  let eventType: string | null = null;
  let data: string | null = null;

  for (const line of lines) {
    if (line.startsWith(':')) {
      // Comment (heartbeat) — ignore
      continue;
    }
    if (line.startsWith('event: ')) {
      eventType = line.slice(7);
    } else if (line.startsWith('data: ')) {
      data = line.slice(6);
    }
  }

  if (eventType === 'connected') {
    log('[event-client] Received connected event');
    return;
  }

  if (eventType && data) {
    try {
      const event = JSON.parse(data) as DaemonEvent;
      eventQueue.push(event);
      log(`[event-client] Queued event: ${event.type} from task ${event.source_task_id.substring(0, 8)}`);
    } catch (err) {
      logWarn(`[event-client] Failed to parse event data: ${data}`);
    }
  }
}
