/**
 * Identity checks for the compiled `lazy-agent` binary.
 *
 * The agent binary is a Bun cross-compile of `src/agent-entry.ts` that lazy
 * bind-mounts into every container at /usr/local/bin/lazy-agent. When the file
 * at that path is NOT that binary, the failure surfaces late and cryptically:
 *
 *   - a bare Bun runtime answers `lazy-agent selfcheck` with exit 1 and NOTHING
 *     on stdout (`error: Script not found "selfcheck"` goes to stderr), and
 *     answers the container's real entry argv with `error: Script not found
 *     "builder"` — Bun's message for `bun <script>` with no such package script.
 *   - a host (macOS) binary or a truncated build dies with a usage dump or a
 *     bus error inside the container.
 *
 * Both were observed in the field after a local build + `lazy upgrade`. The
 * checks here let every producer of that file (extract, build, upgrade) verify
 * what it just installed BEFORE a container ever mounts it, so the failure is
 * reported on the host, by name, at the moment it is caused.
 *
 * The check is content-based on purpose: the binary is a Linux cross-compile, so
 * a macOS host cannot exec it to ask.
 */

import { open, stat } from 'fs/promises';

/**
 * Sentinel the compiled agent prints for `lazy-agent selfcheck`.
 *
 * Single source of truth: `src/agent-entry.ts` prints it, the builder preflight
 * greps the live output for it, and the content check below looks for it inside
 * the file. Keep it stable — a bare Bun runtime never contains it.
 */
export const AGENT_SELFCHECK_SENTINEL = 'lazy-agent ok';

/**
 * Smallest plausible agent binary. The real one is ~95MB; the dev-mode
 * placeholder (`echo placeholder > lazy-agent`) is 12 bytes.
 */
export const MIN_AGENT_BINARY_SIZE = 1024;

export type AgentBinaryVerdict = { ok: true } | { ok: false; reason: string };

/** ELF magic — the agent binary is always a Linux cross-compile. */
const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);

/** Mach-O magics (64-bit LE, universal), so a host binary gets a precise reason. */
const MACHO_MAGICS = [
  Buffer.from([0xcf, 0xfa, 0xed, 0xfe]),
  Buffer.from([0xce, 0xfa, 0xed, 0xfe]),
  Buffer.from([0xca, 0xfe, 0xba, 0xbe]),
];

/** Chunk size for the sentinel scan. Bounded memory over a ~95MB file. */
const SCAN_CHUNK = 4 * 1024 * 1024;

/**
 * Verify in-memory bytes are the compiled lazy agent.
 * Used for the embedded ($bunfs) binary, whose bytes are already read.
 */
export function verifyAgentBinaryBytes(bytes: Buffer | Uint8Array): AgentBinaryVerdict {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);

  if (buf.length < MIN_AGENT_BINARY_SIZE) {
    return { ok: false, reason: `only ${buf.length} bytes — a placeholder, not a binary` };
  }

  const header = headerVerdict(buf.subarray(0, 4));
  if (header) return { ok: false, reason: header };

  if (!buf.includes(AGENT_SELFCHECK_SENTINEL)) {
    return { ok: false, reason: bareBunReason(buf.length) };
  }

  return { ok: true };
}

/**
 * Verify the file at `path` is the compiled lazy agent.
 *
 * Checks, in order: it exists and is a regular file of plausible size; its magic
 * is ELF (not a macOS host binary); and it contains the selfcheck sentinel that
 * only a build of `src/agent-entry.ts` carries.
 */
export async function verifyAgentBinary(path: string): Promise<AgentBinaryVerdict> {
  let size: number;
  try {
    const st = await stat(path);
    if (!st.isFile()) return { ok: false, reason: 'not a regular file' };
    size = st.size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: false, reason: 'file does not exist' };
    }
    throw new Error(
      `Failed to inspect the agent binary at ${path}: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (size < MIN_AGENT_BINARY_SIZE) {
    return { ok: false, reason: `only ${size} bytes — a placeholder, not a binary` };
  }

  const handle = await open(path, 'r');
  try {
    const head = Buffer.alloc(4);
    await handle.read(head, 0, 4, 0);
    const header = headerVerdict(head);
    if (header) return { ok: false, reason: header };

    // Scan for the sentinel in overlapping chunks so a match straddling a chunk
    // boundary is still found.
    const overlap = AGENT_SELFCHECK_SENTINEL.length - 1;
    const buf = Buffer.alloc(SCAN_CHUNK);
    let position = 0;
    let carry = Buffer.alloc(0);
    while (position < size) {
      const { bytesRead } = await handle.read(buf, 0, SCAN_CHUNK, position);
      if (bytesRead <= 0) break;
      const window = carry.length > 0
        ? Buffer.concat([carry, buf.subarray(0, bytesRead)])
        : buf.subarray(0, bytesRead);
      if (window.includes(AGENT_SELFCHECK_SENTINEL)) return { ok: true };
      carry = Buffer.from(window.subarray(Math.max(0, window.length - overlap)));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }

  return { ok: false, reason: bareBunReason(size) };
}

function headerVerdict(head: Buffer): string | null {
  if (head.subarray(0, 4).equals(ELF_MAGIC)) return null;
  if (MACHO_MAGICS.some((m) => head.subarray(0, 4).equals(m))) {
    return 'a macOS (Mach-O) executable — the agent binary must be a Linux cross-compile';
  }
  return 'not an ELF executable — the agent binary must be a Linux cross-compile';
}

function bareBunReason(size: number): string {
  return (
    `${size} bytes of ELF that do not contain the '${AGENT_SELFCHECK_SENTINEL}' sentinel — ` +
    `this is a bare Bun runtime or another unrelated executable, not the compiled lazy agent`
  );
}

/**
 * Build the actionable error text for a rejected agent binary.
 *
 * `canRebuild` distinguishes a dev checkout (lazy can rebuild from source) from
 * an installed build (the human must reinstall).
 */
export function formatAgentBinaryError(
  path: string,
  reason: string,
  opts: { canRebuild: boolean },
): string {
  return (
    `The agent binary at ${path} is not the compiled lazy agent: ${reason}. ` +
    `Containers bind-mount this file at /usr/local/bin/lazy-agent, so launching with it ` +
    `would fail inside the container with 'Script not found "builder"' or an empty ` +
    `selfcheck, leaving the agent with no lazy_* tools. ` +
    (opts.canRebuild
      ? `Rebuild it with: bun run build (then 'lazy upgrade').`
      : `Reinstall lazy, then run: lazy upgrade.`)
  );
}
