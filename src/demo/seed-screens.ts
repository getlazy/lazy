/**
 * Data for the screens a fresh demo would otherwise show empty: the inbox,
 * review regions, the Services card and the Builders pages.
 *
 * Every write goes through the demo daemon's own RPC (a client calling the
 * daemon, never a write behind its back), and each mirrors what a real producer
 * sends: system messages are what the daemon files, a walkthrough is what an
 * agent's `lazy_report` stores, a builder conversation is what the importer
 * saves.
 *
 * What is deliberately NOT seeded: a RUNNING service and the web shell both need
 * a task container, and the demo runs on the host-process runner (the daemon
 * refuses `serve.run` there). Faking either would be a lie about the product.
 */

import { demoRpc as realDemoRpc, demoStorage as realDemoStorage } from './runtime';
import type { SeedContext } from './seed';

/** The project's Start services command: the shop's dev server on its declared port. */
export const DEMO_START_SERVICES_CMD = "bun -e 'Bun.serve({ port: 8080, fetch: () => new Response(\"Lazy Demo Shop\") })'";

const MINUTE = 60_000;

/** The daemon-facing calls the seeding makes; production passes the real ones. */
export interface SeedScreensDeps {
  demoRpc: typeof realDemoRpc;
  demoStorage: typeof realDemoStorage;
}

export async function seedPopulatedScreens(
  ctx: SeedContext,
  deps: SeedScreensDeps = { demoRpc: realDemoRpc, demoStorage: realDemoStorage },
): Promise<void> {
  await seedSystemMessages(ctx, deps);
  await seedReviewRegions(ctx, deps);
  await seedServicesCommand(ctx, deps);
  await seedBuilderConversation(ctx, deps);
}

async function seedSystemMessages(ctx: SeedContext, { demoRpc, demoStorage }: SeedScreensDeps): Promise<void> {
  ctx.report('filing system messages');
  const messages = [
    {
      source: 'daemon',
      kind: 'alert',
      title: 'demo-protected is held: it edits src/pricing.js',
      body:
        'The last turn of **demo-protected** changed `src/pricing.js`, which is listed under ' +
        '`[permissions] protected`. The task is parked in `conflict` until a person approves or ' +
        'rejects that file.\n\nOpen the task and review the change to decide.',
    },
    {
      source: 'daemon',
      kind: 'notice',
      title: 'demo-conflict no longer merges cleanly',
      body:
        '`demo-accepted` landed on `main` and touches the same lines of `src/cart.js` as ' +
        '**demo-conflict**. Run a sync on demo-conflict to merge `main` in and resolve the overlap.',
    },
    {
      source: 'daemon',
      kind: 'report',
      title: 'Weekly token usage',
      body:
        'This week every agent turn in the demo project ran on ' +
        '`claude-code`. See the Token budget box on the dashboard for the breakdown.',
    },
  ] as const;
  const created: { id: string }[] = [];
  for (const input of messages) {
    created.push(await demoStorage<{ id: string }>(ctx.repo, 'createSystemMessage', { input }));
  }
  // One already read, so the inbox shows both states.
  await demoStorage(ctx.repo, 'markSystemMessageRead', { id: created[2].id });
}

/**
 * A walkthrough on demo-review, stored the way `lazy_report` stores one:
 * expanded by the daemon first, then upserted on the task's session.
 */
async function seedReviewRegions(ctx: SeedContext, { demoRpc, demoStorage }: SeedScreensDeps): Promise<void> {
  ctx.report('filing a review walkthrough on demo-review');
  const task = await demoStorage<{ id: string } | null>(ctx.repo, 'getTask', { taskId: 'demo-review' });
  if (!task) throw new Error('Seeding: demo-review was created but the daemon cannot find it.');
  const session = await demoStorage<{ id: string } | null>(ctx.repo, 'getSessionByTaskId', { taskId: task.id });
  if (!session) throw new Error('Seeding: demo-review has no session to attach a report to.');

  const expanded = await demoRpc<{ presentation?: unknown; refused?: unknown }>(ctx.repo, 'expandPresentation', {
    taskId: task.id,
    presentation: {
      groups: [
        {
          id: 'stock-state',
          title: 'Tell the three stock states apart',
          summary: 'A new helper reports in-stock, out-of-stock or unknown-sku; the old boolean is untouched.',
          tier: 'core',
          items: [{ kind: 'file', file: 'src/inventory.js', note: 'The new three-valued helper beside the old boolean one.' }],
        },
        {
          id: 'unknown-sku-test',
          title: 'Cover the unknown-SKU path',
          summary: 'A test for the case the reviewer asked about.',
          tier: 'tests',
          items: [{ kind: 'file', file: 'test/inventory.test.js' }],
        },
      ],
    },
  });
  if (expanded.refused || !expanded.presentation) {
    throw new Error(`Seeding: the daemon refused the demo walkthrough: ${JSON.stringify(expanded.refused)}`);
  }

  await demoStorage(ctx.repo, 'upsertTurnReport', {
    taskId: task.id,
    input: {
      session_id: session.id,
      sections: [
        { kind: 'behavior_change', body: 'A mistyped SKU is no longer reported as sold out: callers can ask `stockStateOf` and get `unknown-sku`.' },
        { kind: 'commentary', body: 'Whether `inStock` should throw on an unknown SKU is raised as a blocking decision.' },
      ],
      presentation: expanded.presentation,
    },
  });
}

/** Designate the Start services command, so the Services card names what it will run. */
async function seedServicesCommand(ctx: SeedContext, { demoRpc, demoStorage }: SeedScreensDeps): Promise<void> {
  ctx.report('designating the Start services command');
  await demoRpc(ctx.repo, 'serve.setStartServicesCmd', { command: DEMO_START_SERVICES_CMD });
}

/** One builder conversation, saved the way the importer saves a captured transcript. */
async function seedBuilderConversation(ctx: SeedContext, { demoRpc, demoStorage }: SeedScreensDeps): Promise<void> {
  ctx.report('saving a builder conversation');
  const start = Date.now() - 90 * MINUTE;
  const at = (min: number) => new Date(start + min * MINUTE).toISOString();
  const usage = { inputTokens: 900, outputTokens: 320, cacheCreationTokens: 0, cacheReadTokens: 0 };
  const turns: [number, 'user' | 'assistant', string][] = [
    [0, 'user', 'The shop reports a mistyped SKU as sold out. Can you file a task to tell the two apart?'],
    [1, 'assistant', 'Filed **demo-review**: stock lookups will distinguish an unknown SKU from an out-of-stock one. I will raise whether `inStock` should throw.'],
    [30, 'user', 'Also raise the tax rate to 21%, but pricing.js is protected — I want to see it before it lands.'],
    [31, 'assistant', 'Filed **demo-protected**. Its turn edits `src/pricing.js`, so it will park in `conflict` until you approve that file.'],
    [60, 'user', 'Good. Rename `quantity` to `qty` on cart lines too.'],
    [61, 'assistant', 'Filed **demo-conflict**. It touches the same lines as the discount work, so expect a conflict once that lands.'],
  ];
  const messages = turns.map(([min, role, text], i) => ({
    uuid: `demo-builder-${i}`,
    parentUuid: i === 0 ? null : `demo-builder-${i - 1}`,
    timestamp: at(min),
    role,
    text,
    model: role === 'assistant' ? 'claude-opus-5-5' : null,
    usage: role === 'assistant' ? usage : null,
  }));
  await demoStorage(ctx.repo, 'saveConversation', {
    conversation: {
      sessionId: '3f0c9a52-7d1e-4b8a-9c64-demo00000001',
      projectPath: '-home-user--lazy-playground-repo',
      cwd: ctx.repo,
      version: null,
      gitBranch: 'main',
      startedAt: at(0),
      endedAt: at(61),
      importedAt: Date.now(),
      summary: messages[0].text,
      stats: {
        messageCount: messages.length,
        userMessageCount: 3,
        assistantMessageCount: 3,
        subagentCount: 0,
        totalTokens: 3 * (usage.inputTokens + usage.outputTokens),
      },
      totalUsage: {
        inputTokens: 3 * usage.inputTokens,
        outputTokens: 3 * usage.outputTokens,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
      messages,
      subagents: [],
    },
  });
}
