import { lstat, readFile, readdir } from 'fs/promises';
import { join, resolve } from 'path';
import { spawn } from '../utils/spawn';
import { MCP_EXPECTED_TASK_ID_ENV, MCP_EXPECTED_WORKTREE_ENV } from '../mcp/turn-identity';
import { replaceCredentialFile, withCredentialFileLock } from './file-updates';
import { credentialSetDir, credentialSetsDir, validateSetName } from './scope';

export interface CredentialSetBinding {
  set: string | null;
  updatedAt: string;
}

const BINDING_FILE = '.lazy/credential-set.json';

export function requireCredentialPerson(): void {
  // INVARIANT: only a person may change credential sets or bindings. The
  // host-process runner has no container boundary to prevent an agent doing it.
  if (process.env[MCP_EXPECTED_TASK_ID_ENV] || process.env[MCP_EXPECTED_WORKTREE_ENV] || process.env.LAZY_TASK) {
    throw new Error('A person must run this credential command outside an agent turn. Agents cannot change credential sets or project bindings.');
  }
}

async function bindingPath(projectRoot: string): Promise<string> {
  const root = resolve(projectRoot);
  const git = await lstat(join(root, '.git')).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'ENOENT') throw err;
    return null;
  });
  if (git?.isFile()) throw new Error(`Read credential bindings from the project root, not the worktree at ${root}.`);
  const state = await lstat(join(root, '.lazy')).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'ENOENT') throw err;
    return null;
  });
  if (state?.isSymbolicLink()) throw new Error(`Credential binding state at ${root}/.lazy must not be a symbolic link.`);
  return join(root, BINDING_FILE);
}

async function requireUntracked(root: string): Promise<void> {
  const proc = spawn(['git', 'ls-files', '--', BINDING_FILE], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const [tracked, error, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`Cannot verify local credential binding at ${root}: ${error.trim()}`);
  if (tracked.trim()) throw new Error(`Refusing the tracked credential binding at ${root}/${BINDING_FILE}. A person must remove it from git before using credential sets.`);
}

export async function readCredentialSetBinding(root: string): Promise<CredentialSetBinding | null> {
  // INVARIANT: a set binding is never read from a file on a branch. Only the
  // root's ignored local state has authority; lazy.toml and worktrees do not.
  const path = join(resolve(root), BINDING_FILE);
  const metadata = await lstat(path).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'ENOENT') throw err;
    return null;
  });
  if (!metadata) return null;
  await bindingPath(root);
  if (!metadata.isFile()) throw new Error(`Credential binding ${path} must be a regular local file.`);
  await requireUntracked(root);
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    if (!parsed || (parsed.set !== null && typeof parsed.set !== 'string') || typeof parsed.updatedAt !== 'string' || !Number.isFinite(Date.parse(parsed.updatedAt))) {
      throw new Error('expected a set name (or null) and an ISO timestamp');
    }
    if (parsed.set !== null) validateSetName(parsed.set);
    return { set: parsed.set, updatedAt: parsed.updatedAt };
  } catch (err) {
    throw new Error(`Cannot read credential binding ${path}: ${err instanceof Error ? err.message : String(err)}. Rebind with lazy auth use <name> or lazy auth use --none.`);
  }
}

/** Catalogues contain no secrets. Empty directories left by a removal are not sets. */
export async function listCredentialSets(): Promise<string[]> {
  const dirs = await readdir(credentialSetsDir(), { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'ENOENT') throw err;
    return [];
  });
  const names: string[] = [];
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const index = await lstat(join(credentialSetDir(dir.name), 'credential-index.json')).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err;
      return null;
    });
    if (index?.isFile()) names.push(dir.name);
  }
  return names.sort();
}

export async function bindCredentialSet(root: string, name: string | null): Promise<CredentialSetBinding> {
  requireCredentialPerson();
  const path = await bindingPath(root);
  await requireUntracked(root);
  if (name !== null && !(await listCredentialSets()).includes(validateSetName(name))) {
    throw new Error(`Unknown credential set "${name}". Existing sets: ${(await listCredentialSets()).join(', ') || '(none)'}. Store one with lazy auth set <provider> --set <name>.`);
  }
  const binding = { set: name, updatedAt: new Date().toISOString() };
  // Register before binding. A crash can leave a conservative warning, never an
  // active binding omitted from removal warnings. Readers verify the local file.
  if (name !== null) {
    const registry = join(credentialSetDir(name), 'projects.json');
    await withCredentialFileLock(registry, async () => {
      const projects = await readProjects(registry);
      await replaceCredentialFile(registry, JSON.stringify([...new Set([...projects, resolve(root)])]) + '\n');
    });
  }
  await withCredentialFileLock(path, () => replaceCredentialFile(path, JSON.stringify(binding) + '\n'));
  return binding;
}

async function readProjects(path: string): Promise<string[]> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    if (!Array.isArray(parsed) || parsed.some(p => typeof p !== 'string')) throw new Error('expected project paths');
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(`Cannot read the credential set's project registry at ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function projectsUsingCredentialSet(name: string): Promise<string[]> {
  const projects = await readProjects(join(credentialSetDir(name), 'projects.json'));
  const using: string[] = [];
  for (const root of projects) {
    if ((await readCredentialSetBinding(root))?.set === name) using.push(root);
  }
  return using;
}
