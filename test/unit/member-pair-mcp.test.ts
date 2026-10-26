import { beforeEach, afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { prepareMemberPairMcp, lookupMemberPairIdentity, assertMemberPairTool } from '../../src/daemon/member-pair-mcp';
import { claimMemberTerminal, markMemberTerminalEntered, memberTerminalContainer, endMemberEnvironmentsOf, resetMemberTerminalsForTests } from '../../src/server/member-terminals';
import { setDaemonContext, clearDaemonContext } from '../../src/daemon/context';
import { AGENT_ONLY_TOOL_NAMES, BUILDER_ONLY_TOOL_NAMES } from '../../src/mcp/tool-roles';
import { readDaemonMcpConfig, readDaemonMcpConfigWithRetry } from '../../src/daemon/mcp-proxy';
import { McpServer, registerTools, allTools } from '../../src/mcp';

let directory: string;
const closes: Array<() => void> = [];
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'member-mcp-'));
  setDaemonContext({ webPort: 26025, token: 'control' });
});
afterEach(async () => {
  for (const close of closes.splice(0)) close();
  resetMemberTerminalsForTests();
  clearDaemonContext();
  if (directory) await rm(directory, { recursive: true, force: true });
});
const email = 'alice@example.com';
async function environment(remove = async () => {}) {
  claimMemberTerminal('task-1', email);
  markMemberTerminalEntered('task-1', email);
  await memberTerminalContainer('task-1', email, async () => ({ name: 'member', binary: 'docker', remove }), async () => true);
}
async function prepare(readOnly = false) {
  const mcp = await prepareMemberPairMcp({ root: '/project', taskId: 'task-1', member: { email }, readOnly, directory });
  closes.push(mcp.close);
  const config = JSON.parse(await readFile(join(directory, mcp.configPath.split('/').at(-1)!), 'utf-8'));
  return { ...mcp, token: config.token as string };
}

// INVARIANT: an ended environment's authority never revives when that member
// returns, even if the old connection's close notification has not arrived.
test('a member returning cannot revive a departed environment token', async () => {
  await environment();
  const old = await prepare();
  expect(lookupMemberPairIdentity('/project', old.token)?.member.email).toBe(email);
  await endMemberEnvironmentsOf(email);
  expect(lookupMemberPairIdentity('/project', old.token)).toBeNull();
  await environment();
  const fresh = await prepare();
  expect(lookupMemberPairIdentity('/project', fresh.token)?.member.email).toBe(email);
  expect(lookupMemberPairIdentity('/project', old.token)).toBeNull();
  old.close();
  expect(lookupMemberPairIdentity('/project', fresh.token)).not.toBeNull();
});

// INVARIANT: failed container removal cannot keep a departed member authorized.
test('vacating refuses tools immediately even when container removal fails', async () => {
  await environment(async () => { throw new Error('runtime unavailable'); });
  const mcp = await prepare();
  await expect(endMemberEnvironmentsOf(email)).rejects.toThrow('runtime unavailable');
  expect(lookupMemberPairIdentity('/project', mcp.token)).toBeNull();
});

// INVARIANT: no token can cross projects, and Chat's read-only toolset is
// enforced by the daemon regardless of what a client advertises or requests.
test('a Chat token serves reads only on its own project', async () => {
  await environment();
  const mcp = await prepare(true);
  expect(lookupMemberPairIdentity('/another-project', mcp.token)).toBeNull();
  const identity = lookupMemberPairIdentity('/project', mcp.token)!;
  expect(() => assertMemberPairTool(identity, 'lazy_show')).not.toThrow();
  for (const tool of ['lazy_create', 'lazy_internal_git', 'future_unclassified_tool']) {
    expect(() => assertMemberPairTool(identity, tool)).toThrow('not available');
  }
  mcp.close();
  expect(lookupMemberPairIdentity('/project', mcp.token)).toBeNull();
});

// INVARIANT: a member connection never owns the task agent's supervised turn.
// Hiding these tools is insufficient: stale clients can call the daemon directly.
for (const readOnly of [false, true]) {
  test(`${readOnly ? 'Chat' : 'Pair'} refuses every agent-only tool at dispatch`, async () => {
    await environment();
    const mcp = await prepare(readOnly);
    const identity = lookupMemberPairIdentity('/project', mcp.token)!;
    for (const tool of AGENT_ONLY_TOOL_NAMES) {
      expect(() => assertMemberPairTool(identity, tool)).toThrow('not available');
    }
    expect(() => assertMemberPairTool(identity, 'lazy_show')).not.toThrow();
    if (!readOnly) {
      for (const tool of ['lazy_comment', 'lazy_create', 'lazy_start']) {
        expect(() => assertMemberPairTool(identity, tool)).not.toThrow();
      }
    }
  });
}

// INVARIANT: member discovery excludes the agent's turn tools, while the
// authenticated daemon gate above remains authoritative if discovery is bypassed.
test('member config narrows tool discovery through either config reader', async () => {
  await environment();
  const mcp = await prepare();
  const path = join(directory, mcp.configPath.split('/').at(-1)!);
  for (const config of [readDaemonMcpConfig(path), await readDaemonMcpConfigWithRetry(path)]) {
    expect(config.memberPair).toBe(true);
    const server = new McpServer({ name: 'lazy', version: 'test' });
    registerTools(server, new Map(allTools.map(t => [t.name, async () => ({})])), allTools, {
      role: 'agent', memberPair: config.memberPair,
    });
    const encoder = new TextEncoder();
    const input = new ReadableStream<Uint8Array>({ start(c) {
      c.enqueue(encoder.encode(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n'));
      c.close();
    } });
    const replies: any[] = [];
    await server.run({ input, output: line => { replies.push(JSON.parse(line)); } });
    const names = replies[0].result.tools.map((t: { name: string }) => t.name);
    for (const tool of [...AGENT_ONLY_TOOL_NAMES, ...BUILDER_ONLY_TOOL_NAMES]) expect(names).not.toContain(tool);
    expect(names).toContain('lazy_show');
    expect(names).toContain('lazy_comment');
  }
});
