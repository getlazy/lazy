/**
 * Cross-process exclusive lock on a file, via flock(2). The kernel drops the
 * lock when its holder dies, so a crashed holder never wedges it (the stale-PID
 * problem a lock FILE has). Same mechanism as src/credentials/file-updates.ts.
 */
import { mkdir, open } from 'fs/promises';
import { constants } from 'os';
import { dirname } from 'path';

let nativeFlock: ((descriptor: number, operation: number) => number) | undefined;
let nativeErrno: (() => number) | undefined;

function tryFlock(descriptor: number, lockPath: string): boolean {
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
  // LOCK_EX | LOCK_NB
  if (nativeFlock!(descriptor, 2 | 4) === 0) return true;
  const errno = nativeErrno!();
  if (errno === 4 || errno === (process.platform === 'darwin' ? 35 : 11)) return false;
  const meaning = Object.entries(constants.errno).find(([, value]) => value === errno)?.[0] ?? 'unknown errno';
  throw new Error(`Cannot lock ${lockPath}: flock ${meaning} (errno ${errno}). This filesystem must support file locking.`);
}

/**
 * Run `action` while holding an exclusive lock on `lockPath`, waiting at most
 * `timeoutMs` for another process to release it. `waitingFor` names what the
 * holder is doing, for the timeout error.
 */
export async function withFileLock<T>(
  lockPath: string,
  action: () => Promise<T>,
  opts: { timeoutMs: number; waitingFor: string },
): Promise<T> {
  await mkdir(dirname(lockPath), { recursive: true });
  const lock = await open(lockPath, 'a+', 0o600);
  try {
    const deadline = performance.now() + opts.timeoutMs;
    while (!tryFlock(lock.fd, lockPath)) {
      if (performance.now() >= deadline) {
        throw new Error(`Timed out after ${Math.round(opts.timeoutMs / 1000)}s waiting for ${opts.waitingFor} (lock ${lockPath} is still held by another process).`);
      }
      await Bun.sleep(25);
    }
    return await action();
  } finally {
    await lock.close();
  }
}
