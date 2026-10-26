/**
 * MCP authority for one member Pair/Chat connection. These are NOT task tokens:
 * they name the authenticated member, independently of the task's live turn.
 * Kept in this daemon only, like the WebSockets they belong to. A disconnect
 * (including daemon exit) ends the authority; reopening mints a fresh token.
 */
import { randomBytes } from 'crypto';
import { join } from 'path';
import { unlink, writeFile } from 'fs/promises';
import { getDaemonContext } from './context';
import { memberTerminalAuthority } from '../server/member-terminals';
import { RpcError } from './rpc-error';
import { isToolAllowedOnToolset } from '../mcp/tool-access';
import { isToolForMemberPair } from '../mcp/tool-roles';
import { logger } from '../utils/logger';

export const MEMBER_MCP_MOUNT = '/run/lazy-member-mcp';

export interface MemberPairIdentity {
  kind: 'member-pair';
  taskId: string;
  member: { email: string; name?: string };
  readOnly: boolean;
}
const sessions = new Map<string, { root: string; identity: MemberPairIdentity; environment: object }>();

export function lookupMemberPairIdentity(root: string, token: string | null | undefined): MemberPairIdentity | null {
  const entry = token ? sessions.get(token) : null;
  if (!entry || entry.root !== root) return null;
  const { identity } = entry;
  if (memberTerminalAuthority(identity.taskId, identity.member.email) !== entry.environment) return null;
  return identity;
}

export function assertMemberPairTool(identity: MemberPairIdentity, tool: string): void {
  if (!isToolForMemberPair(tool) || !isToolAllowedOnToolset(tool, identity.readOnly ? 'read' : 'full')) {
    throw new RpcError(403, `Tool '${tool}' is not available in this member's ${identity.readOnly ? 'Chat' : 'Pair'} session.`);
  }
}

/** directory is daemon-owned and mounted read-only into only this member's container. */
export async function prepareMemberPairMcp(opts: {
  root: string;
  taskId: string;
  member: { email: string; name?: string };
  readOnly: boolean;
  directory: string;
}): Promise<{ configPath: string; close: () => void }> {
  const environment = memberTerminalAuthority(opts.taskId, opts.member.email);
  if (!environment) {
    throw new RpcError(403, 'This member has no live terminal environment on this task. Reopen Pairing.');
  }
  const token = randomBytes(32).toString('hex');
  const filename = `${randomBytes(16).toString('hex')}.json`;
  const configPath = join(MEMBER_MCP_MOUNT, filename);
  const hostPath = join(opts.directory, filename);
  await writeFile(hostPath, JSON.stringify({
    token, projectRoot: opts.root, taskId: opts.taskId, memberPair: true,
    target: `http://host.docker.internal:${getDaemonContext().webPort}`,
  }), { mode: 0o644, flag: 'wx' });
  // Only after the file exists; a failed preparation leaves no authority.
  sessions.set(token, { root: opts.root, environment, identity: {
    kind: 'member-pair', taskId: opts.taskId, member: { ...opts.member }, readOnly: opts.readOnly,
  } });
  let closed = false;
  return { configPath, close: () => {
    if (closed) return;
    closed = true;
    sessions.delete(token); // revoke synchronously, before any fallible cleanup
    void unlink(hostPath).catch((err) => {
      if (err.code !== 'ENOENT') logger.warn(`Could not remove an ended member session's MCP config: ${err.message}`);
    });
  } };
}
