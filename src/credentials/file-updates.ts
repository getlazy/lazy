import { createHash, randomUUID } from 'crypto';
import { lstat, mkdir, open, realpath, rename, unlink } from 'fs/promises';
import { constants } from 'os';
import { basename, dirname, join } from 'path';

let nativeFlock: ((descriptor: number, operation: number) => number) | undefined;
let nativeErrno: (() => number) | undefined;

function tryLock(descriptor: number, lockPath: string): boolean {
  if (!nativeFlock) {
    const { dlopen, FFIType } = require('bun:ffi');
    const errnoSymbol = process.platform === 'darwin' ? '__error' : '__errno_location';
    const library = dlopen(process.platform === 'darwin' ? 'libSystem.B.dylib' : 'libc.so.6', {
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      [errnoSymbol]: { args: [], returns: FFIType.ptr },
    });
    nativeFlock = library.symbols.flock as typeof nativeFlock;
    nativeErrno = () => require('bun:ffi').read.i32(library.symbols[errnoSymbol]());
  }
  if (nativeFlock!(descriptor, 2 | 4) === 0) return true;
  const errno = nativeErrno!();
  if (errno === 4 || errno === (process.platform === 'darwin' ? 35 : 11)) return false;
  const meaning = Object.entries(constants.errno).find(([, value]) => value === errno)?.[0] ?? 'unknown errno';
  throw new Error(`Cannot lock credentials at ${lockPath}: flock ${meaning} (errno ${errno}). Credential updates require filesystem locking support.`);
}

async function rejectCredentialSymlink(path: string): Promise<void> {
  const metadata = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
  if (metadata?.isSymbolicLink()) {
    throw new Error(`Cannot update credentials at ${path}: symbolic links to credential files are not supported.`);
  }
}

export async function getCredentialLockPath(path: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await rejectCredentialSymlink(path);
  const canonicalPath = join(await realpath(dirname(path)), basename(path));
  const digest = createHash('sha256').update(canonicalPath).digest('hex');
  return join(process.platform === 'darwin' ? '/private/tmp' : '/tmp', `lazy-locks-${process.getuid!()}`, `${digest}.lock`);
}

export async function withCredentialFileLock<T>(
  path: string,
  update: () => Promise<T>,
  timeoutMs = 30_000,
): Promise<T> {
  const lockPath = await getCredentialLockPath(path);
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const directory = await lstat(dirname(lockPath));
  if (!directory.isDirectory() || directory.uid !== process.getuid!() || (directory.mode & 0o777) !== 0o700) {
    throw new Error(`Credential lock directory ${dirname(lockPath)} must be owned by the current user with mode 0700.`);
  }
  const lock = await open(lockPath, 'a+', 0o600);
  try {
    await lock.chmod(0o600);
    const deadline = performance.now() + timeoutMs;
    while (!tryLock(lock.fd, lockPath)) {
      if (performance.now() >= deadline) {
        throw new Error(`Timed out waiting to update credentials at ${path}. Another writer still holds the credential lock.`);
      }
      await Bun.sleep(10);
    }
    await rejectCredentialSymlink(path);
    return await update();
  } finally {
    await lock.close();
  }
}

export async function replaceCredentialFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await rejectCredentialSymlink(path);
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  const temporary = await open(temporaryPath, 'wx', 0o600);
  try {
    try {
      await temporary.writeFile(content);
      await temporary.sync();
    } finally {
      await temporary.close();
    }
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}
