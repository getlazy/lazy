import { describe, test, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError, expectOutputExcludes } from '../helpers/assertions';
import { join } from 'path';
import { mkdir, writeFile } from 'fs/promises';
import { getProjectName } from '../../src/storage';
import { getHome } from '../../src/utils/home';

/**
 * Create a fake stored conversation in the location storage actually reads
 * from: the external ~/.lazy/<project>/conversations dir. Writing into the
 * repo's own .lazy/conversations/ no longer works — storage externalized its
 * data dir, so a write there is invisible to listConversations().
 *
 * We write the JSON file directly rather than via FileStorage.saveConversation
 * for two reasons: (1) saveConversation is itself just an mkdir + writeFile with
 * no lock or index to keep in sync, so a direct write is behaviorally identical;
 * (2) opening a FileStorage would call initialize(), which acquires the storage
 * lock — and in withDaemon suites the daemon already holds it, so that would
 * deadlock. This mirrors what builder auto-capture (and import-conversation)
 * produce.
 */
async function createFakeConversation(
  root: string,
  sessionId: string,
  options: {
    summary?: string;
    messages?: Array<{ role: string; text: string }>;
    gitBranch?: string;
  } = {}
): Promise<void> {
  const conversation = {
    sessionId,
    projectPath: '-test-project',
    cwd: root,
    version: '1.0.0',
    gitBranch: options.gitBranch ?? 'main',
    startedAt: '2026-02-19T10:00:00Z',
    endedAt: '2026-02-19T10:30:00Z',
    importedAt: Date.now(),
    summary: options.summary ?? 'Test conversation',
    stats: {
      messageCount: (options.messages ?? []).length,
      userMessageCount: (options.messages ?? []).filter(m => m.role === 'user').length,
      assistantMessageCount: (options.messages ?? []).filter(m => m.role === 'assistant').length,
      subagentCount: 0,
      totalTokens: 1000,
    },
    totalUsage: {
      inputTokens: 500,
      outputTokens: 500,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
    messages: (options.messages ?? []).map((msg, i) => ({
      uuid: `msg-${i}`,
      parentUuid: i > 0 ? `msg-${i - 1}` : null,
      timestamp: '2026-02-19T10:00:00Z',
      role: msg.role,
      text: msg.text,
      model: msg.role === 'assistant' ? 'claude-opus-4-6' : null,
      usage: null,
    })),
    subagents: [],
  };

  // Resolve the external storage path explicitly rather than reading a config
  // file. In-process (bun test), config/root resolution keys off the test
  // runner's CWD — the dev worktree — so it would otherwise pick up the
  // worktree's real [storage] external_path instead of this temp project's. The
  // subprocesses under test run with CWD=root and resolve to
  // getHome()/.lazy/<projectName>; mirror that exactly here.
  const convDir = join(getHome(), '.lazy', await getProjectName(root), 'conversations');
  await mkdir(convDir, { recursive: true });
  await writeFile(
    join(convDir, `${sessionId}.json`),
    JSON.stringify(conversation, null, 2),
    'utf-8',
  );
}

describe('lazy search with conversations', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('finds text in conversation messages', async () => {
    await createFakeConversation(ctx.root, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', {
      summary: 'Discussing authentication architecture',
      messages: [
        { role: 'user', text: 'We need to implement OAuth2 with PKCE flow' },
        { role: 'assistant', text: 'I recommend using the authorization code flow with PKCE' },
      ],
    });

    const result = await ctx.lazy(['search', 'OAuth2']);

    expectSuccess(result);
    expectOutput(result, 'OAuth2');
  });

  test('finds text in conversation summary', async () => {
    await createFakeConversation(ctx.root, 'aaaaaaaa-bbbb-cccc-dddd-ffffffffffff', {
      summary: 'Reviewing the microservices deployment strategy',
      messages: [
        { role: 'user', text: 'What deployment strategy should we use?' },
      ],
    });

    const result = await ctx.lazy(['search', 'microservices']);

    expectSuccess(result);
    expectOutput(result, 'microservices');
  });

  test('--conversations flag filters to conversations only', async () => {
    // Create both a task and a conversation with matching text
    await ctx.lazy(['create', '--goal', 'Fix the caching bug in production']);

    await createFakeConversation(ctx.root, 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff', {
      summary: 'Investigating the caching bug',
      messages: [
        { role: 'user', text: 'The caching layer has a bug in production' },
      ],
    });

    // Search with --conversations should only find conversation results
    const convResult = await ctx.lazy(['search', 'caching', '--conversations']);
    expectSuccess(convResult);
    expectOutput(convResult, 'caching');

    // Verify the task search finds the task too
    const taskResult = await ctx.lazy(['search', 'caching', '--tasks']);
    expectSuccess(taskResult);
    expectOutput(taskResult, 'caching');
  });

  test('conversations appear in default search (no type filter)', async () => {
    await createFakeConversation(ctx.root, 'cccccccc-dddd-eeee-ffff-aaaaaaaaaaaa', {
      summary: 'Database migration planning',
      messages: [
        { role: 'user', text: 'We need to migrate from PostgreSQL 14 to 16' },
      ],
    });

    const result = await ctx.lazy(['search', 'PostgreSQL']);

    expectSuccess(result);
    expectOutput(result, 'PostgreSQL');
  });
});

describe('lazy import-conversation --show', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('shows full interleaved conversation transcript', async () => {
    await createFakeConversation(ctx.root, 'dddddddd-eeee-ffff-aaaa-bbbbbbbbbbbb', {
      summary: 'Discussing API design for user endpoints',
      messages: [
        { role: 'user', text: 'How should we structure the user API?' },
        { role: 'assistant', text: 'I recommend RESTful endpoints with versioning.' },
        { role: 'user', text: 'Should we use GraphQL instead?' },
        { role: 'assistant', text: 'REST is simpler for this use case.' },
      ],
    });

    const result = await ctx.lazy(['import-conversation', '--show', 'dddddddd']);

    expectSuccess(result);
    // Should show header info
    expectOutput(result, 'dddddddd');
    expectOutput(result, 'Discussing API design for user endpoints');
    // Should show interleaved messages
    expectOutput(result, 'How should we structure the user API?');
    expectOutput(result, 'I recommend RESTful endpoints with versioning.');
    expectOutput(result, 'Should we use GraphQL instead?');
    expectOutput(result, 'REST is simpler for this use case.');
  });

  test('shows conversation metadata', async () => {
    await createFakeConversation(ctx.root, 'eeeeeeee-ffff-aaaa-bbbb-cccccccccccc', {
      summary: 'Test metadata display',
      gitBranch: 'feature/test-branch',
      messages: [
        { role: 'user', text: 'Hello' },
        { role: 'assistant', text: 'Hi there' },
      ],
    });

    const result = await ctx.lazy(['import-conversation', '--show', 'eeeeeeee']);

    expectSuccess(result);
    expectOutput(result, 'feature/test-branch');
    expectOutput(result, '2 (1 human, 1 assistant)');
  });

  test('lazy show displays conversation by session ID', async () => {
    await createFakeConversation(ctx.root, 'aabbccdd-eeee-ffff-aaaa-bbbbbbbbbbbb', {
      summary: 'Refactoring the database layer',
      gitBranch: 'feature/db-refactor',
      messages: [
        { role: 'user', text: 'Lets refactor the database connection pool' },
        { role: 'assistant', text: 'I suggest using a singleton pattern for the pool.' },
      ],
    });

    const result = await ctx.lazy(['show', 'aabbccdd']);

    expectSuccess(result);
    expectOutput(result, 'aabbccdd');
    expectOutput(result, 'Refactoring the database layer');
    expectOutput(result, 'feature/db-refactor');
    expectOutput(result, 'Lets refactor the database connection pool');
    expectOutput(result, 'I suggest using a singleton pattern for the pool.');
  });

  test('lazy builder list shows captured conversations', async () => {
    await createFakeConversation(ctx.root, '11111111-2222-3333-4444-555555555555', {
      summary: 'Planning the API redesign',
      messages: [
        { role: 'user', text: 'Let us redesign the API from scratch' },
        { role: 'assistant', text: 'Sounds good, lets start with the endpoints.' },
        { role: 'user', text: 'What about authentication?' },
      ],
    });

    await createFakeConversation(ctx.root, '66666666-7777-8888-9999-aaaaaaaaaaaa', {
      summary: 'Debugging the cache layer',
      messages: [
        { role: 'user', text: 'The cache is returning stale data' },
        { role: 'assistant', text: 'Let me check the TTL configuration.' },
      ],
    });

    const result = await ctx.lazy(['builder', 'list']);

    expectSuccess(result);
    expectOutput(result, '2 captured conversation(s)');
    // Shows session IDs
    expectOutput(result, '11111111');
    expectOutput(result, '66666666');
    // Shows turn counts
    expectOutput(result, '2h/1a');
    expectOutput(result, '1h/1a');
    // Shows first line of first user prompt
    expectOutput(result, 'Let us redesign the API from scratch');
    expectOutput(result, 'The cache is returning stale data');
    // Shows column headers
    expectOutput(result, 'SESSION');
    expectOutput(result, 'STARTED');
    expectOutput(result, 'TURNS');
    expectOutput(result, 'FIRST PROMPT');
  });

  test('lazy builder list shows empty state', async () => {
    const result = await ctx.lazy(['builder', 'list']);

    expectSuccess(result);
    expectOutput(result, 'No captured builder conversations yet');
  });

  test('--show-imported lists captured conversations', async () => {
    await createFakeConversation(ctx.root, 'ffffffff-aaaa-bbbb-cccc-dddddddddddd', {
      summary: 'Listed conversation test',
      messages: [
        { role: 'user', text: 'Test message' },
      ],
    });

    const result = await ctx.lazy(['import-conversation', '--show-imported']);

    expectSuccess(result);
    expectOutput(result, 'ffffffff');
    expectOutput(result, 'Listed conversation test');
  });
});

// REGRESSION: `lazy show <session-id>` must resolve a captured conversation even
// when the daemon is running. The daemon returns 404 for an unknown task; that
// 404 must map to "not a task, try a conversation" — NOT propagate as a fatal
// "Task not found". Without withDaemon these pass through LAZY_TEST=1 and never
// exercise the RPC 404 path, which is exactly how this bug hid (the direct
// handler path already returned null on 404). See queryTaskShow in rpc-fallback.
describe('lazy show conversation via daemon RPC', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('resolves a conversation session ID prefix through the daemon', async () => {
    await createFakeConversation(ctx.root, '98f4244f-31d5-4880-acdd-6947c5ea1e0c', {
      summary: 'Wiring up the reconciler',
      gitBranch: 'feature/reconciler',
      messages: [
        { role: 'user', text: 'How does the reconciler pick up new tasks?' },
        { role: 'assistant', text: 'It polls the storage layer on an interval.' },
      ],
    });

    // The builder-list hint ('lazy show <session-id>') must simply work.
    const result = await ctx.lazy(['show', '98f4244f']);

    expectSuccess(result);
    expectOutput(result, '98f4244f');
    expectOutput(result, 'Wiring up the reconciler');
    expectOutput(result, 'feature/reconciler');
    expectOutput(result, 'How does the reconciler pick up new tasks?');
    expectOutput(result, 'It polls the storage layer on an interval.');
  });

  test('lazy view (show alias) resolves a conversation through the daemon', async () => {
    await createFakeConversation(ctx.root, 'ad58b238-21fa-473f-8720-ca3b239e52aa', {
      summary: 'Discussing the storage abstraction',
      messages: [
        { role: 'user', text: 'Why is storage behind an interface?' },
        { role: 'assistant', text: 'So the backend can be swapped without touching callers.' },
      ],
    });

    const result = await ctx.lazy(['view', 'ad58b238']);

    expectSuccess(result);
    expectOutput(result, 'Discussing the storage abstraction');
    expectOutput(result, 'Why is storage behind an interface?');
  });

  test('unknown id errors actionably, mentioning tasks and conversations', async () => {
    const result = await ctx.lazy(['show', 'deadbeef']);

    expectFailure(result);
    expectError(result, 'No task, conversation, or file found matching');
    expectError(result, 'deadbeef');
  });

  test('ambiguous conversation prefix errors instead of picking one', async () => {
    // Two conversations sharing the '12345678' prefix — resolution must refuse
    // to silently pick one, matching how task short-ID prefixes disambiguate.
    await createFakeConversation(ctx.root, '12345678-0000-0000-0000-000000000001', {
      summary: 'First ambiguous conversation',
      messages: [{ role: 'user', text: 'First conversation prompt' }],
    });
    await createFakeConversation(ctx.root, '12345678-0000-0000-0000-000000000002', {
      summary: 'Second ambiguous conversation',
      messages: [{ role: 'user', text: 'Second conversation prompt' }],
    });

    const result = await ctx.lazy(['show', '12345678']);

    expectFailure(result);
    expectError(result, 'Multiple conversations match');
  });
});
