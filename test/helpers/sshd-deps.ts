/**
 * Availability gate for suites that run a REAL `sshd -i` behind the daemon's
 * attach route (test/e2e/ssh-into-task.test.ts). They need OpenSSH's server
 * and client on this machine — the fake container runtime runs the exec here —
 * and Linux, whose 127/8 lets the service forwarder bind 127.0.1.1.
 *
 * INVARIANT (as `sandboxSuiteSkipped`): a skip prints exactly one line, so a
 * skipped suite is never silently green-by-omission. `Dockerfile.lazy` ships
 * openssh-server, so in lazy's own image this never skips.
 */

import { existsSync } from 'fs';
import { spawnSyncUnsupervised } from '../../src/utils/spawn';

export function sshdSuiteSkipped(suiteName: string): boolean {
  if (process.platform !== 'linux') {
    console.log(`skipped: ssh suite "${suiteName}" — needs Linux (the service forwarder binds 127.0.1.1)`);
    return true;
  }
  const missing: string[] = [];
  if (!existsSync('/usr/sbin/sshd')) missing.push('/usr/sbin/sshd');
  for (const bin of ['ssh', 'scp', 'sftp']) {
    if (spawnSyncUnsupervised(['sh', '-c', `command -v ${bin}`], { stdout: 'pipe', stderr: 'pipe' }).exitCode !== 0) missing.push(bin);
  }
  if (missing.length === 0) return false;
  console.log(`skipped: ssh suite "${suiteName}" — missing ${missing.join(', ')}; install with: sudo apt-get install -y openssh-server openssh-client`);
  return true;
}
