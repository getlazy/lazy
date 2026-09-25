/**
 * The hardware probe's host-side helpers are correct on Linux as well as macOS.
 *
 * The first Linux KVM run (2026-09-23) lost three results to host-side
 * assumptions that only held on a Mac: BSD `stat -f` tried first (GNU `stat -f`
 * is a real flag and printed a multi-line block into `$(( ))`), `lsof` asked
 * about a non-dumpable VMM from an unprivileged shell (a false FAIL), and the
 * host's public NIC address counted as an internal rebinding target. These
 * tests run the probe's own helper text under bash, so they check the shipped
 * code rather than a copy of it.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const repoRoot = resolve(import.meta.dir, '..', '..');
const probe = readFileSync(join(repoRoot, 'lazy-teams', 'bin', 'smolvm-hardware-probe'), 'utf8');
const preamble = probe.slice(0, probe.indexOf('# ── Stage 0:'));

/** One `name() { … }` definition (single- or multi-line) out of the probe. */
function fn(name: string): string {
  const one = preamble.match(new RegExp(`^${name}\\(\\) \\{.*\\}$`, 'm'));
  if (one) return one[0];
  const start = preamble.indexOf(`${name}() {`);
  expect(start, `${name} is defined before stage 0`).toBeGreaterThan(-1);
  return preamble.slice(start, preamble.indexOf('\n}\n', start) + 2);
}

function bash(script: string, stdin?: string): string {
  const r = Bun.spawnSync(['bash', '-uc', script], { stdin: stdin === undefined ? undefined : Buffer.from(stdin) });
  expect(r.exitCode, r.stderr.toString()).toBe(0);
  return r.stdout.toString();
}

describe('is_internal_address', () => {
  // INVARIANT: only private, link-local, loopback, CGNAT and ULA space is
  // internal. A public host address counted as internal is a false rebinding
  // FAIL on every server with a public NIC.
  const internal = ['10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.1.118', '169.254.169.254', '100.64.0.1',
    '100.96.0.1', '100.127.0.1', '127.0.0.1', 'fd53:4d00::1', 'fc00::1', 'fe80::1', '::1'];
  const external = ['8.8.8.8', '203.0.113.9', '172.32.0.1', '172.15.0.1', '100.128.0.1', '100.63.0.1', '2001:db8::1'];

  test('classifies each address', () => {
    const out = bash(`${fn('is_internal_address')}
for a in ${[...internal, ...external].join(' ')}; do if is_internal_address "$a"; then echo "$a internal"; else echo "$a public"; fi; done`);
    for (const a of internal) expect(out).toContain(`${a} internal\n`);
    for (const a of external) expect(out).toContain(`${a} public\n`);
  });
});

describe('stat helpers', () => {
  // INVARIANT: host-side stat tries GNU `-c` before BSD `-f`. GNU `stat -f` is
  // not an error — it prints a filesystem block — so BSD-first never falls back.
  test('file_size is a plain integer and file_owner_mode is "uid:gid mode"', () => {
    const dir = mkdtempSync(join(tmpdir(), 'probe-stat-'));
    const path = join(dir, 'f');
    writeFileSync(path, 'x'.repeat(1234));
    const out = bash(`${fn('file_size')}\n${fn('file_owner_mode')}\nP='${path}'\necho "size=$(( $(file_size "$P") ))"; file_owner_mode "$P"`);
    expect(out).toContain('size=1234\n');
    expect(out).toMatch(/^\d+:\d+ \d{3,4}$/m);
  });

  test('every host-side stat goes through the helpers, GNU first', () => {
    expect(fn('file_size')).toMatch(/stat -c %s "\$1" 2>\/dev\/null \|\| stat -f %z/);
    expect(fn('file_owner_mode')).toMatch(/stat -c '%u:%g %a' "\$1" 2>\/dev\/null \|\| stat -f/);
    const code = probe.split('\n').filter((l) => !l.trim().startsWith('#'));
    const bsd = code.filter((l) => /\bstat -f\b/.test(l));
    expect(bsd.every((l) => /^file_(size|owner_mode)\(\)/.test(l))).toBe(true);
  });
});

describe('host_listeners', () => {
  const awk = preamble.match(/\$SS -Hltnp "sport = :\$1" 2>\/dev\/null \| awk '([^']+)'/);

  test('parses ss output into "ADDRESS:PORT PID", PID empty when unseen', () => {
    expect(awk).not.toBeNull();
    const sample = [
      'LISTEN 0      128        127.0.0.1:27001      0.0.0.0:*    users:(("smolvm",pid=4242,fd=12))',
      'LISTEN 0      128          0.0.0.0:27001      0.0.0.0:*',
    ].join('\n') + '\n';
    const out = bash(`awk '${awk![1]}'`, sample);
    expect(out).toBe('127.0.0.1:27001 4242\n0.0.0.0:27001 \n');
  });

  // INVARIANT: the probe asks about host listeners only through host_listeners
  // (one diagnostic log dump excepted), so the Linux/ss path is never bypassed.
  // The stage-4 Ruby check keeps lsof only as its non-Linux fallback.
  test('no stage calls lsof for a listener directly', () => {
    const stages = probe.slice(probe.indexOf('# ── Stage 0:')).split('\n').filter((l) => !l.trim().startsWith('#'));
    const direct = stages.filter((l) => /\blsof -nP -iTCP/.test(l) && !l.includes('image-relay-host-lsof') && !l.includes('#{port}'));
    expect(probe).toMatch(/RUBY_PLATFORM\.include\?\("linux"\)[^\n]*\n\s*`ss -Hltn/);
    expect(direct).toEqual([]);
  });

  // INVARIANT: an owner the probe cannot see is never a FAIL. The VMM is
  // non-dumpable, so an unprivileged probe sees no owner for any listener.
  test('daemon_port_owner reports an unseen owner as INFO, not FAIL', () => {
    expect(probe).toMatch(/elif \[ -z "\$holder" \] && \[ "\$LISTENER_OWNER_VISIBLE" = 0 \]; then\n(?:\s*#.*\n)*\s*result daemon_port_owner INFO/);
  });
});
