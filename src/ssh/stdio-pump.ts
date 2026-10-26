/**
 * `lazy shell <task> --stdio` — the ProxyCommand half of SSH into a task
 * (docs/design/task-sessions-and-ssh.md §5). It is never typed by a person:
 * `ssh` runs it and talks the SSH protocol over its stdin/stdout. This pipes
 * those bytes to and from the daemon's attach route in `?mode=ssh` — through
 * Lazy Teams' relay for a bound clone, straight to the local daemon solo —
 * where an `sshd -i` in the task's environment is the other end.
 *
 * Framing is the terminal protocol's (../server/shell-protocol.ts): BINARY
 * frames are the SSH bytes, TEXT frames are control. A `status` or `error`
 * frame is written to stderr, which `ssh` shows the person; `ssh-audit` frames
 * are for the relay's audit and ignored here. stdout carries SSH bytes ONLY —
 * one stray byte there breaks the connection.
 */

import { parseShellServerMessage } from '../server/shell-protocol';

/** Stop reading stdin while this much is still queued on the socket. */
const SEND_HIGH_WATER = 4 * 1024 * 1024;

export interface StdioPumpOptions {
  url: string;
  headers: Record<string, string>;
  /** Test seams. */
  webSocket?: typeof WebSocket;
  stdin?: ReadableStream<Uint8Array>;
  stdout?: { write(data: Uint8Array): unknown };
  stderr?: { write(data: string): unknown };
  /**
   * Test seam: why the upgrade was refused. A refused WebSocket upgrade tells
   * its client nothing, so the default asks the same URL again as a plain GET
   * (same headers) and reads the JSON `error` the route answers with.
   */
  explainRefusal?: () => Promise<string | null>;
}

/**
 * The sentence a refused upgrade carries: the route answers a refusal as a
 * plain HTTP error (`{"error": …}` JSON, or text), which a WebSocket client
 * never sees — so the same request is made again as an ordinary GET.
 */
export async function refusalSentence(url: string, headers: Record<string, string>): Promise<string | null> {
  try {
    const res = await fetch(url.replace(/^ws/, 'http'), { headers, redirect: 'manual' });
    // 426 is a route saying only "this was not an upgrade" — not a reason.
    if (res.ok || res.status === 426) return null;
    const text = (await res.text()).trim();
    try {
      const body = JSON.parse(text) as { error?: unknown };
      if (typeof body.error === 'string' && body.error) return body.error;
    } catch (err) {
      void err; // Not JSON: the route's plain-text refusal is the sentence.
    }
    return text ? text.slice(0, 500) : `refused (HTTP ${res.status})`;
  } catch (err) {
    // The refusal is reported either way: without its sentence the caller
    // falls back to its own generic one, which is still true.
    void err;
    return null;
  }
}

/** Pump until either side ends. Resolves with the exit code `ssh` should see. */
export async function runSshStdioPump(opts: StdioPumpOptions): Promise<number> {
  const Ws = opts.webSocket ?? WebSocket;
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  const stdin = opts.stdin ?? (Bun.stdin.stream() as ReadableStream<Uint8Array>);
  const ws = new Ws(opts.url, { headers: opts.headers } as never);
  ws.binaryType = 'arraybuffer';

  let exitCode: number | null = null;
  let errorText: string | null = null;
  let opened = false;

  const done = new Promise<number>((resolve) => {
    ws.onopen = () => {
      opened = true;
      void pumpStdin();
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data === 'string') {
        const parsed = parseShellServerMessage(ev.data);
        if (!parsed.ok) return;
        const m = parsed.message;
        if (m.type === 'status') stderr.write(`lazy: ${m.message}\n`);
        else if (m.type === 'error') errorText = m.message;
        else if (m.type === 'exit') exitCode = m.code;
        return;
      }
      stdout.write(new Uint8Array(ev.data as ArrayBuffer));
    };
    ws.onerror = () => {
      errorText ??= opened ? 'the connection to the task failed' : 'the task refused or could not open the SSH connection';
    };
    ws.onclose = async (ev: CloseEvent) => {
      // Refused before it opened: ask for the route's own sentence, which is
      // what the person running ssh needs to read (no key registered, not a
      // member any more, …) — the bare WebSocket failure says nothing.
      if (!opened) {
        const why = await (opts.explainRefusal ?? (() => refusalSentence(opts.url, opts.headers)))();
        if (why) errorText = why;
      }
      if (errorText) stderr.write(`lazy: ${errorText}\n`);
      else if (ev.code !== 1000 && ev.reason) stderr.write(`lazy: ${ev.reason}\n`);
      resolve(errorText ? 1 : exitCode === null ? 0 : exitCode === 0 ? 0 : 1);
    };
  });

  async function pumpStdin(): Promise<void> {
    const reader = stdin.getReader();
    try {
      for (;;) {
        const { value, done: ended } = await reader.read();
        if (ended) break;
        if (ws.readyState !== 1) break;
        ws.send(value);
        while (ws.readyState === 1 && ws.bufferedAmount > SEND_HIGH_WATER) await Bun.sleep(5);
      }
    } catch (err) {
      errorText ??= `reading from ssh failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    // ssh closing our stdin means the connection is over.
    try {
      ws.close(1000, 'client closed');
    } catch (err) {
      // Already closing: the close handler settles the outcome either way.
      void err;
    }
  }

  return await done;
}
