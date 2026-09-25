/**
 * Credential redaction at the two seams `fix-codeql-alerts` did NOT cover: the
 * supervisor's own logger, and the proxy audit log.
 *
 * Same bug class as the original leak — lazy writes text a human pastes into a
 * bug report, and a credential is in it — reached by two routes that never go
 * through src/utils/logger.ts:
 *
 *  - src/supervisor/log.ts is a SECOND logger. Every supervisor module uses it,
 *    it writes straight to a file in builder mode, and Logger.scrub() has no
 *    reach into it at all.
 *  - .lazy/logs/proxy-audit.jsonl records the agent's own tool calls verbatim,
 *    including Bash command strings and tool_result content, and `lazy audit`
 *    prints them to a terminal.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { log, logError, logWarn, setLogFile } from '../../src/supervisor/log';
import { ProxyAuditLog, redactAuditRecordContent } from '../../src/proxy/audit-log';
import { REDACTED } from '../../src/utils/redact';
import type { ProxyAuditRecord } from '../../src/storage/types';

const TOKEN = 'sk-ant-oat01-notarealtokenbutlongenoughtolooklikeone';

/** Delete any env key a test added, so credentials never leak between tests. */
function makeEnvGuard() {
  const before = new Set(Object.keys(process.env));
  return () => {
    for (const key of Object.keys(process.env)) {
      if (!before.has(key)) delete process.env[key];
    }
  };
}

describe('supervisor log file redaction', () => {
  let dir: string;
  let logFile: string;
  let restoreEnv: () => void;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lazy-supervisor-log-'));
    logFile = join(dir, 'supervisor.log');
    restoreEnv = makeEnvGuard();
    setLogFile(logFile);
  });

  afterEach(async () => {
    // Put the module-global target back BEFORE the directory goes away —
    // otherwise a later suite's supervisor log write appends into a deleted dir.
    setLogFile(null);
    restoreEnv();
    await rm(dir, { recursive: true, force: true });
  });

  test('INVARIANT: the supervisor log file never contains a credential VALUE', async () => {
    // The real path: builder.ts logs `[builder] Claude args: ${args.join(' ')}`
    // under `[session] debug`. That is the same argv the debug echo prints — the
    // leak fix-codeql-alerts closed — arriving at a logger that fix never
    // touched, and written to a file the user is asked to attach to a bug
    // report. If this fails, the builder log is leaking the live token.
    process.env.CLAUDE_CODE_OAUTH_TOKEN = TOKEN;
    log(`[builder] Claude args: claude --append-system-prompt x -e CLAUDE_CODE_OAUTH_TOKEN=${TOKEN}`);

    const written = await readFile(logFile, 'utf-8');
    expect(written).not.toContain(TOKEN);
    expect(written).toContain(REDACTED);
    // Still useful: the surrounding line survives intact.
    expect(written).toContain('[builder] Claude args:');
  });

  test('scrubs every level, so no call site has to remember', async () => {
    // The stderr tails in maintain.ts, merge.ts and pushback.ts all use
    // logError, not log. A scrub on one function would miss them.
    process.env.ANTHROPIC_API_KEY = TOKEN;
    log(`info ${TOKEN}`);
    logWarn(`warn ${TOKEN}`);
    logError(`[merge] stderr: fatal: could not read ${TOKEN}`);

    const written = await readFile(logFile, 'utf-8');
    expect(written).not.toContain(TOKEN);
    expect(written.split('\n').filter((l) => l.includes(REDACTED))).toHaveLength(3);
  });

  test('leaves ordinary supervisor lines untouched', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = TOKEN;
    log('[supervisor] Received command: work for task 1a2b3c4d');

    const written = await readFile(logFile, 'utf-8');
    expect(written).toContain('[supervisor] Received command: work for task 1a2b3c4d');
  });

  test('does not corrupt supervisor lines over short dummy credentials', async () => {
    // Ollama sets ANTHROPIC_API_KEY="ollama". Substring-replacing it here would
    // mangle every line that merely mentions the backend.
    process.env.ANTHROPIC_API_KEY = 'ollama';
    log('[supervisor] Using ollama backend at http://localhost:11434');

    const written = await readFile(logFile, 'utf-8');
    expect(written).toContain('Using ollama backend at http://localhost:11434');
    expect(written).not.toContain(REDACTED);
  });
});

function makeRecord(overrides?: Partial<ProxyAuditRecord>): ProxyAuditRecord {
  return {
    id: 'id-1',
    seq: 1,
    ts: 1000000,
    role: 'agent',
    taskId: null,
    backend: 'proxy',
    upstream: 'https://api.anthropic.com',
    method: 'POST',
    path: '/v1/messages',
    endpoint: 'messages',
    model: 'claude-sonnet-4-6',
    tier: 'sonnet',
    stream: true,
    requestShape: null,
    toolUses: [],
    toolResults: [],
    status: 200,
    usage: null,
    stopReason: null,
    error: null,
    durationMs: 42,
    reroute: null,
    ...overrides,
  };
}

function bashUse(command: string) {
  return {
    id: 'toolu_1',
    name: 'Bash',
    path: null,
    command,
    target: null,
    connector: false,
    inputPreview: JSON.stringify({ command }),
  };
}

describe('proxy audit record redaction', () => {
  let restoreEnv: () => void;

  beforeEach(() => {
    restoreEnv = makeEnvGuard();
  });

  afterEach(() => {
    restoreEnv();
  });

  test('INVARIANT: an agent echoing its own env never lands a credential in the audit log', async () => {
    // The real path. `ProxyToolUseAudit.command` is the raw Bash command string
    // as it crossed the wire, and an agent that runs `echo $ANTHROPIC_API_KEY`
    // — or any command that interpolates it — puts the LIVE value there.
    // `lazy audit <id>` then prints it to a terminal. Scrubbing happens at
    // append, so the value never reaches the file at all.
    process.env.ANTHROPIC_API_KEY = TOKEN;
    const dir = await mkdtemp(join(tmpdir(), 'lazy-audit-redact-'));
    try {
      const auditLog = new ProxyAuditLog(dir);
      await auditLog.append(makeRecord({ toolUses: [bashUse(`echo ${TOKEN} > /tmp/x`)] }));

      const raw = await readFile(auditLog.path, 'utf-8');
      expect(raw).not.toContain(TOKEN);
      expect(raw).toContain(REDACTED);

      const [record] = await auditLog.list();
      expect(record.toolUses[0].command).toBe(`echo ${REDACTED} > /tmp/x`);
      // The same content by its other route is scrubbed too.
      expect(record.toolUses[0].inputPreview).not.toContain(TOKEN);
      // Everything an operator reads the record FOR is still there.
      expect(record.toolUses[0].name).toBe('Bash');
      expect(record.model).toBe('claude-sonnet-4-6');
      expect(record.status).toBe(200);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('scrubs tool_result content, where file contents cross', () => {
    // The type's own comment: the spike proved unguessable file contents cross
    // here. An agent reading a credentials file is exactly that case.
    process.env.CLAUDE_CODE_OAUTH_TOKEN = TOKEN;
    const scrubbed = redactAuditRecordContent(
      makeRecord({
        toolResults: [
          {
            toolUseId: 'toolu_1',
            isError: false,
            contentPreview: `CLAUDE_CODE_OAUTH_TOKEN=${TOKEN}\n`,
            contentLen: 80,
          },
        ],
      }),
    );

    expect(scrubbed.toolResults[0].contentPreview).not.toContain(TOKEN);
    expect(scrubbed.toolResults[0].contentPreview).toContain(REDACTED);
    // Structured metadata is untouched — the record stays useful.
    expect(scrubbed.toolResults[0].contentLen).toBe(80);
    expect(scrubbed.toolResults[0].isError).toBe(false);
  });

  test('scrubs error and upstream (insurance — no observed path today)', () => {
    // An upstream fetch error can embed the URL it failed against, and a user
    // can configure a base URL with credentials in it. Neither is an observed
    // leak; both are one substring scan on a field that is already free text.
    process.env.SOME_API_KEY = TOKEN;
    const scrubbed = redactAuditRecordContent(
      makeRecord({
        error: `fetch failed: https://user:${TOKEN}@upstream.example/v1/messages`,
        upstream: `https://user:${TOKEN}@upstream.example`,
      }),
    );

    expect(scrubbed.error).not.toContain(TOKEN);
    expect(scrubbed.upstream).not.toContain(TOKEN);
    expect(scrubbed.error).toContain('fetch failed:');
  });

  test('returns the record untouched when the environment holds no credential', () => {
    // The common case must cost nothing beyond one env scan: no copy, no walk
    // over tool uses. Identity, not just equality.
    const record = makeRecord({ toolUses: [bashUse('ls -la')] });
    expect(redactAuditRecordContent(record)).toBe(record);
  });

  test('does not copy or corrupt a record over short dummy credentials', () => {
    // Ollama's ANTHROPIC_API_KEY="ollama" must not be substring-replaced out of
    // a command that legitimately mentions it.
    process.env.ANTHROPIC_API_KEY = 'ollama';
    const record = makeRecord({ toolUses: [bashUse('curl http://localhost:11434/api/ollama')] });

    const scrubbed = redactAuditRecordContent(record);
    expect(scrubbed).toBe(record);
    expect(scrubbed.toolUses[0].command).toBe('curl http://localhost:11434/api/ollama');
  });

  test('does not mutate the record the caller passed in', () => {
    // The proxy hands the same object to other consumers; scrubbing must
    // produce a copy rather than rewriting what they hold.
    process.env.ANTHROPIC_API_KEY = TOKEN;
    const record = makeRecord({ toolUses: [bashUse(`echo ${TOKEN}`)] });

    const scrubbed = redactAuditRecordContent(record);
    expect(record.toolUses[0].command).toBe(`echo ${TOKEN}`);
    expect(scrubbed).not.toBe(record);
    expect(scrubbed.toolUses[0].command).toBe(`echo ${REDACTED}`);
  });
});
