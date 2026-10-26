/**
 * The "who else is here" banner (src/sessions/presence.ts): what a person
 * sees on entering a task.
 */

import { describe, test, expect } from 'bun:test';
import { presenceBanner, presenceNotice, type TaskPresence } from '../../src/sessions/presence';
import { listSessionsCommand } from '../../src/terminal/shell-session';

const now = Date.parse('2026-10-21T12:00:00Z');
const ago = (secs: number) => new Date(now - secs * 1000).toISOString();

const presence: TaskPresence = {
  task: 'fix-login',
  members: [
    { member: 'ada@example.com', openTerminals: 1, sessions: [{ name: 'shell', attached: true, lastActivityAt: ago(5) }] },
    { member: 'bo@example.com', openTerminals: 0, sessions: [
      { name: 'shell', attached: false, lastActivityAt: ago(600) },
      { name: 'vscode-server', attached: false, lastActivityAt: ago(180) },
    ] },
    { member: 'me@example.com', openTerminals: 1, sessions: [{ name: 'shell', attached: true, lastActivityAt: ago(1) }] },
  ],
  sessions: [
    { name: 'services', alive: true, pid: 4, exitCode: null, createdAt: ago(7200), attachedClients: 0, lastOutputAt: ago(20) },
    { name: 'worker', alive: false, pid: null, exitCode: 1, createdAt: ago(9000), attachedClients: 0, lastOutputAt: ago(300) },
  ],
  agent: { status: 'working', working: true, turn: 7, since: ago(240) },
};

describe('presenceBanner', () => {
  test('names the other members with session names and states, the container sessions, and the agent', () => {
    expect(presenceBanner(presence, { viewer: 'me@example.com', now })).toEqual([
      'In fix-login with you:',
      '  members: ada@example.com (shell · attached) · bo@example.com (shell, vscode-server · idle 3m)',
      '  sessions: services (running 2h, last output 20s ago) · worker (exited 1, 5m ago)',
      '  agent: working on turn #7 (started 4m ago)',
    ]);
  });

  // INVARIANT: what a member's container is asked for is session NAMES,
  // attached counts and activity times — never a pane's contents — so no
  // member's commands or output can reach another member through this list.
  test('the member read asks tmux for names and states only', () => {
    const script = listSessionsCommand()[2]!;
    expect(script).toContain("-F '#{session_attached} #{session_activity} #{session_name}'");
    expect(script).not.toContain('capture-pane');
    expect(script).not.toMatch(/#\{pane_/);
  });

  test('a parked agent and nobody else', () => {
    expect(presenceBanner({
      task: 't', members: [], sessions: null,
      agent: { status: 'blocked', working: false, turn: 3, since: ago(7200) },
    }, { now })).toEqual(['In t with you:', '  agent: not running a turn — blocked (since 2h ago)']);
  });

  test('the one-line notice for the status line, or nothing when nobody is there', () => {
    expect(presenceNotice(presence, { viewer: 'me@example.com', now })).toBe(
      'In fix-login with you: members: ada@example.com (shell · attached) · bo@example.com (shell, vscode-server · idle 3m) | ' +
      'sessions: services (running 2h, last output 20s ago) · worker (exited 1, 5m ago) | agent: working on turn #7 (started 4m ago)');
    expect(presenceNotice({ task: 't', members: [], sessions: null, agent: null })).toBeNull();
  });
});
