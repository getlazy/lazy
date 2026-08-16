/**
 * Credential redaction at the two places lazy turns internal state into text a
 * human can read: the `[session] debug` argv echo, and the logger.
 *
 * `[session] debug = true` is a documented troubleshooting toggle
 * (lazy.toml.example) — the setting a user turns on right before pasting output
 * into a bug report. Container launch argv carries auth as `-e KEY=VALUE`, so a
 * raw `args.join(' ')` printed the live token in clear text.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { buildDockerArgs } from '../../src/capture/claude';
import { targetEnvVars, ANTHROPIC_DEFAULT_TARGET } from '../../src/utils/role-target';
import {
  redactSecrets,
  redactSecretValues,
  isCredentialEnvKey,
  REDACTED,
} from '../../src/utils/redact';

const TOKEN = 'sk-ant-oat01-notarealtokenbutlongenoughtolooklikeone';

describe('redactSecrets', () => {
  test('INVARIANT: a debug argv echo never contains the credential VALUE', () => {
    // This is the whole point of the helper. Every debug argv print in
    // src/capture/claude.ts, src/runner/docker-runner.ts and
    // src/runner/host-process-runner.ts routes through redactSecrets() so that
    // no call site can reintroduce the leak. If this test fails, `[session]
    // debug = true` is printing a live token to the terminal.
    const argv = buildDockerArgs(
      { worktreePath: '/wt', sandboxPath: '/sb' } as any,
      ['claude', '-p', 'hello'],
      '/bin/lazy-agent',
      'lazy-agent:latest',
      'docker',
      '/repo',
      [
        { key: 'CLAUDE_CODE_OAUTH_TOKEN', value: TOKEN },
        { key: 'ANTHROPIC_BASE_URL', value: 'http://host.docker.internal:8317' },
      ],
      [],
    );

    // Precondition: the argv actually spawned must still carry the real value.
    expect(argv.join(' ')).toContain(TOKEN);

    const printed = redactSecrets(argv).join(' ');
    expect(printed).not.toContain(TOKEN);
    expect(printed).toContain(`CLAUDE_CODE_OAUTH_TOKEN=${REDACTED}`);
  });

  test('keeps the debug line useful — keys, mounts, image and argv survive', () => {
    // Redacting the whole line would close the alert and destroy the feature.
    // An operator still has to be able to read the invocation back.
    const printed = redactSecrets([
      'docker', 'run', '--rm',
      '-v', '/repo:/repo:ro',
      '-e', `ANTHROPIC_API_KEY=${TOKEN}`,
      '-e', 'ANTHROPIC_BASE_URL=http://localhost:8317',
      '-e', 'ANTHROPIC_CUSTOM_HEADERS=x-lazy-role: agent',
      '-e', 'DISABLE_TELEMETRY=1',
      'lazy-agent:latest', 'claude', '-p', 'do the thing',
    ]).join(' ');

    expect(printed).toContain('-v /repo:/repo:ro');
    expect(printed).toContain('lazy-agent:latest');
    expect(printed).toContain('claude -p do the thing');
    expect(printed).toContain('ANTHROPIC_BASE_URL=http://localhost:8317');
    expect(printed).toContain('ANTHROPIC_CUSTOM_HEADERS=x-lazy-role: agent');
    expect(printed).toContain('DISABLE_TELEMETRY=1');
    expect(printed).toContain(`ANTHROPIC_API_KEY=${REDACTED}`);
  });

  test('redacts every credential key targetEnvVars can emit, including ollama dummies', () => {
    // Ollama deliberately sets ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN to the
    // literal "ollama" (src/utils/role-target.ts). Redaction is key-driven, so
    // those are redacted too — correct, and not special-cased.
    const vars = targetEnvVars(
      { backend: 'ollama', endpoint: 'http://localhost:11434', model: 'x' } as any,
      [],
      'container',
    );
    const argv = vars.flatMap(v => ['-e', `${v.key}=${v.value}`]);
    const printed = redactSecrets(argv).join(' ');

    expect(printed).toContain(`ANTHROPIC_API_KEY=${REDACTED}`);
    expect(printed).toContain(`ANTHROPIC_AUTH_TOKEN=${REDACTED}`);
    // The base URL is where traffic goes — informational, must stay readable.
    expect(printed).toContain('ANTHROPIC_BASE_URL=http://localhost:11434');
  });

  test('is position-independent, so a differently framed call site is covered too', () => {
    expect(redactSecrets([`--env`, `GITHUB_TOKEN=${TOKEN}`])[1])
      .toBe(`GITHUB_TOKEN=${REDACTED}`);
    expect(redactSecrets([`CURSOR_API_KEY=${TOKEN}`, 'claude'])[0])
      .toBe(`CURSOR_API_KEY=${REDACTED}`);
  });

  test('does not mutate the input argv', () => {
    const argv = ['-e', `ANTHROPIC_API_KEY=${TOKEN}`];
    redactSecrets(argv);
    expect(argv[1]).toBe(`ANTHROPIC_API_KEY=${TOKEN}`);
  });

  test('classifies keys by name shape, not by value', () => {
    for (const key of [
      'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
      'CURSOR_API_KEY', 'GITHUB_TOKEN', 'GITLAB_TOKEN', 'DB_PASSWORD', 'FOO_SECRET',
    ]) {
      expect(isCredentialEnvKey(key)).toBe(true);
    }
    for (const key of [
      'ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS', 'DISABLE_TELEMETRY',
      'GIT_SSH_COMMAND', 'HOME', 'LAZY_DAEMON_CONFIG', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
    ]) {
      expect(isCredentialEnvKey(key)).toBe(false);
    }
  });

  test('anthropic target with a real credential still yields a redacted echo', () => {
    const vars = targetEnvVars(
      ANTHROPIC_DEFAULT_TARGET,
      [{ key: 'CLAUDE_CODE_OAUTH_TOKEN', value: TOKEN }],
      'container',
    );
    const printed = redactSecrets(vars.flatMap(v => ['-e', `${v.key}=${v.value}`])).join(' ');
    expect(printed).not.toContain(TOKEN);
  });
});

describe('redactSecretValues (logger boundary)', () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of Object.keys(process.env)) {
      if (!(k in saved)) delete process.env[k];
    }
  });

  test('scrubs a live credential value out of free text, whatever assembled it', () => {
    // CodeQL alert #26 puts a clear-text-logging sink at Logger.warn with the
    // credential env reads as the source. No such call site exists today (see
    // docs/codeql-dismissals.md), so this is the durable answer: the value
    // cannot reach console or log file by ANY route.
    process.env.CLAUDE_CODE_OAUTH_TOKEN = TOKEN;
    const scrubbed = redactSecretValues(`spawn failed with env CLAUDE_CODE_OAUTH_TOKEN=${TOKEN} oops`);
    expect(scrubbed).not.toContain(TOKEN);
    expect(scrubbed).toContain(REDACTED);
    expect(scrubbed).toContain('spawn failed with env');
  });

  test('leaves ordinary log lines untouched', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = TOKEN;
    const msg = 'Task 1a2b3c4d: recovering to blocked (2 unrecorded commits)';
    expect(redactSecretValues(msg)).toBe(msg);
  });

  test('does not corrupt logs over short dummy credentials', () => {
    // Ollama sets ANTHROPIC_API_KEY="ollama"; substring-replacing that across
    // every log line would mangle unrelated messages and protect nothing.
    process.env.ANTHROPIC_API_KEY = 'ollama';
    const msg = 'Using ollama backend at http://localhost:11434';
    expect(redactSecretValues(msg)).toBe(msg);
  });

  test('picks up a credential key added to the environment after first use', () => {
    redactSecretValues('warm up');
    process.env.SOME_NEW_API_KEY = TOKEN;
    expect(redactSecretValues(`leaked ${TOKEN}`)).not.toContain(TOKEN);
  });

  test('INVARIANT: the key scan is never cached behind an approximate signal', () => {
    // A credential added while an unrelated var is deleted leaves the env key
    // COUNT unchanged. Any cache keyed on that count would never rescan, and
    // this credential would go unscrubbed on every subsequent log line — a
    // silent hole in the last line of defence. The scan reads process.env fresh
    // on every call precisely so this case cannot arise; if someone reintroduces
    // a cache, it must be invalidated soundly and this test must still pass.
    process.env.SOME_DECOY_VAR = 'x';
    redactSecretValues('warm up');

    delete process.env.SOME_DECOY_VAR;
    process.env.SOME_LATE_API_KEY = TOKEN;

    const scrubbed = redactSecretValues(`leaked ${TOKEN}`);
    expect(scrubbed).not.toContain(TOKEN);
    expect(scrubbed).toBe(`leaked ${REDACTED}`);
  });

  test('stops scrubbing a credential once it leaves the environment', () => {
    // The mirror of the above: an unset credential must not linger in a stale
    // cache and keep mangling text that merely resembles it.
    process.env.SOME_GONE_API_KEY = TOKEN;
    redactSecretValues('warm up');

    delete process.env.SOME_GONE_API_KEY;
    expect(redactSecretValues(`plain ${TOKEN}`)).toBe(`plain ${TOKEN}`);
  });
});
