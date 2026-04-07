/**
 * Cross-platform home directory resolution.
 *
 * On VMs like Lima (macOS host, Linux guest), Bun's os.homedir() can return
 * the *host* OS path (e.g., /Users/ierceg) which doesn't exist on the Linux
 * guest. This causes EACCES errors when trying to mkdir paths under it.
 *
 * This module provides getHome() which prefers $HOME (set correctly by the
 * guest OS) over os.homedir(). All code that creates/writes files in the
 * home directory should use getHome() instead of os.homedir().
 */

import { homedir } from 'os';

/**
 * Get the user's home directory, preferring $HOME over os.homedir().
 *
 * $HOME is set by the OS/shell and is always correct for the current
 * environment. os.homedir() uses getpwuid(3) which can return stale
 * or cross-platform paths on VMs.
 */
export function getHome(): string {
  return process.env.HOME || homedir();
}
