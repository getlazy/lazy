import { unlink, rmdir } from 'fs/promises';
import { join } from 'path';
import {
  PID_FILE, LEGACY_SOCKET_FILE, TOKEN_FILE, WEB_PORT_FILE, WEB_HOST_FILE,
  LOG_FILE, ROOT_FILE, DAEMON_LOCK_FILE,
} from './paths';

// INVARIANT: prune only known runtime files, never the shared project directory
// recursively. Credentials and unknown future persistent data must survive.
const RUNTIME_FILES = [
  PID_FILE, LEGACY_SOCKET_FILE, TOKEN_FILE, WEB_PORT_FILE, WEB_HOST_FILE,
  LOG_FILE, ROOT_FILE, DAEMON_LOCK_FILE, 'start.lock', 'startup-error',
];

export async function pruneDaemonRuntime(dir: string): Promise<boolean> {
  for (const filename of RUNTIME_FILES) {
    await unlink(join(dir, filename)).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err;
    });
  }
  try {
    await rmdir(dir);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return true;
    if (code === 'ENOTEMPTY' || code === 'EEXIST') return false;
    throw err;
  }
}
