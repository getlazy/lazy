import { describe, expect, test } from 'bun:test';

const storageCalls: { method: string; args: any }[] = [];
const rpcCalls: { command: string; params: any }[] = [];

const deps: any = {
  demoStorage: async (_repo: string, method: string, args: any) => {
    storageCalls.push({ method, args });
    if (method === 'createSystemMessage') return { id: `msg-${storageCalls.length}` };
    return { id: 'x' };
  },
  demoRpc: async (_repo: string, command: string, params: any) => {
    rpcCalls.push({ command, params });
    if (command === 'expandPresentation') return { presentation: params.presentation };
    return {};
  },
};

import { seedPopulatedScreens } from '../../src/demo/seed-screens';

describe('seedPopulatedScreens', () => {
  test('fills inbox, regions, services command and builders through the daemon', async () => {
    await seedPopulatedScreens({ lazyCmd: {} as any, repo: '/r', env: {}, report: () => {} }, deps);

    // INVARIANT: the demo seeds screens only via daemon RPC, with at least one unread message.
    // A hand-written store row would let a UI bug through review.
    const created = storageCalls.filter(c => c.method === 'createSystemMessage');
    expect(created.length).toBe(3);
    expect(storageCalls.filter(c => c.method === 'markSystemMessageRead').length).toBe(1);

    expect(rpcCalls.some(c => c.command === 'expandPresentation')).toBe(true);
    const report = storageCalls.find(c => c.method === 'upsertTurnReport')!;
    expect(report.args.input.presentation.groups.length).toBeGreaterThanOrEqual(2);
    expect(rpcCalls.some(c => c.command === 'serve.setStartServicesCmd')).toBe(true);

    const conv = storageCalls.find(c => c.method === 'saveConversation')!.args.conversation;
    expect(conv.stats.messageCount).toBe(conv.messages.length);
  });
});
