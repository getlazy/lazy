import { detectRemote } from '../remote';
import type { Storage } from '../storage/interface';
import type { Stats } from 'fs';
import { restoreSetupFile } from './setup-file-recovery';
import { link, lstat, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { randomBytes } from 'crypto';
import { dirname, join, isAbsolute, resolve } from 'path';
import { spawn } from '../utils/spawn';
import { runGit, withHooksDisabled } from '../utils/git';
import { isManagedMode, managedConfigPath } from '../config/managed';
import { createStorage } from '../storage';
import { ensureLazyExclude } from './lazy-exclude';
import { setupGitignoreText, setupStorageText, setupRemoteText } from './setup-edits';

/** cat-file is read as bytes: git's text-output wrapper would replace invalid UTF-8. */
async function readSetupBlob(root: string, oid: string): Promise<Buffer> {
  const proc = spawn(['git', ...withHooksDisabled(['cat-file', 'blob', oid])], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const [bytes, stderr, code] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(), new Response(proc.stderr).text(), proc.exited,
  ]);
  if (code !== 0) throw new Error('Cannot read committed setup bytes in ' + root + ': ' + stderr);
  return Buffer.from(bytes);
}

export interface SetupRecovery { restored: string[]; untouched: string[]; backups: string[] }

/** Only replay known setup edits against an unchanged index and a regular HEAD blob. */
export async function recoverManagedSetup(root: string, apply = false): Promise<SetupRecovery> {
  const result: SetupRecovery = { restored: [], untouched: [], backups: [] };
  if (!isManagedMode()) return result;
  const store = process.env.LAZY_MANAGED_STORAGE_PATH;
  if (!store || !isAbsolute(store)) throw new Error('LAZY_MANAGED_STORAGE_PATH must name the absolute fleet store before setup recovery.');
  const git = async (...args: string[]) => {
    const r = await runGit(args, { cwd: root, trim: false });
    if (r.exitCode !== 0) throw new Error(`Cannot inspect managed checkout ${root}: git ${args[0]} failed: ${r.stderr}`);
    return r.stdout;
  };
  // Never repair a task worktree, detached checkout, or a staged human edit.
  const branch = (await git('rev-parse', '--abbrev-ref', 'HEAD')).trim();
  if (branch === 'HEAD' || branch.startsWith('lazy/')) return result;
  if ((await git('rev-parse', '--git-dir')).trim() !== (await git('rev-parse', '--git-common-dir')).trim()) return result;
  const head = (await git('rev-parse', 'HEAD')).trim();
  const gitDir = resolve(root, (await git('rev-parse', '--git-common-dir')).trim());
  const remotes = (await git('remote')).trim().split('\n').filter(Boolean);
  const remote = remotes.includes('origin') ? 'origin' : remotes[0] ?? 'origin';
  for (const file of ['.gitignore', 'lazy.toml']) {
    const entry = await git('ls-tree', head, '--', file);
    const entryMatch = entry.match(/^100(644|755) blob ([0-9a-f]+)\t/);
    if (!entryMatch) {
      if ((await git('status', '--porcelain', '--untracked-files=all', '--', file)).trim()) result.untouched.push(file);
      continue;
    }
    const staged = await git('diff', '--cached', '--name-only', '--', file);
    if (staged.trim()) { result.untouched.push(file); continue; }
    const original = await readSetupBlob(root, entryMatch[2]!);
    const before = original.toString('utf8');
    const path = join(root, file);
    let current: string;
    let inspected: Stats;
    try {
      const stat = inspected = await lstat(path);
      if (!stat.isFile() || ((stat.mode & 0o111) !== 0) !== entry.startsWith('100755')) { result.untouched.push(file); continue; }
      const bytes = await readFile(path);
      if (bytes.equals(original)) continue;
      current = bytes.toString('utf8');
      if (!Buffer.from(current).equals(bytes)) { result.untouched.push(file); continue; }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') { result.untouched.push(file); continue; }
      throw new Error(`Cannot read ${path} for setup recovery: ${(err as Error).message}`);
    }
    const expected = file === '.gitignore' ? setupGitignoreText(before) : setupStorageText(before, resolve(store));
    const detected = file === 'lazy.toml' ? detectRemote(root, remote) : null;
    const withRemote = detected ? setupRemoteText(expected, detected.tomlOverrides) : expected;
    if (current !== expected && current !== withRemote) { result.untouched.push(file); continue; }
    if (apply) {
      const recovery = await restoreSetupFile(path, original, Buffer.from(current), inspected, gitDir, async () =>
        (await git('rev-parse', 'HEAD')).trim() === head
        && (await git('rev-parse', '--abbrev-ref', 'HEAD')).trim() === branch
        && !(await git('diff', '--cached', '--name-only', '--', file)).trim());
      if (recovery.backup) result.backups.push(recovery.backup);
      if (!recovery.restored) { result.untouched.push(file); continue; }
    }
    result.restored.push(file);
  }
  return result;
}

/** Seed forge defaults only when there is no repository config to import. */
async function seedManagedForgeConfig(root: string): Promise<void> {
  try {
    await lstat(join(root, 'lazy.toml'));
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Cannot inspect repository configuration: ' + (err as Error).message);
  }
  const detected = detectRemote(root, 'origin');
  if (!detected) return;
  const path = managedConfigPath(root);
  if (!path) throw new Error('Teams setup requires LAZY_MANAGED_CONFIG_PATH outside the checkout to save detected forge configuration.');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const staging = path + '.' + randomBytes(8).toString('hex') + '.tmp';
  try {
    const text = '[remote]\ndriver = ' + JSON.stringify(detected.tomlOverrides['remote.driver']) + '\n';
    await writeFile(staging, text, { mode: 0o600, flag: 'wx' });
    try { await link(staging, path); } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      // Existing Teams-owned configuration always wins, including on retries.
    }
  } finally { await rm(staging, { force: true }); }
}

/** Fleet init uses its environment-owned store; committed config is input only. */
export async function initializeManagedCheckout(root: string): Promise<void> {
  const store = process.env.LAZY_MANAGED_STORAGE_PATH;
  if (!store || !isAbsolute(store)) throw new Error('Teams setup requires an absolute LAZY_MANAGED_STORAGE_PATH.');
  await ensureLazyExclude(root);
  await mkdir(join(root, '.lazy'), { recursive: true });
  const storage = await createStorage(root, { backend: 'external', externalPath: store });
  try {
    await reportSetupRecovery(storage, await recoverManagedSetup(root, true));
  } finally { await storage.close(); }
  await seedManagedForgeConfig(root);
  const marker = await runGit(['rev-parse', '--git-path', 'info/lazy-managed-init'], { cwd: root });
  if (marker.exitCode !== 0) throw new Error(`Cannot resolve managed init marker: ${marker.stderr}`);
  await writeFile(resolve(root, marker.stdout), 'complete\n');
}

export async function reportSetupRecovery(storage: Storage, recovery: SetupRecovery): Promise<void> {
  if (!recovery.restored.length && !recovery.untouched.length) return;
  const body = [
    recovery.restored.length ? 'Restored setup-only edits to: ' + recovery.restored.join(', ') + '. Main can now update these files.' : '',
    recovery.untouched.length ? 'Left changes untouched in: ' + recovery.untouched.join(', ') + '. They do not exactly match setup edits; a project administrator must decide which changes to keep before main can update them.' : '',
    recovery.backups.length ? 'Recovery copies were retained at: ' + recovery.backups.join(', ') + '.' : '',
  ].filter(Boolean).join('\n\n');
  await storage.createSystemMessage({ source: 'managed-setup', kind: recovery.untouched.length ? 'alert' : 'notice', title: 'Project checkout setup recovery', body }, { collapseRepeats: true });
}
