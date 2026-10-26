/**
 * The tmux `shell` session a person's terminal opens (src/terminal/shell-session.ts).
 */

import { describe, test, expect } from 'bun:test';
import { mkdtemp, rm, symlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { shellSessionCommand, listSessionsCommand, parseSessionActivity, parseShellSessionName, TMUX_SOCKET, SHELL_SESSION } from '../../src/terminal/shell-session';

describe('the shell session command', () => {
  // INVARIANT: a person's terminal ATTACHES to the named session when it
  // exists (`new-session -A`), so a reconnect, a reload or a second tab lands
  // in what they left running instead of a fresh shell; on lazy's fixed
  // socket, so every exec reaches the same tmux server.
  test('creates or attaches the named session on the fixed socket', () => {
    const [sh, flag, script] = shellSessionCommand();
    expect([sh, flag]).toEqual(['sh', '-c']);
    expect(script).toContain(`tmux -S ${TMUX_SOCKET} new-session -A -s ${SHELL_SESSION}`);
  });

  // INVARIANT: an image without tmux still opens a plain shell — the project's
  // image is the user's, and a terminal must never fail for want of tmux.
  test('falls back to a plain shell when the image has no tmux', async () => {
    const bin = await mkdtemp(join(tmpdir(), 'shell-session-'));
    try {
      // A PATH with sh and nothing else: no tmux, no bash.
      await symlink('/bin/sh', join(bin, 'sh'));
      const [, , script] = shellSessionCommand();
      const proc = Bun.spawn(['/bin/sh', '-c', script!], {
        env: { PATH: bin },
        stdin: new Blob(['echo plain-shell-$((1+1))\n']),
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const out = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(0);
      expect(out).toContain('plain-shell-2');
    } finally {
      await rm(bin, { recursive: true, force: true });
    }
  });

  test('listing sessions with no tmux answers nothing, successfully', async () => {
    const [, , script] = listSessionsCommand();
    const proc = Bun.spawn(['/bin/sh', '-c', script!], { env: { PATH: '/nonexistent' }, stdout: 'pipe' });
    expect(await new Response(proc.stdout).text()).toBe('');
    expect(await proc.exited).toBe(0);
  });
});

describe('session names', () => {
  test('default to shell, accept plain names, refuse anything else', () => {
    expect(parseShellSessionName(null)).toBe('shell');
    expect(parseShellSessionName('')).toBe('shell');
    expect(parseShellSessionName('shell-2')).toBe('shell-2');
    for (const bad of ['Shell', '-x', 'a;b', 'a b', '$(id)', 'x'.repeat(33)]) expect(parseShellSessionName(bad)).toBeNull();
  });

  test('a named session is the one the command attaches, and a bad name never reaches a script', () => {
    expect(shellSessionCommand('shell-2')[2]).toContain('new-session -A -s shell-2 ');
    expect(() => shellSessionCommand('a;rm -rf /')).toThrow(/invalid shell session name/);
  });
});

describe('parseSessionActivity', () => {
  test('counts sessions, any attached client, and the latest activity', () => {
    expect(parseSessionActivity('0 1700000000\n1 1700000100\n')).toEqual({ sessions: 2, attached: true, lastActivityMs: 1_700_000_100_000, named: [] });
  });

  test('no output is no session', () => {
    expect(parseSessionActivity('')).toEqual({ sessions: 0, attached: false, lastActivityMs: null, named: [] });
  });

  test('skips lines that are not tmux format output', () => {
    expect(parseSessionActivity('no server running on /tmp/lazy-tmux/default\n0 5\n')).toEqual({ sessions: 1, attached: false, lastActivityMs: 5000, named: [] });
  });
});

describe('parseSessionActivity with session names', () => {
  test('names each session with its clients and activity — names only, nothing it printed', () => {
    expect(parseSessionActivity('1 1700000000 shell\n0 1700000100 vscode-server\n').named).toEqual([
      { name: 'shell', attachedClients: 1, lastActivityMs: 1_700_000_000_000 },
      { name: 'vscode-server', attachedClients: 0, lastActivityMs: 1_700_000_100_000 },
    ]);
  });
});

describe('session list parse: names it will not repeat', () => {
  // INVARIANT: every live session counts toward keep-or-vacate, whatever it is
  // called — an uncounted session is one whose container is removed under it.
  test('a session named with spaces still counts, and is left out of the names', () => {
    const a = parseSessionActivity('0 1700000000 my work\n1 1700000100 shell\n');
    expect(a.sessions).toBe(2);
    expect(a.named?.map((n) => n.name)).toEqual(['shell']);
  });
});

describe('shell entry notice', () => {
  // INVARIANT: the entry notice reaches tmux as an argument with its format
  // character escaped, never in the script text — a member-chosen name in it
  // must not run anything (tmux runs #(...) in display-message).
  test('rides as $1, escaped, outside the script', () => {
    const argv = shellSessionCommand('shell', 'In t with you: #(touch /tmp/pwned)');
    expect(argv[2]).not.toContain('pwned');
    expect(argv[2]).toContain('display-message -d');
    expect(argv.slice(3)).toEqual(['lazy-shell', 'In t with you: ##(touch /tmp/pwned)']);
  });

  test('without a notice the command is unchanged', () => {
    expect(shellSessionCommand('shell', null)).toEqual(shellSessionCommand('shell'));
    expect(shellSessionCommand('shell')).toHaveLength(3);
  });
});
