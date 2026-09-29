/**
 * The S10-S13 guest script (scripts/smolvm-probes/guest/uid1000.sh) runs inside
 * a VM booted from the lazy DAEMON image, so every tool it calls must exist in
 * that image.
 *
 * INVARIANT: uid1000.sh uses only tools the daemon image provides — Debian
 * bookworm's Essential set plus the image's own apt list. Missing guest tools
 * have already cost several Mac round trips (see smolvm-probe-guest-tools.test.ts),
 * because nothing in CI can boot the VM. This guard does not parse shell; it
 * checks the two ways it has gone wrong before: a tool the image does not ship
 * (python3, wget, busybox applets…) creeping into the script, and a package the
 * script needs dropping out of the image's apt list.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dir, '..', '..');
const script = readFileSync(join(repoRoot, 'scripts', 'smolvm-probes', 'guest', 'uid1000.sh'), 'utf8');
const dockerfile = readFileSync(join(repoRoot, 'lazy-teams', 'deploy', 'daemon-image', 'Dockerfile'), 'utf8');

/** Script text with comment lines removed, so prose never trips the scan. */
const code = script
  .split('\n')
  .filter((l) => !l.trimStart().startsWith('#'))
  .join('\n');

describe('uid1000.sh guest tools', () => {
  test('uses no tool the daemon image lacks', () => {
    // Not in the daemon image: not Essential, not in its apt list. (The image
    // has curl, iproute2 and socat, but uid1000.sh has no reason to need them.)
    const absent = ['python3', 'python', 'wget', 'busybox', 'sudo', 'adduser', 'apk', 'nc', 'strace'];
    const used = absent.filter((t) => new RegExp(`(^|[\\s;|&(\`"'])${t}(\\s|$)`, 'm').test(code));
    expect(used).toEqual([]);
  });

  test('relies on Essential tools only for everything but git and docker', () => {
    // setpriv/runuser (util-linux), useradd (passwd), getent (libc-bin), perl
    // (perl-base), stat/df/chown (coreutils), find (findutils) are all Debian
    // Essential: present in every debian:bookworm-slim without an apt line.
    for (const t of ['setpriv', 'useradd', 'getent', 'perl', 'find', 'stat', 'df']) {
      expect(code).toContain(t);
    }
  });

  test('the image still installs git and docker.io, which the script needs', () => {
    const install = dockerfile.slice(dockerfile.indexOf('apt-get install'));
    expect(install).toMatch(/^\s+git \\$/m);
    expect(install).toMatch(/^\s+docker\.io \\$/m);
    expect(dockerfile).toMatch(/debian:\$\{DEBIAN_TAG\}/);
    expect(dockerfile).toMatch(/DEBIAN_TAG=bookworm/);
  });
});
