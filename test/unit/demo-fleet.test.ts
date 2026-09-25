/**
 * The decisions `lazy playground up --teams --fleet smolvm` makes before it touches
 * anything, as pure functions. Nothing here boots Rails or smolvm — the
 * control flow against the fake supervisor is lazy-teams/test/models/
 * demo_fleet_test.rb, and the real machine is the Mac run.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  DEFAULT_MACHINE_MEMORY_MIB, DEMO_MODE_KEYS, MIN_MACHINE_MEMORY_MIB, fleetHowToBlock, fleetTeamsEnv, formatGuestVitals,
  guestWatchLines, missingCredentialMessage, parseDemoFleetResult, parseGuestVitals, resolveFleetBackend,
  resolveFleetCredential, resolveFleetInputs, resolveMachineMemoryMib, servePortFromToml, type FleetManifest,
} from '../../src/demo/fleet';
import { teamsEnv } from '../../src/demo/teams';

const INPUTS = {
  backend: 'smolvm' as const,
  smolvmBinary: '/Users/me/lazy/lazy-teams/vendor/smolvm/smolvm',
  daemonImage: '/tmp/lazy-daemon.tar',
  repo: 'https://github.com/me/some-public-repo.git',
  servePort: 8080 as number | null,
  memoryMib: null as number | null,
  model: null as string | null,
  credential: { kind: 'oauth_token' as const, value: 'sk-ant-oat01-x', envVar: 'CLAUDE_CODE_OAUTH_TOKEN' },
};

describe('resolveFleetBackend: the flag decides, the shell may not disagree', () => {
  test('no flag and no variable is the ordinary demo', () => {
    expect(resolveFleetBackend(undefined, {})).toBeNull();
  });

  test('--fleet smolvm selects it, with or without an agreeing variable', () => {
    expect(resolveFleetBackend('smolvm', {})).toBe('smolvm');
    expect(resolveFleetBackend('smolvm', { LAZY_FLEET_BACKEND: 'smolvm' })).toBe('smolvm');
  });

  // INVARIANT: the demo never reads LAZY_FLEET_BACKEND as an instruction. A
  // shell that names a backend with no flag is refused, so nobody runs the
  // demo-mode demo believing it hit the fleet — and a shell that names a
  // DIFFERENT backend than the flag is refused, so the demo never guesses.
  test('a variable without the flag, or disagreeing with it, is refused by name', () => {
    expect(() => resolveFleetBackend(undefined, { LAZY_FLEET_BACKEND: 'smolvm' }))
      .toThrow(/LAZY_FLEET_BACKEND=smolvm is set.*--fleet smolvm/s);
    expect(() => resolveFleetBackend('smolvm', { LAZY_FLEET_BACKEND: 'local' }))
      .toThrow(/disagrees with LAZY_FLEET_BACKEND=local/);
    expect(() => resolveFleetBackend('sandbox', {})).toThrow(/not a fleet backend/);
  });
});

describe('resolveFleetCredential: the human\'s own, from the shell, never invented', () => {
  test('prefers the OAuth token, then the API key, and names the variable used', () => {
    expect(resolveFleetCredential({ CLAUDE_CODE_OAUTH_TOKEN: 'a', ANTHROPIC_API_KEY: 'b' }))
      .toEqual({ kind: 'oauth_token', value: 'a', envVar: 'CLAUDE_CODE_OAUTH_TOKEN' });
    expect(resolveFleetCredential({ ANTHROPIC_API_KEY: ' b ' }))
      .toEqual({ kind: 'api_key', value: 'b', envVar: 'ANTHROPIC_API_KEY' });
  });

  test('blank is absent', () => {
    expect(resolveFleetCredential({ CLAUDE_CODE_OAUTH_TOKEN: '  ' })).toBeNull();
    expect(resolveFleetCredential({})).toBeNull();
  });

  test('the refusal names both variables and the /settings/claude page', () => {
    const message = missingCredentialMessage('http://127.0.0.1:3999');
    expect(message).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(message).toContain('ANTHROPIC_API_KEY');
    expect(message).toContain('http://127.0.0.1:3999/settings/claude');
    expect(message).not.toMatch(/lazy-demo-not-a-real/);
  });
});

describe('resolveFleetInputs refuses each missing input by name, before anything runs', () => {
  const env = { LAZY_SMOLVM_BINARY: INPUTS.smolvmBinary, LAZY_DAEMON_IMAGE: INPUTS.daemonImage, CLAUDE_CODE_OAUTH_TOKEN: 'tok' };

  test('all present', () => {
    const inputs = resolveFleetInputs({ backend: 'smolvm', repo: INPUTS.repo, env });
    expect(inputs.smolvmBinary).toBe(INPUTS.smolvmBinary);
    expect(inputs.credential.envVar).toBe('CLAUDE_CODE_OAUTH_TOKEN');
    expect(inputs.servePort).toBeNull();
    expect(resolveFleetInputs({ backend: 'smolvm', repo: INPUTS.repo, servePort: 3000, env }).servePort).toBe(3000);
  });

  test('missing binary, image, repo or credential', () => {
    expect(() => resolveFleetInputs({ backend: 'smolvm', repo: INPUTS.repo, env: { ...env, LAZY_SMOLVM_BINARY: '' } }))
      .toThrow(/LAZY_SMOLVM_BINARY is not set.*vendor-smolvm/s);
    expect(() => resolveFleetInputs({ backend: 'smolvm', repo: INPUTS.repo, env: { ...env, LAZY_DAEMON_IMAGE: undefined } }))
      .toThrow(/LAZY_DAEMON_IMAGE is not set.*publish-lazy-daemon-image/s);
    expect(() => resolveFleetInputs({ backend: 'smolvm', repo: undefined, env }))
      .toThrow(/--repo <public git url> is required/);
    expect(() => resolveFleetInputs({ backend: 'smolvm', repo: 'file:///tmp/x', env }))
      .toThrow(/--repo/);
    expect(() => resolveFleetInputs({ backend: 'smolvm', repo: 'git@github.com:me/x.git', env }))
      .toThrow(/--repo/);
    expect(() => resolveFleetInputs({ backend: 'smolvm', repo: INPUTS.repo, env: { ...env, CLAUDE_CODE_OAUTH_TOKEN: '' } }))
      .toThrow(/YOUR Claude credential/);
  });
});

// The repository's committed lazy.toml decides the seeded task, read with
// lazy's own serve-port rules so the demo cannot disagree with the daemon.
describe('servePortFromToml', () => {
  test('the first declared port, from ports or from services', () => {
    expect(servePortFromToml('[serve]\nports = [8080, 5173]\n')).toBe(8080);
    expect(servePortFromToml('[serve]\n[serve.services]\nweb = 3000\napi = 9292\n')).toBe(3000);
  });

  test('none declared, no [serve], no file content, or unparseable all read as no port', () => {
    expect(servePortFromToml('[serve]\n')).toBeNull();
    expect(servePortFromToml('[models]\ndefault = "x"\n')).toBeNull();
    expect(servePortFromToml('')).toBeNull();
    expect(servePortFromToml('this is = not [toml')).toBeNull();
    expect(servePortFromToml('[serve]\nports = "not a list"\n')).toBeNull();
  });
});

describe('the machine memory budget', () => {
  // INVARIANT: the demo's stated default IS the supervisor's default. The demo
  // prints "4096 MiB (the default)" without asking Rails; if the Ruby constant
  // moves, this fails rather than the demo lying about what a machine got.
  test('the default the demo prints is the one SmolvmSupervisor creates machines with', () => {
    const ruby = readFileSync(join(import.meta.dir, '../../lazy-teams/app/clients/smolvm_supervisor.rb'), 'utf-8');
    expect(ruby).toContain(`DEFAULT_MEMORY_MIB = ${DEFAULT_MACHINE_MEMORY_MIB}`);
    expect(ruby).toContain('ENV["LAZY_SMOLVM_MEMORY_MIB"]');
  });

  test('--memory wins over the shell variable, the variable alone counts, neither means the default', () => {
    expect(resolveMachineMemoryMib('6144', { LAZY_SMOLVM_MEMORY_MIB: '8192' })).toBe(6144);
    expect(resolveMachineMemoryMib(undefined, { LAZY_SMOLVM_MEMORY_MIB: '8192' })).toBe(8192);
    expect(resolveMachineMemoryMib(undefined, {})).toBeNull();
    expect(resolveMachineMemoryMib('', { LAZY_SMOLVM_MEMORY_MIB: '' })).toBeNull();
    expect(resolveFleetInputs({
      backend: 'smolvm', repo: INPUTS.repo, memory: '6144',
      env: { LAZY_SMOLVM_BINARY: INPUTS.smolvmBinary, LAZY_DAEMON_IMAGE: INPUTS.daemonImage, CLAUDE_CODE_OAUTH_TOKEN: 'tok' },
    }).memoryMib).toBe(6144);
  });

  test('a value that is not whole MiB, or too small for one turn, is refused naming its source', () => {
    expect(() => resolveMachineMemoryMib('6g', {})).toThrow(/--memory must be a whole number of MiB/);
    expect(() => resolveMachineMemoryMib(undefined, { LAZY_SMOLVM_MEMORY_MIB: '1024' }))
      .toThrow(new RegExp(`LAZY_SMOLVM_MEMORY_MIB is 1024 MiB, below the ${MIN_MACHINE_MEMORY_MIB} MiB`));
  });

  test('the Teams environment carries the budget only when one was asked for', () => {
    expect(fleetTeamsEnv(INPUTS, '/f')).not.toHaveProperty('LAZY_SMOLVM_MEMORY_MIB');
    expect(fleetTeamsEnv({ ...INPUTS, memoryMib: 6144 }, '/f').LAZY_SMOLVM_MEMORY_MIB).toBe('6144');
  });

  // The guest's own numbers, as `cat /proc/uptime; free -m` prints them in the
  // daemon image (procps `free`), so the budget is judged from a measurement.
  test('the guest vitals are parsed from uptime and free -m, and printed with the budget', () => {
    const out = [
      '843.27 3251.10',
      '               total        used        free      shared  buff/cache   available',
      'Mem:            3941         238        3492           0         251        3703',
      'Swap:              0           0           0',
    ].join('\n');
    const v = parseGuestVitals(out);
    expect(v).toEqual({ uptimeSeconds: 843, memTotalMib: 3941, memUsedMib: 238, memAvailableMib: 3703 });
    expect(formatGuestVitals(v, null)).toBe('up 14m 3s — memory 238 of 3941 MiB used, 3703 available (budget 4096 MiB)');
    expect(formatGuestVitals({ ...v, uptimeSeconds: 7322 }, 6144)).toBe('up 2h 2m — memory 238 of 3941 MiB used, 3703 available (budget 6144 MiB)');
    expect(() => parseGuestVitals('sh: free: not found')).toThrow(/not the output of/);
  });
});

describe('the fleet Teams environment', () => {
  const env = teamsEnv({
    sourceRoot: '/src/lazy', storageDir: '/demo/teams/storage', fleetRoot: '/demo/teams/fleet',
    mode: { kind: 'fleet', inputs: INPUTS, onProgress: async () => {} },
    home: '/Users/me',
  });

  // INVARIANT: a fleet boot is never a demo-mode boot. Demo mode turns managed
  // mode off and runs agents on this host; one of its variables leaking into a
  // fleet boot would make the app select DemoSupervisor and the "fleet" demo
  // would prove nothing while looking green.
  test('carries none of demo mode\'s variables and no fake credential', () => {
    for (const key of DEMO_MODE_KEYS) expect(env).not.toHaveProperty(key);
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
    expect(env).not.toHaveProperty('LAZY_ALLOW_HOST_RUNNER');
  });

  test('selects the real backend with the variables the runbook names, and the fleet root under the demo', () => {
    expect(env.LAZY_FLEET_BACKEND).toBe('smolvm');
    expect(env.LAZY_SMOLVM_BINARY).toBe(INPUTS.smolvmBinary);
    expect(env.LAZY_DAEMON_IMAGE).toBe(INPUTS.daemonImage);
    expect(env.SMOLVM_EGRESS_FLOOR).toBe('strict');
    expect(env.SMOLVM_PUBLISH_ADDR).toBe('127.0.0.1');
    expect(env.LAZY_FLEET_ROOT).toBe('/demo/teams/fleet');
    expect(env.LAZY_TEAMS_STORAGE_DIR).toBe('/demo/teams/storage');
    expect(env.HOME).toBe('/Users/me');
    expect(env.RAILS_ENV).toBe('development');
  });

  // The credential never rides the server's environment: it reaches Rails
  // once, through the `register` runner, and lives in the app's encrypted
  // column afterwards.
  test('the credential value is nowhere in the environment', () => {
    expect(Object.values(env)).not.toContain(INPUTS.credential.value);
    expect(Object.values(fleetTeamsEnv(INPUTS, '/f'))).not.toContain(INPUTS.credential.value);
  });

  test('the demo-mode environment is unchanged by the fleet work', () => {
    const demo = teamsEnv({
      sourceRoot: '/src/lazy', storageDir: '/demo/teams/storage', fleetRoot: '/demo/teams/fleet',
      mode: { kind: 'demo', agentBinDir: '/demo/agent/bin', repoPath: '/demo/repo' },
      home: '/demo/home',
    });
    expect(demo.LAZY_TEAMS_DEMO_MODE).toBe('1');
    expect(demo.LAZY_TEAMS_DEMO_AGENT_BIN).toBe('/demo/agent/bin');
    expect(demo.LAZY_TEAMS_DEMO_FLEET_ROOT).toBe('/demo/teams/fleet');
    expect(demo.ANTHROPIC_API_KEY).toMatch(/not-a-real-credential/);
    expect(demo).not.toHaveProperty('LAZY_FLEET_BACKEND');
  });
});

describe('the runner result line', () => {
  test('the last DEMO_FLEET_RESULT line wins, amid Rails noise', () => {
    const out = 'Loading development environment\nDEMO_FLEET_RESULT {"a":1}\nsome log\nDEMO_FLEET_RESULT {"daemon_url":"http://127.0.0.1:27000"}\n';
    expect(parseDemoFleetResult(out, '', 'provision')).toEqual({ daemon_url: 'http://127.0.0.1:27000' });
  });

  test('an error result throws with the Rails-side message', () => {
    expect(() => parseDemoFleetResult('DEMO_FLEET_RESULT {"error":"DemoFleet::Failure: Inside the machine: DAEMON DOWN"}', '', 'provision'))
      .toThrow(/Inside the machine: DAEMON DOWN/);
  });

  test('no result line throws with the tail of what was printed', () => {
    expect(() => parseDemoFleetResult('boot\n', 'NameError: uninitialized constant DemoFleet', 'status'))
      .toThrow(/printed no result line.*NameError/s);
  });
});

describe('status prints every command with where it runs', () => {
  const manifest: FleetManifest = {
    backend: INPUTS.backend, smolvmBinary: INPUTS.smolvmBinary, daemonImage: INPUTS.daemonImage,
    repo: INPUTS.repo, servePort: 8080, memoryMib: null, model: null, credentialEnvVar: 'CLAUDE_CODE_OAUTH_TOKEN', projectSlug: 'lazy-demo-shop',
    fleetProjectId: 'lazy-demo-shop-1', machine: 'lazy-lazy-demo-shop-1',
    daemonUrl: 'http://127.0.0.1:27000', task: { id: 'abc', code: 'demo-serve' },
  };

  test('the service address, its curl check on the host, and the guest commands via machine exec', () => {
    const lines = fleetHowToBlock(manifest, [{ name: '8080', address: 'http://8080.demo-serve.lazy.localhost:27000' }]);
    const text = lines.join('\n');
    expect(text).toContain('http://8080.demo-serve.lazy.localhost:27000');
    expect(text).toContain('curl -sS -H "Host: 8080.demo-serve.lazy.localhost" "http://127.0.0.1:27000/"   # on the host, any directory');
    expect(text).toContain(`"${INPUTS.smolvmBinary}" machine exec --name lazy-lazy-demo-shop-1 -- lazy-guest-init --print-plan   # inside the guest, from the host`);
    for (const line of lines.filter(l => /curl|machine exec/.test(l))) expect(line).toMatch(/# (on the host|inside the guest)/);
    expect(text).toContain('Origin:     read-only to the guest');
  });

  // INVARIANT: the demo's instructions never say "Mac". The fleet demo also runs
  // on a Linux KVM host, where "on this Mac" sent the reader looking for a
  // machine that is not there.
  test('no instruction the demo prints names a Mac', () => {
    const teams = { url: 'http://127.0.0.1:3999', email: 'you@example.com', password: 'fixture-password' };
    const lines = [
      ...fleetHowToBlock(manifest, [{ name: '8080', address: 'http://8080.demo-serve.lazy.localhost:27000' }], teams),
      ...guestWatchLines(manifest),
      missingCredentialMessage(),
    ];
    for (const line of lines) expect(line).not.toMatch(/\bMac\b/);
    const cli = readFileSync(join(import.meta.dir, '..', '..', 'src', 'cli', 'commands', 'demo.ts'), 'utf8');
    const printed = cli.split('\n').filter(l => /console\.log/.test(l));
    for (const line of printed) expect(line).not.toMatch(/\bMac\b/);
  });

  // The engineer ran `status` after a failed provisioning and it printed the
  // machine commands but not where Teams is — because there was no server to
  // point at. Both cases are said now: the URL and sign-in when it started, and
  // that it never started when it did not.
  test('status leads with the Teams URL and sign-in, or says the server never started', () => {
    const up = fleetHowToBlock(manifest, [], { url: 'http://127.0.0.1:3999', email: 'you@example.com', password: 'fixture-password' });
    expect(up[0]).toBe('Teams:      http://127.0.0.1:3999   (open in the browser on this host; sign in as you@example.com / fixture-password)');
    const notUp = fleetHowToBlock(manifest, [], null);
    expect(notUp[0]).toContain('Teams:      not started');
    expect(notUp[0]).toContain('you@example.com / fixture-password');
  });

  // Teams has no Watch; the daemon in the guest has one. Every line runs inside
  // the guest through machine exec, sources the daemon's environment file and
  // starts in the clone — the supervisor's own shape for a guest command.
  test('status prints how to watch the task from inside the guest, and two non-streaming fallbacks', () => {
    const lines = guestWatchLines(manifest);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain(`"${INPUTS.smolvmBinary}" machine exec --name lazy-lazy-demo-shop-1 -- sh -c 'cd /lazy/projects/lazy-demo-shop-1/repo; . /lazy/projects/lazy-demo-shop-1/daemon/env.*.sh; exec lazy watch demo-serve'`);
    expect(lines[1]).toContain('exec lazy show demo-serve');
    expect(lines[2]).toContain('exec lazy daemon logs --no-follow -n 200');
    for (const line of lines) expect(line).toContain('# inside the guest, from the host');
    expect(fleetHowToBlock(manifest, [], null).join('\n')).toContain('exec lazy watch demo-serve');
    expect(guestWatchLines({ ...manifest, task: null })).toEqual([]);
  });

  test('a repository that serves nothing says so instead of printing an address', () => {
    const text = fleetHowToBlock({ ...manifest, servePort: null, task: { id: 'abc', code: 'demo-describe' } }, []).join('\n');
    expect(text).toContain('declares no [serve] port, so there is no address to show');
    expect(text).not.toContain('curl');
    expect(text).toContain('machine exec');
  });
});
