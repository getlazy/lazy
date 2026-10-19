/**
 * The value-redaction registry (src/utils/redact.ts) and the secret-file rule
 * (src/utils/secret-file-strings.ts), and the sinks a registered value must
 * never reach: the supervisor log, the proxy audit log, the store (turns,
 * comments, journal, raised items) and `show`.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  isScrubbableSecretValue,
  MAX_REGISTERED_VALUES_PER_SOURCE,
  MAX_WHOLE_VALUE_LENGTH,
  REDACTED,
  redactSecretValues,
  redactSecretValuesDeep,
  scrubVariantsOf,
  setRegisteredSecretValues,
  registeredSecretSources,
} from '../../src/utils/redact';
import { clearTaskEnv, MAX_VARS_PER_TASK, setTaskEnv } from '../../src/daemon/task-env';
import { isDotenvPath, parseDotenvValues, secretStringsForFile } from '../../src/utils/secret-file-strings';
import { log, setLogFile } from '../../src/supervisor/log';
import { redactAuditRecordContent } from '../../src/proxy/audit-log';
import { FileStorage } from '../../src/storage/file-storage';
import type { ProxyAuditRecord } from '../../src/storage/types';

const SOURCE = 'test-registry';
const SECRET = 'pk_live_9fK2xQ7mZr4Lw8Vt';
const PEM = [
  '-----BEGIN PRIVATE KEY-----',
  'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC',
  'BKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj',
  '-----END PRIVATE KEY-----',
].join('\n');

afterEach(() => setRegisteredSecretValues(SOURCE, []));

describe('registry rules', () => {
  // INVARIANT: trivial values are never substring-replaced across free text.
  // A registered `true`, `1` or `production` would otherwise corrupt every
  // log line, turn and comment that happens to contain the word.
  test('trivial values are held but never applied', () => {
    setRegisteredSecretValues(SOURCE, ['1', 'true', 'production', '============', '000000000000']);
    const text = 'true 1 production ============ 000000000000';
    expect(redactSecretValues(text)).toBe(text);
    expect(isScrubbableSecretValue(SECRET)).toBe(true);
  });

  test('a registered value is scrubbed until the source drops it', () => {
    setRegisteredSecretValues(SOURCE, [SECRET]);
    expect(redactSecretValues(`key=${SECRET};`)).toBe(`key=${REDACTED};`);
    setRegisteredSecretValues(SOURCE, []);
    expect(redactSecretValues(`key=${SECRET};`)).toBe(`key=${SECRET};`);
  });

  // INVARIANT: the longest secret is replaced first, so a secret contained in
  // another (a password inside a URL) never leaves the rest of the longer one.
  test('longest first', () => {
    const url = `postgres://app:${SECRET}@db.internal:5432/app`;
    setRegisteredSecretValues(SOURCE, [SECRET, url]);
    expect(redactSecretValues(`connecting to ${url}`)).toBe(`connecting to ${REDACTED}`);
  });

  test('multi-line values are matched whole, line by line, and JSON-escaped; PEM armour is not', () => {
    setRegisteredSecretValues(SOURCE, [PEM]);
    expect(redactSecretValues(`k: ${PEM}`)).toBe(`k: ${REDACTED}`);
    const line = 'BKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj';
    expect(redactSecretValues(`stderr: ${line}`)).toBe(`stderr: ${REDACTED}`);
    expect(redactSecretValues(JSON.stringify({ key: PEM }))).not.toContain('MIIEvQIBADANBgkqhkiG9w0BAQEFAASC');
    expect(redactSecretValues('-----BEGIN PRIVATE KEY-----')).toBe('-----BEGIN PRIVATE KEY-----');
  });

  test('base64 and URL-encoded spellings are scrubbed', () => {
    const pw = 'p@ss/w0rd+with&chars';
    setRegisteredSecretValues(SOURCE, [pw]);
    const b64 = Buffer.from(pw).toString('base64');
    expect(redactSecretValues(`Authorization: Basic ${b64}`)).toBe(`Authorization: Basic ${REDACTED}`);
    expect(redactSecretValues(`?pw=${encodeURIComponent(pw)}&x=1`)).toBe(`?pw=${REDACTED}&x=1`);
    expect(redactSecretValues(Buffer.from(pw).toString('base64url'))).toBe(REDACTED);
  });

  // INVARIANT: the registry is bounded by construction — a huge value is
  // matched by its lines, never as a whole, and a source over the cap is
  // refused loudly rather than silently truncated (truncation would leak).
  test('bounded', () => {
    const big = Array.from({ length: 2000 }, (_, i) => `line-${i}-abcdefghijklmnop`).join('\n');
    expect(big.length).toBeGreaterThan(MAX_WHOLE_VALUE_LENGTH);
    const variants = scrubVariantsOf(big);
    expect(variants).not.toContain(big);
    expect(variants).toContain('line-1999-abcdefghijklmnop');

    const many = Array.from({ length: MAX_REGISTERED_VALUES_PER_SOURCE + 1 }, (_, i) => `value-${i}-abcdefghijkl`);
    expect(() => setRegisteredSecretValues(SOURCE, many)).toThrow(/limit/);
  });

  test('redactSecretValuesDeep scrubs every string and keeps keys', () => {
    setRegisteredSecretValues(SOURCE, [SECRET]);
    const out = redactSecretValuesDeep({ a: [`x ${SECRET}`, 3, null], b: { [SECRET.slice(0, 3)]: SECRET } });
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(out.a[1]).toBe(3);
  });
});

describe('secretStringsForFile', () => {
  test('dotenv: parsed values only — export, quotes, comments, multi-line', () => {
    const env = [
      '# comment with sk_long_value_in_comment',
      'export STRIPE_KEY=sk_test_51Habcdefghijkl # inline',
      'DB_PASS="quoted value with spaces 123"',
      "SINGLE='literal\\nvalue-abcdefg'",
      'MULTI="line one abcdef',
      'line two ghijkl"',
      'DEBUG=true',
      'PORT=3000',
    ].join('\n');
    expect(isDotenvPath('/w/.env')).toBe(true);
    expect(isDotenvPath('/w/.env.local')).toBe(true);
    expect(isDotenvPath('/w/prod.env')).toBe(true);
    expect(isDotenvPath('/w/key.pem')).toBe(false);
    expect(parseDotenvValues(env)).toEqual([
      'sk_test_51Habcdefghijkl',
      'quoted value with spaces 123',
      'literal\\nvalue-abcdefg',
      'line one abcdef\nline two ghijkl',
      'true',
      '3000',
    ]);
    const strings = secretStringsForFile('/w/.env', env);
    expect(strings).toContain('sk_test_51Habcdefghijkl');
    expect(strings).not.toContain('true');
    expect(strings).not.toContain('3000');
    expect(strings.join('\n')).not.toContain('STRIPE_KEY');
    expect(strings.join('\n')).not.toContain('sk_long_value_in_comment');
  });

  test('other files: whole content plus each non-trivial line, minus PEM armour', () => {
    const strings = secretStringsForFile('/w/key.pem', PEM);
    expect(strings).toContain(PEM);
    expect(strings).toContain('MIIEvQIBADANBgkqhkiG9w0BAQEFAASC');
    expect(strings).not.toContain('-----BEGIN PRIVATE KEY-----');
  });
});

describe('sinks', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lazy-secret-sinks-'));
    setRegisteredSecretValues(SOURCE, [SECRET, ...secretStringsForFile('key.pem', PEM)]);
  });
  afterEach(async () => {
    setLogFile(null);
    await rm(dir, { recursive: true, force: true });
  });

  // INVARIANT: a registered secret never reaches a log line.
  test('log line', async () => {
    const file = join(dir, 'supervisor.log');
    setLogFile(file);
    log(`[agent] ran curl -H "Authorization: Bearer ${SECRET}"`);
    log('[agent] MIIEvQIBADANBgkqhkiG9w0BAQEFAASC');
    const written = await readFile(file, 'utf-8');
    expect(written).not.toContain(SECRET);
    expect(written).not.toContain('MIIEvQIBADANBgkqhkiG9w0BAQEFAASC');
  });

  test('proxy audit log', () => {
    const record = {
      id: 'i', seq: 1, ts: 1, role: 'agent', error: null, upstream: 'https://api.anthropic.com',
      toolUses: [{ name: 'Bash', command: `echo ${SECRET}`, inputPreview: `{"command":"echo ${SECRET}"}` }],
      toolResults: [{ contentPreview: SECRET }],
    } as unknown as ProxyAuditRecord;
    expect(JSON.stringify(redactAuditRecordContent(record))).not.toContain(SECRET);
  });

  // INVARIANT: no registered secret is ever WRITTEN to the store: a turn
  // (content, recorded prompt, check output), a comment, a journal entry.
  // The store is durable, pushed and human-visible; a leak there is forever.
  test('turn, comment, journal and raised item are scrubbed on write', async () => {
    const base = join(dir, 'store');
    await writeFile(join(dir, 'lazy.toml'), `[storage]\nbackend = "external"\nexternal_path = "${base}"\n`);
    const storage = new FileStorage(dir, { basePath: base });
    await storage.initialize();
    try {
      const task = await storage.createTask('t');
      const session = await storage.createSession(task.id, 'claude-code', 'lazy/t', 'abc');
      await storage.createTurn({
        sessionId: session.id, sequence: 1, role: 'agent',
        content: `I printed ${SECRET}`, prompt: `use ${SECRET}`, checkOutput: `out ${SECRET}`,
      });
      await storage.createComment(task.id, `the key is ${SECRET}`);
      await storage.appendJournalEntry(task.id, `noted ${SECRET}`);
      await storage.createRaisedItem(task.id, { blocking: false, content: `raised ${SECRET}`, session_id: null });

      const turns = await storage.getSessionTurns(session.id);
      const comments = await storage.getTaskComments(task.id);
      const journal = await storage.getTaskJournal(task.id);
      const raised = await storage.getTaskRaisedItems(task.id);
      expect(raised).toHaveLength(1);
      const all = JSON.stringify({ turns, comments, journal, raised });
      expect(all).not.toContain(SECRET);
      expect(turns[0].content).toBe(`I printed ${REDACTED}`);
    } finally {
      await storage.close();
    }
  });
});

describe('review-pass edge cases', () => {
  afterEach(() => {
    for (const s of registeredSecretSources()) setRegisteredSecretValues(s, []);
  });

  // INVARIANT: a single-line value is matched whole however long it is: it has
  // no lines to fall back on, so the size bound must never drop it.
  test('a single-line value over the whole-value bound is still scrubbed', () => {
    const long = 'Zk9' + 'abcdefghij0123456789'.repeat(Math.ceil(MAX_WHOLE_VALUE_LENGTH / 20) + 1);
    expect(long.length).toBeGreaterThan(MAX_WHOLE_VALUE_LENGTH);
    setRegisteredSecretValues(SOURCE, [long]);
    expect(redactSecretValues(`x ${long} y`)).toBe(`x ${REDACTED} y`);
  });

  // INVARIANT: registering never throws on an unencodable value — a throw here
  // would surface from the logger on every line.
  test('a lone surrogate does not break registration or scrubbing', () => {
    const odd = 'abcdefghijkl\uD800mnop';
    expect(() => setRegisteredSecretValues(SOURCE, [odd])).not.toThrow();
    expect(redactSecretValues(`v=${odd}`)).toBe(`v=${REDACTED}`);
  });

  test('an escaped double quote does not end a dotenv value', () => {
    expect(parseDotenvValues('PASS="abc\\"defghijklmnop"')).toEqual(['abc"defghijklmnop']);
  });

  // INVARIANT: trivial values do not count towards the per-source cap.
  test('trivial values are not counted against the cap', () => {
    const many = Array.from({ length: MAX_REGISTERED_VALUES_PER_SOURCE + 10 }, (_, i) => String(i % 2 ? 'true' : i));
    expect(() => setRegisteredSecretValues(SOURCE, many)).not.toThrow();
  });

  // INVARIANT: the per-source cap can never be reached by a project with many
  // tasks: task-env registers ONE source per task, each bounded by the task's
  // own caps, so more than the cap's worth of values across tasks still reads,
  // writes and scrubs. One shared source made every launch throw past it.
  test('task-env past the cap across tasks still works', async () => {
    const base = await mkdtemp(join(tmpdir(), 'lazy-taskenv-cap-'));
    const prev = process.env.LAZY_DAEMON_BASE_DIR;
    process.env.LAZY_DAEMON_BASE_DIR = join(base, 'daemon');
    try {
      const root = join(base, 'project');
      const tasks = Math.ceil(MAX_REGISTERED_VALUES_PER_SOURCE / MAX_VARS_PER_TASK) + 1;
      for (let t = 0; t < tasks; t++) {
        const vars: Record<string, string> = {};
        for (let k = 0; k < MAX_VARS_PER_TASK; k++) vars[`V${k}`] = `secret-${t}-${k}-qwertyuiop`;
        await setTaskEnv(root, `task-${t}`, vars);
      }
      expect(redactSecretValues(`secret-0-0-qwertyuiop`)).toBe(REDACTED);
      expect(redactSecretValues(`secret-${tasks - 1}-63-qwertyuiop`)).toBe(REDACTED);
      await clearTaskEnv(root, 'task-0');
      expect(redactSecretValues(`secret-0-0-qwertyuiop`)).toBe('secret-0-0-qwertyuiop');
    } finally {
      if (prev === undefined) delete process.env.LAZY_DAEMON_BASE_DIR;
      else process.env.LAZY_DAEMON_BASE_DIR = prev;
      await rm(base, { recursive: true, force: true });
    }
  });
});
