/**
 * Unit tests for SSH into a task (docs/design/task-sessions-and-ssh.md §5):
 * key material, the authorized-keys parser, the sshd wrapper's bounds, the
 * audit-line parser, the non-TTY exec demultiplexer, the config block and the
 * service-forward grants. The end-to-end path (a real ssh client and a real
 * sshd behind the daemon) is test/e2e/ssh-into-task.test.ts.
 */

import { describe, test, expect, spyOn } from 'bun:test';
import { mkdtemp, writeFile, chmod, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

import { generateEd25519KeyPair, parseAuthorizedKeys, parsePublicKeyLine } from '../../src/ssh/keys';
import { parseSshdLogLine, sshdExecCommand, sshdExecEnv, sshSessionScript, SSH_ENV_HOST_KEY } from '../../src/ssh/sshd-command';
import { parseAuthorizedKeysHeader, queueOrWriteSshInput, flushSshInput, startSshConnection, relaySshOutput, logSshConnectionEnd, type SshConnectionData } from '../../src/ssh/connection';
import { demuxDockerStream } from '../../src/runner/docker-exec-stream';
import { sshConfigBlock, sshHostAlias, selfInvocation, shWord } from '../../src/ssh/config-block';
import { lookupForwardGrant, mintForwardGrant, revokeForwardGrant, serviceHostNames } from '../../src/ssh/service-forward';
import { shellSessionCommand, TMUX_SOCKET, SHELL_SESSION } from '../../src/terminal/shell-session';
import { parseShellServerMessage } from '../../src/server/shell-protocol';

const hasSshKeygen = Bun.spawnSync(['sh', '-c', 'command -v ssh-keygen']).exitCode === 0;

describe('SSH key material', () => {
  test.skipIf(!hasSshKeygen)('a generated Ed25519 key is one OpenSSH reads, with the fingerprint ssh-keygen prints', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lzsshkey-'));
    try {
      const pair = generateEd25519KeyPair('unit@test');
      const keyPath = join(dir, 'id');
      await writeFile(keyPath, pair.privateKey);
      await chmod(keyPath, 0o600);
      await writeFile(`${keyPath}.pub`, `${pair.publicKey}\n`);
      const derived = Bun.spawnSync(['ssh-keygen', '-y', '-f', keyPath]).stdout.toString().trim();
      expect(derived).toBe(pair.publicKey);
      const listed = Bun.spawnSync(['ssh-keygen', '-lf', `${keyPath}.pub`]).stdout.toString();
      expect(listed).toContain(parsePublicKeyLine(pair.publicKey)!.fingerprint);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // INVARIANT: what reaches sshd's authorized_keys is a plain key, never a line
  // carrying options (`command=`, `permitopen=`, …) — those are decisions lazy
  // makes — and never a key whose blob disagrees with its declared type.
  test('only plain public keys of known types are accepted', () => {
    const key = generateEd25519KeyPair('c').publicKey;
    expect(parsePublicKeyLine(key)?.line).toBe(key.split(' ').slice(0, 2).join(' '));
    expect(parsePublicKeyLine(`command="rm -rf /" ${key}`)).toBeNull();
    expect(parsePublicKeyLine(`ssh-rsa ${key.split(' ')[1]}`)).toBeNull();
    expect(parsePublicKeyLine('ssh-dss AAAAB3NzaC1kc3MAAACBAP==')).toBeNull();
    expect(parsePublicKeyLine('-----BEGIN OPENSSH PRIVATE KEY-----')).toBeNull();
  });

  test('one bad line refuses the whole set; duplicates and comments are dropped', () => {
    const a = generateEd25519KeyPair('a').publicKey;
    const b = generateEd25519KeyPair('b').publicKey;
    const ok = parseAuthorizedKeys(`# mine\n${a}\n\n${b}\n${a}\n`);
    expect(ok.ok && ok.keys.length).toBe(2);
    const bad = parseAuthorizedKeys(`${a}\nnot a key\n`);
    expect(bad.ok).toBe(false);
  });

  test('the relay header is strict Base64 of the key text', () => {
    const a = generateEd25519KeyPair('a').publicKey;
    const good = parseAuthorizedKeysHeader(Buffer.from(`${a}\n`).toString('base64'));
    expect(good.ok && good.keys.length).toBe(1);
    expect(parseAuthorizedKeysHeader(null)).toEqual({ ok: true, keys: [] });
    expect(parseAuthorizedKeysHeader('not base64!').ok).toBe(false);
  });
});

describe('the sshd wrapper', () => {
  // INVARIANT: the bounds the design note sets are written into every
  // connection's sshd config, not left to the image's defaults: keys only,
  // `-L` only (no `-R`), no agent or X11 forwarding, no tunnel devices, no
  // Unix-socket forwarding, and the user's own rc/environment files ignored.
  test('every connection runs with the design bounds', () => {
    const script = sshdExecCommand()[2]!;
    for (const line of [
      'AuthenticationMethods publickey',
      'PasswordAuthentication no',
      'KbdInteractiveAuthentication no',
      'AllowTcpForwarding local',
      'AllowAgentForwarding no',
      'AllowStreamLocalForwarding no',
      'X11Forwarding no',
      'PermitTunnel no',
      'GatewayPorts no',
      'PermitUserEnvironment no',
      'PermitUserRC no',
      'ForceCommand $d/session',
    ]) expect(script).toContain(`\n${line}\n`);
    // `sshd -i`: one process per connection on the exec's own stdio.
    expect(script).toMatch(/"\$S" -i -e -f "\$d\/sshd_config"/);
    // Key material is unset before the container's environment is captured
    // for the session, so it never reaches the person's shell.
    expect(script.indexOf(`unset ${SSH_ENV_HOST_KEY}`)).toBeLessThan(script.indexOf('export -p'));
  });

  // INVARIANT: SSH lands where the web Shell lands — an interactive login with
  // a terminal is the person's tmux `shell` session — while commands and SFTP
  // (what remote editors and scp use) run directly, never inside tmux.
  test('an interactive login joins the shell session; commands and sftp run directly', () => {
    const session = sshSessionScript();
    expect(session).toContain(shellSessionCommand()[2]!.replace(/'/g, `'\\''`));
    // The ONE tmux server per container, shared with the task's `services`
    // session and the web Shell: an SSH login is the same `shell` session.
    expect(session).toContain(`tmux -S ${TMUX_SOCKET} new-session -A -s ${SHELL_SESSION}`);
    expect(session).toContain('internal-sftp|*sftp-server*)');
    expect(session).toContain('exec "$_shell" -c "$_cmd"');
  });

  // INVARIANT: the "who else is here" notice reaches ONLY the interactive
  // login's shell session, as a quoted argument with tmux's # escaped — never
  // in a command or sftp branch, and never able to run anything.
  test('an interactive login carries the presence notice; commands and sftp do not', () => {
    const session = sshSessionScript("In t with you: agent: it's #(rm -rf /)");
    const lines = session.split('\n');
    const interactive = lines.find((l) => l.includes('exec sh -c'))!;
    expect(interactive.endsWith(` 'lazy-shell' 'In t with you: agent: it'\\''s ##(rm -rf /)'`)).toBe(true);
    expect(lines.filter((l) => l.includes('In t with you'))).toHaveLength(1);
    expect(sshSessionScript(null)).toBe(sshSessionScript());
    const env = sshdExecEnv({ hostKey: 'K', authorizedKeys: [], workdir: '/w', notice: 'In t with you: agent: x' });
    const script = Buffer.from(env.find((e) => e.startsWith('LAZY_SSH_SESSION_SCRIPT='))!.split('=')[1]!, 'base64').toString();
    expect(script).toContain("'In t with you: agent: x'");
  });

  test('the environment carries the host key, keys, script and workdir, and forwards only for a member', () => {
    const env = sshdExecEnv({ hostKey: 'K', authorizedKeys: ['ssh-ed25519 AAAA'], workdir: '/w' });
    expect(env.some((e) => e.startsWith('LAZY_SSH_FORWARD_'))).toBe(false);
    expect(env).toContain('LAZY_SSH_WORKDIR=/w');
    const member = sshdExecEnv({ hostKey: 'K', authorizedKeys: [], workdir: '/w', forward: { url: 'http://h:1', token: 't', ports: [3000, 5432], hosts: ['services', 'web'] } });
    expect(member).toContain('LAZY_SSH_FORWARD_PORTS=3000,5432');
    expect(member).toContain('LAZY_SSH_FORWARD_HOSTS=services web');
  });

  test("the audit lines are read off sshd's log", () => {
    expect(parseSshdLogLine('Accepted publickey for lazy from UNKNOWN port 65535 ssh2: ED25519 SHA256:Gg+a6WSgc8JwK9heYE/Mi2VyFppMSpQyBzeT3b7Q548'))
      .toEqual({ event: 'key', keyType: 'ED25519', fingerprint: 'SHA256:Gg+a6WSgc8JwK9heYE/Mi2VyFppMSpQyBzeT3b7Q548' });
    expect(parseSshdLogLine('debug1: server_request_direct_tcpip: originator 127.0.0.1 port 39310, target web port 3000'))
      .toEqual({ event: 'forward', host: 'web', port: 3000 });
    expect(parseSshdLogLine('lazy-ssh: sshd-missing')).toEqual({ event: 'sshd-missing' });
    expect(parseSshdLogLine('debug1: something else')).toBeNull();
  });

  test('the audit frames round-trip through the terminal protocol', () => {
    const key = parseShellServerMessage(JSON.stringify({ type: 'ssh-audit', event: 'key', keyType: 'ED25519', fingerprint: 'SHA256:x' }));
    expect(key.ok).toBe(true);
    const fwd = parseShellServerMessage(JSON.stringify({ type: 'ssh-audit', event: 'forward', host: 'web', port: 3000 }));
    expect(fwd.ok).toBe(true);
    expect(parseShellServerMessage(JSON.stringify({ type: 'ssh-audit', event: 'forward', host: 'web' })).ok).toBe(false);
  });
});

describe('the SSH stream', () => {
  test('a non-TTY exec stream is split into stdout and stderr across chunk boundaries', () => {
    const frame = (stream: number, text: string) => {
      const body = Buffer.from(text);
      const head = Buffer.alloc(8);
      head[0] = stream;
      head.writeUInt32BE(body.length, 4);
      return Buffer.concat([head, body]);
    };
    const all = Buffer.concat([frame(1, 'SSH-2.0-x'), frame(2, 'log line'), frame(1, 'more')]);
    const first = demuxDockerStream(all.subarray(0, 12));
    expect(first.frames).toEqual([]);
    const second = demuxDockerStream(Buffer.concat([first.rest, all.subarray(12)]));
    expect(second.frames.map((f) => [f.stream, Buffer.from(f.data).toString()])).toEqual([[1, 'SSH-2.0-x'], [2, 'log line'], [1, 'more']]);
    expect(second.rest.length).toBe(0);
  });

  // INVARIANT: the SSH client speaks first, usually while the member's
  // container is still being made; its bytes are held in order, never dropped.
  test('input that arrives before sshd runs is held and flushed in order', () => {
    const conn: SshConnectionData = { who: 'a', task: 't' };
    const written: string[] = [];
    const exec = { write: (b: Uint8Array) => written.push(Buffer.from(b).toString()) };
    const ws = { send: () => 0, sendBinary: () => 0, close: () => {} } as never;
    queueOrWriteSshInput(ws, conn, null, Buffer.from('banner'));
    queueOrWriteSshInput(ws, conn, exec, Buffer.from('kex'));
    expect(written).toEqual([]);
    flushSshInput(conn, exec);
    queueOrWriteSshInput(ws, conn, exec, Buffer.from('after'));
    expect(written).toEqual(['banner', 'kex', 'after']);
  });
});

describe('the ssh config block', () => {
  // INVARIANT: distinct Teams origins keep distinct Host blocks and key pins.
  // Local installs commonly share a hostname and differ only by port.
  test('names the scheme and port of non-default Teams origins', () => {
    const task = { id: 'abcdef1234', code: 'demo' };
    const alias = (teamsUrl: string) => sshHostAlias(task, { teamsProject: 'acme/shop', teamsUrl });
    expect(alias('https://teams.example.com')).toBe('demo.shop.acme.teams.example.com');
    expect(alias('https://teams.example.com:443')).toBe(alias('https://teams.example.com'));
    expect(alias('http://localhost:3000')).toBe('demo.shop.acme.localhost--http-3000');
    expect(alias('http://localhost:4000')).toBe('demo.shop.acme.localhost--http-4000');
    expect(alias('http://teams.example.com')).toBe('demo.shop.acme.teams.example.com--http-80');
    expect(alias('https://teams.example.com:8443')).toBe('demo.shop.acme.teams.example.com--https-8443');
  });

  test('anchors the project and pins the host key', () => {
    const alias = sshHostAlias({ id: 'abcdef1234', code: 'My_Task' }, { teamsProject: 'acme/shop', teamsUrl: 'https://teams.example.com' });
    expect(alias).toBe('my-task.shop.acme.teams.example.com');
    expect(sshHostAlias({ id: 'abcdef1234', code: null }, { root: '/home/x/My Repo' })).toBe('abcdef12.my-repo.lazy');
    expect(sshHostAlias({ id: 'abcdef1234', code: 'my-task' }, { teamsProject: 'other/shop', teamsUrl: 'https://teams.example.com' })).not.toBe(alias);
    expect(sshHostAlias({ id: 'abcdef1234', code: 'my-task' }, { teamsProject: 'acme/shop', teamsUrl: 'https://other.example.com' })).not.toBe(alias);
    const block = sshConfigBlock({ alias, taskRef: 'my-task', root: '/home/x/clone dir', lazyArgv: ['/usr/local/bin/lazy'] });
    expect(block).toContain(`Host ${alias}\n`);
    expect(block).toContain("ProxyCommand /usr/local/bin/lazy shell my-task --stdio --root '/home/x/clone dir'");
    expect(block).toContain('StrictHostKeyChecking yes');
    expect(block).toContain('ForwardAgent no');
    expect(block).toContain('User lazy');
  });

  test('runs lazy by absolute path, from source or compiled', () => {
    expect(selfInvocation('/usr/local/bin/lazy', '/$bunfs/root/lazy')).toEqual(['/usr/local/bin/lazy']);
    expect(selfInvocation('/usr/local/bin/bun', '/src/lazy/src/index.ts')).toEqual(['/usr/local/bin/bun', 'run', '/src/lazy/src/index.ts']);
    expect(shWord("it's")).toBe(`'it'\\''s'`);
  });
});

describe('service-forward grants', () => {
  // INVARIANT: a forward grant names one task and one member and stops working
  // the moment its SSH connection ends.
  test('a grant is found only until it is revoked', () => {
    const token = mintForwardGrant({ taskId: 't1', memberEmail: 'a@example.com' });
    expect(lookupForwardGrant(token)).toEqual({ taskId: 't1', memberEmail: 'a@example.com' });
    expect(lookupForwardGrant(`${token}x`)).toBeNull();
    revokeForwardGrant(token);
    expect(lookupForwardGrant(token)).toBeNull();
  });

  test('service names become host names; bare ports go through `services`', () => {
    expect(serviceHostNames([{ name: 'web', port: 3000 }, { name: '5432', port: 5432 }, { name: 'Api', port: 8080 }]))
      .toEqual(['services', 'web', 'api']);
  });
});

describe('the stable host key', () => {
  // INVARIANT: a task's host key is stable across connections and container
  // recreations — it lives daemon-side, one per (member, task) on a shared
  // daemon — and goes with the task.
  test('is made once per (task, member), reused, and removed with the task', async () => {
    const { makeDaemonBaseDir, pinDaemonBaseDir, removeDaemonBaseDir } = await import('../helpers/daemon-base-dir');
    const { ensureSshHostKey, removeTaskSshHostKeys, sshHostKeysDir } = await import('../../src/ssh/host-keys');
    const base = await makeDaemonBaseDir();
    const unpin = pinDaemonBaseDir(base);
    try {
      const root = '/projects/demo';
      const a1 = await ensureSshHostKey(root, 'task-1', 'ada@example.com');
      const a2 = await ensureSshHostKey(root, 'task-1', 'Ada@Example.com ');
      const b = await ensureSshHostKey(root, 'task-1', 'bob@example.com');
      const solo = await ensureSshHostKey(root, 'task-1', null);
      expect(a2.publicKey).toBe(a1.publicKey);
      expect(b.publicKey).not.toBe(a1.publicKey);
      expect(solo.publicKey).not.toBe(a1.publicKey);
      const [c1, c2] = await Promise.all([ensureSshHostKey(root, 'task-2', null), ensureSshHostKey(root, 'task-2', null)]);
      expect(c1.publicKey).toBe(c2.publicKey);

      await removeTaskSshHostKeys(root, 'task-1');
      const left = (await import('fs')).readdirSync(sshHostKeysDir(root));
      expect(left.filter((n) => n.startsWith('task-1'))).toEqual([]);
      expect(left.filter((n) => n.startsWith('task-2')).length).toBe(2);
      expect((await ensureSshHostKey(root, 'task-1', 'ada@example.com')).publicKey).not.toBe(a1.publicKey);
    } finally {
      unpin();
      await removeDaemonBaseDir(base);
    }
  });
});

describe('the SSH audit read off sshd', () => {
  // The key and forwards read off sshd's log are AUDIT ONLY — reported from
  // inside the person's environment, which they control — so nothing is
  // decided by them; the row keeps the first key report and drops a forward
  // reported before any key.
  test('a second key line is ignored, and a forward before the key is dropped', async () => {
    const { relaySshLog } = await import('../../src/ssh/connection');
    const conn: SshConnectionData = { who: 'a', task: 't' };
    const sent: string[] = [];
    const ws = { send: (m: string) => { sent.push(m); return 1; }, sendBinary: () => 0, close: () => {} } as never;
    const line = (s: string) => Buffer.from(`${s}\n`);
    relaySshLog(ws, conn, line('debug1: server_request_direct_tcpip: originator 127.0.0.1 port 1, target early port 1'));
    relaySshLog(ws, conn, line('Accepted publickey for lazy from UNKNOWN port 65535 ssh2: ED25519 SHA256:real'));
    relaySshLog(ws, conn, line('Accepted publickey for lazy from UNKNOWN port 65535 ssh2: ED25519 SHA256:forged'));
    relaySshLog(ws, conn, line('debug1: server_request_direct_tcpip: originator 127.0.0.1 port 2, target web port 3000'));
    expect(conn.keyFingerprint).toBe('SHA256:real');
    expect(conn.forwards).toEqual(['web:3000']);
    const audits = sent.map((s) => JSON.parse(s));
    expect(audits).toEqual([
      { type: 'ssh-audit', event: 'key', keyType: 'ED25519', fingerprint: 'SHA256:real' },
      { type: 'ssh-audit', event: 'forward', host: 'web', port: 3000 },
    ]);
  });
});


describe('--ssh-config --install: the files it writes', () => {
  // INVARIANT: generating keys and task blocks leaves personal config alone;
  // only the separate, consented Include installation edits ~/.ssh/config.
  test("makes the key once, pins the host key, replaces its own block, and installs the Include separately", async () => {
    const { mkdtemp, readFile, stat, rm, mkdir, writeFile: wf } = await import('fs/promises');
    const local = await import('../../src/ssh/local-files');
    const home = await mkdtemp(join(tmpdir(), 'lzsshhome-'));
    const prev = process.env.HOME;
    process.env.HOME = home;
    try {
      const first = await local.ensureLocalSshKey('me@laptop');
      const again = await local.ensureLocalSshKey('me@laptop');
      expect(first.created).toBe(true);
      expect(again.created).toBe(false);
      expect(again.publicLine).toBe(first.publicLine);
      expect((await stat(join(home, '.lazy', 'ssh', 'id_ed25519'))).mode & 0o777).toBe(0o600);

      const host1 = generateEd25519KeyPair('h1').publicKey;
      const host2 = generateEd25519KeyPair('h2').publicKey;
      await local.pinKnownHost('lazy-a.p', host1);
      await local.pinKnownHost('lazy-b.p', host1);
      await local.pinKnownHost('lazy-a.p', host2);
      const known = (await readFile(join(home, '.lazy', 'ssh', 'known_hosts'), 'utf8')).trim().split('\n');
      expect(known).toHaveLength(2);
      expect(known).toContain(`lazy-a.p ${host2.split(' ').slice(0, 2).join(' ')}`);

      await local.upsertSshConfigBlock('lazy-a.p', 'Host lazy-a.p\n  User lazy\n');
      await local.upsertSshConfigBlock('lazy-b.p', 'Host lazy-b.p\n  User lazy\n');
      await local.upsertSshConfigBlock('lazy-a.p', 'Host lazy-a.p\n  User lazy\n  Port 1\n');
      const config = await readFile(join(home, '.lazy', 'ssh', 'config'), 'utf8');
      expect(config.match(/^Host lazy-a\.p$/gm)).toHaveLength(1);
      expect(config).toContain('  Port 1');
      expect(config).toContain('Host lazy-b.p');

      await expect(stat(join(home, '.ssh', 'config'))).rejects.toThrow();
      expect(await local.sshConfigIncludesLazy()).toBe(false);
      const installed = await local.installSshConfigInclude();
      expect(installed.backup).toBeNull();
      expect((await stat(join(home, '.ssh', 'config'))).mode & 0o777).toBe(0o600);
      expect(await readFile(join(home, '.ssh', 'config'), 'utf8')).toBe(local.LAZY_SSH_CONFIG_INCLUDE + '\n');
      await wf(join(home, '.ssh', 'config'), `${local.LAZY_SSH_CONFIG_INCLUDE}\n`);
      expect(await local.sshConfigIncludesLazy()).toBe(true);
      // INVARIANT: a path in an SSH comment is not an installed Include.
      // Otherwise setup skips consent and leaves the task unreachable by name.
      await wf(join(home, '.ssh', 'config'), 'Include /other/config # ~/.lazy/ssh/config\n');
      expect(await local.sshConfigIncludesLazy()).toBe(false);
      await wf(join(home, '.ssh', 'config'), 'Include "~/.lazy/ssh/config" # configured\n');
      expect(await local.sshConfigIncludesLazy()).toBe(true);
      // INVARIANT: all existing spellings and covering globs are idempotent;
      // lazy never rewrites a person's other Include lines.
      for (const spelling of ['~/.lazy/ssh/config', '${HOME}/.lazy/ssh/config',
        local.lazySshConfigPath(), '~/.lazy/ssh/*', '~/.lazy/*/con?ig']) {
        const existing = `Include "${spelling}"\nInclude ~/.colima/ssh_config\nHost personal\n  User me\n`;
        await wf(join(home, '.ssh', 'config'), existing);
        expect(await local.sshConfigIncludeStatus()).toBe('installed');
        expect((await local.installSshConfigInclude()).changed).toBe(false);
        expect(await readFile(join(home, '.ssh', 'config'), 'utf8')).toBe(existing);
      }
      // INVARIANT: bare $HOME is not an active OpenSSH expansion; only a
      // consented replacement may make it a working global Include.
      const bareHome = 'Include $HOME/.lazy/ssh/config\nInclude ~/.colima/ssh_config\n';
      await wf(join(home, '.ssh', 'config'), bareHome);
      expect(await local.sshConfigIncludeStatus()).toBe('unexpanded');
      await local.installSshConfigInclude();
      expect(await readFile(join(home, '.ssh', 'config'), 'utf8')).toBe(local.LAZY_SSH_CONFIG_INCLUDE + '\nInclude ~/.colima/ssh_config\n');
      expect(await readFile(join(home, '.ssh', 'config.lazy-backup'), 'utf8')).toBe(bareHome);
      const others = 'Include ~/.ssh/config.d/*\nInclude ~/.colima/ssh_config\nInclude ~/.orbstack/ssh/config\nHost personal\n  User me\n';
      await wf(join(home, '.ssh', 'config'), others);
      expect(await local.sshConfigIncludeStatus()).toBe('missing');
      await local.installSshConfigInclude();
      expect(await readFile(join(home, '.ssh', 'config'), 'utf8')).toBe(local.LAZY_SSH_CONFIG_INCLUDE + '\n' + others);
      expect(await readFile(join(home, '.ssh', 'config.lazy-backup'), 'utf8')).toBe(others);
      const prior = 'Host personal\n  Include ~/.lazy/ssh/config\n';
      await wf(join(home, '.ssh', 'config'), prior);
      expect(await local.sshConfigIncludeStatus()).toBe('scoped');
      expect((await local.installSshConfigInclude()).moved).toBe(true);
      expect(await readFile(join(home, '.ssh', 'config'), 'utf8')).toBe(local.LAZY_SSH_CONFIG_INCLUDE + '\nHost personal\n');
      expect(await readFile(join(home, '.ssh', 'config.lazy-backup'), 'utf8')).toBe(prior);
      const shared = 'Host personal\n  Include ~/.colima/ssh_config ~/.lazy/ssh/config # keep this note\n  Include ~/.lazy/ssh/*\n';
      await wf(join(home, '.ssh', 'config'), shared);
      await local.installSshConfigInclude();
      expect(await readFile(join(home, '.ssh', 'config'), 'utf8')).toBe(local.LAZY_SSH_CONFIG_INCLUDE + '\nHost personal\n  Include ~/.colima/ssh_config  # keep this note\n  Include ~/.lazy/ssh/*\n');
      const match = 'Match host personal\n  Include ${HOME}/.lazy/ssh/config\n';
      await wf(join(home, '.ssh', 'config'), match);
      expect(await local.sshConfigIncludeStatus()).toBe('scoped');
      await local.installSshConfigInclude();
      expect(await readFile(join(home, '.ssh', 'config'), 'utf8')).toBe(local.LAZY_SSH_CONFIG_INCLUDE + '\nMatch host personal\n');
      expect(await local.sshConfigIncludesLazy()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.HOME;
      else process.env.HOME = prev;
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('the --stdio pump, refused', () => {
  // INVARIANT: when the attach route refuses the upgrade, the person running
  // `ssh` reads the route's own sentence (on the stderr ssh passes through),
  // not a bare WebSocket failure. A refused upgrade carries no reason to a
  // WebSocket client, so the pump asks the same URL again as a plain GET.
  test("prints the route's JSON error and exits non-zero", async () => {
    const { runSshStdioPump } = await import('../../src/ssh/stdio-pump');
    const seen: Array<string | null> = [];
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req) {
        seen.push(req.headers.get('authorization'));
        return Response.json({ error: 'You have no SSH keys registered.' }, { status: 400 });
      },
    });
    try {
      let err = '';
      const out: Uint8Array[] = [];
      const code = await runSshStdioPump({
        url: `ws://127.0.0.1:${server.port}/rpc/sessions/s/attach/ws?mode=ssh`,
        headers: { Authorization: 'Bearer t' },
        stdin: new ReadableStream({ start(c) { c.close(); } }),
        stdout: { write: (d: Uint8Array) => out.push(d) },
        stderr: { write: (s: string) => { err += s; } },
      });
      expect(code).toBe(1);
      expect(err).toContain('lazy: You have no SSH keys registered.');
      expect(out).toEqual([]);
      // The explanation is asked with the same credentials as the upgrade.
      expect(seen.every((a) => a === 'Bearer t')).toBe(true);
    } finally {
      server.stop(true);
    }
  });
});

// INVARIANT: silent SSH connections have no idle or lifetime deadline. Keeping
// one open does not block the agent, and ending it would kill a member's tunnel.
test('an idle SSH connection survives beyond the former one-hour and one-day limits', () => {
  const now = spyOn(Date, 'now').mockReturnValue(1_000);
  const interval = spyOn(globalThis, 'setInterval');
  const timeout = spyOn(globalThis, 'setTimeout');
  const close = (() => { let n = 0; return { call: () => { n++; }, count: () => n }; })();
  const conn: SshConnectionData = { who: 'alice', task: 'task' };
  const received: string[] = [];
  const ws = { send: () => 1, sendBinary: (b: Uint8Array) => { received.push(Buffer.from(b).toString()); return 1; }, close: close.call } as never;
  try {
    startSshConnection(conn);
    now.mockReturnValue(1_000 + 48 * 60 * 60_000);
    // No watchdog is armed: advancing time cannot silently end this connection.
    expect(interval).not.toHaveBeenCalled();
    expect(timeout).not.toHaveBeenCalled();
    relaySshOutput(ws, Buffer.from('still connected'));
    expect(received).toEqual(['still connected']);
    expect(close.count()).toBe(0);
    logSshConnectionEnd(conn, 'member-container');
  } finally {
    now.mockRestore();
    interval.mockRestore();
    timeout.mockRestore();
  }
});
