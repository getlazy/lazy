/**
 * Branch-vs-root `[serve]` advice.
 *
 * A task worktree's lazy.toml has no authority — `loadConfig` is root-anchored
 * and must stay that way (docs/design/worktree-config-authority.md). A branch
 * that adds a service therefore does not get a published port until the change
 * is on the root.
 *
 * This module reads the worktree file as UNTRUSTED DATA: it never calls
 * `loadConfig`, never routes the bytes through the resolved-config path, and
 * never publishes, executes, or configures from what it finds. The only
 * output is a list of ports the branch declared that the root does not, each
 * with a `lazy forward <task> <port>` command the human can run.
 *
 * A missing or unparseable worktree file is that branch's problem, never a
 * failed page — we return no advice. A hostile value (non-integer port,
 * out-of-range, bad name) is dropped at this boundary, not thrown.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import type { ServicePort } from './ports';

const MAX_PORT = 65535;
const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** One port the branch declared that the root does not publish. */
export interface BranchServeAdvice {
  /** Service name as declared on the branch (the port as a string for `ports`). */
  name: string;
  /** Container port the branch asked for. */
  port: number;
  /** Exact command the human can run to reach it now. */
  command: string;
}

/**
 * Compare a branch's declared `[serve]` against the root's resolved list.
 * Pure — the caller reads and parses the worktree file.
 */
export function diffBranchServe(
  branch: ServicePort[],
  root: ServicePort[],
  taskRef: string,
): BranchServeAdvice[] {
  const rootPorts = new Set(root.map((s) => s.port));
  const seen = new Set<number>();
  const advice: BranchServeAdvice[] = [];
  for (const svc of branch) {
    // Compare by PORT, not name: root `web = 3000` already publishes 3000
    // even if the branch calls it `api`, and a branch `web = 4000` is new
    // even though the name already exists on the root.
    if (rootPorts.has(svc.port)) continue;
    if (seen.has(svc.port)) continue;
    seen.add(svc.port);
    advice.push({
      name: svc.name,
      port: svc.port,
      command: `lazy forward ${taskRef} ${svc.port}`,
    });
  }
  return advice;
}

/**
 * Pull `[serve]` ports and named services out of a parsed TOML object.
 *
 * Validation is at THIS boundary: only integers in range and names that
 * match the published `[serve.services]` rule are kept. Everything else
 * (strings-as-ports, floats, hostile objects) is dropped — the page must
 * not fail because a branch file is junk, and we must not render a junk
 * value into a command.
 */
export function extractServePorts(parsed: unknown): ServicePort[] {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const serve = (parsed as Record<string, unknown>).serve;
  if (serve === null || typeof serve !== 'object' || Array.isArray(serve)) return [];
  const table = serve as Record<string, unknown>;
  const out: ServicePort[] = [];
  const seenPorts = new Set<number>();

  const take = (name: string, port: number) => {
    if (seenPorts.has(port)) return;
    seenPorts.add(port);
    out.push({ name, port });
  };

  // Named services first: a `[serve.services]` entry is the identity a
  // human remembers, and a bare `ports` line for the same number is then
  // a duplicate we skip.
  const services = table.services;
  if (services !== null && typeof services === 'object' && !Array.isArray(services)) {
    for (const [name, raw] of Object.entries(services as Record<string, unknown>)) {
      if (!NAME_PATTERN.test(name)) continue;
      const port = asValidPort(raw);
      if (port === null) continue;
      take(name, port);
    }
  }

  if (Array.isArray(table.ports)) {
    for (const raw of table.ports) {
      const port = asValidPort(raw);
      if (port === null) continue;
      take(String(port), port);
    }
  }

  return out;
}

function asValidPort(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return null;
  if (raw < 1 || raw > MAX_PORT) return null;
  return raw;
}

/**
 * Parse a worktree lazy.toml as data. Returns [] when the file is missing,
 * unreadable, or unparseable — never throws.
 */
export function parseWorktreeServe(content: string): ServicePort[] {
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(content);
  } catch {
    // Unparseable branch config is that branch's problem, never a failed page.
    return [];
  }
  return extractServePorts(parsed);
}

/**
 * Read the worktree's lazy.toml and return advice for ports the root lacks.
 *
 * `worktreePath` is the task worktree directory. A missing path, a missing
 * file, or an unreadable file all mean "no advice" — the page still renders.
 */
export async function branchServeAdviceFor(
  worktreePath: string,
  rootDeclared: ServicePort[],
  taskRef: string,
): Promise<BranchServeAdvice[]> {
  let content: string;
  try {
    content = await readFile(join(worktreePath, 'lazy.toml'), 'utf-8');
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? (err as { code?: string }).code : undefined;
    if (code === 'ENOENT') return [];
    // Any other read failure (permission, not a file) is also "no advice":
    // this is a hint, not a reason to fail the page.
    return [];
  }
  return diffBranchServe(parseWorktreeServe(content), rootDeclared, taskRef);
}
