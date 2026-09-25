/**
 * The seeded tasks — the reason the demo exists.
 *
 * A reviewer judging a review surface needs to see it holding each of the
 * states it is supposed to render, and to see them at once rather than one at a
 * time. So the demo seeds a project whose tasks sit in every state worth
 * looking at, and every one of them gets there the way a real task would: a
 * real daemon launching a real supervisor against a real (fake) agent binary,
 * producing real turns and real commits. Nothing here writes a status field
 * to make a task LOOK like something it is not — a hand-written store row is
 * exactly the thing that lets a UI bug through review.
 *
 * The one thing seeded out-of-band is raised items, which have no human-facing
 * create surface at all (agents raise them over MCP). Those go through the
 * demo daemon's `createRaisedItem` RPC — a client calling the daemon, not a
 * write behind its back.
 */

import type { DemoScript } from './agent';
import { DEMO_CONFLICT_FILE, DEMO_PROTECTED_GLOB } from './fixture';
import { lazy, lazyTry, demoStorage, type LazyInvocation } from './runtime';

/** How long the `working` task's agent holds its turn open. */
const WORKING_HOLD_MS = 45 * 60 * 1000;

/** Task codes the demo seeds, in creation order. */
export const DEMO_TASK_CODES = [
  'demo-backlog',
  'demo-conflict',
  'demo-accepted',
  'demo-review',
  'demo-protected',
  'demo-working',
] as const;

/**
 * What the demo agent does for each task.
 *
 * `demo-review` gets a second turn because it is the task a reviewer unblocks:
 * without one, an unblock would replay the first turn's commit and fail on an
 * empty change.
 */
export function demoScript(): DemoScript {
  return {
    'demo-conflict': [{
      result:
        'Renamed the cart line-item shape to `{ sku, qty }` and updated every caller. ' +
        'This touches the same lines as the discount work, so accepting both will conflict.',
      commit: {
        message: 'cart: rename quantity to qty on line items',
        files: [{
          path: DEMO_CONFLICT_FILE,
          content: [
            '// The shopping cart. Deliberately simple: the demo is about review',
            '// surfaces, not about carts.',
            '',
            'export function createCart() {',
            '  return { items: [] };',
            '}',
            '',
            'export function addItem(cart, sku, qty) {',
            '  cart.items.push({ sku, qty });',
            '  return cart;',
            '}',
            '',
            'export function itemCount(cart) {',
            '  return cart.items.length;',
            '}',
            '',
          ].join('\n'),
        }],
      },
    }],

    'demo-accepted': [{
      result: 'Added per-line discounts to the cart, with the total helper callers asked for.',
      commit: {
        message: 'cart: support per-line discounts',
        files: [{
          path: DEMO_CONFLICT_FILE,
          content: [
            '// The shopping cart. Deliberately simple: the demo is about review',
            '// surfaces, not about carts.',
            '',
            'export function createCart() {',
            '  return { items: [] };',
            '}',
            '',
            'export function addItem(cart, sku, quantity, discount = 0) {',
            '  cart.items.push({ sku, quantity, discount });',
            '  return cart;',
            '}',
            '',
            'export function itemCount(cart) {',
            '  return cart.items.length;',
            '}',
            '',
            'export function discountTotal(cart) {',
            '  return cart.items.reduce((sum, item) => sum + (item.discount ?? 0), 0);',
            '}',
            '',
          ].join('\n'),
        }],
      },
    }],

    'demo-review': [
      {
        result:
          'Stock lookups now distinguish "out of stock" from "unknown SKU" — the old code ' +
          'reported both as out of stock, so a typo in a SKU looked like a sold-out product. ' +
          'I raised one question about what the API should return for an unknown SKU.',
        commit: {
          message: 'inventory: tell unknown SKUs apart from out-of-stock ones',
          files: [{
            path: 'src/inventory.js',
            content: [
              '// Stock lookups, backed by a map because the demo has no database.',
              '',
              'const STOCK = {',
              "  'demo-mug': 4,",
              "  'demo-shirt': 0,",
              '};',
              '',
              '/** True only for a KNOWN sku with stock. See stockStateOf for the third case. */',
              'export function inStock(sku) {',
              '  return (STOCK[sku] ?? 0) > 0;',
              '}',
              '',
              "/** 'in-stock' | 'out-of-stock' | 'unknown-sku' */",
              'export function stockStateOf(sku) {',
              "  if (!(sku in STOCK)) return 'unknown-sku';",
              "  return STOCK[sku] > 0 ? 'in-stock' : 'out-of-stock';",
              '}',
              '',
            ].join('\n'),
          }],
        },
      },
      {
        result:
          'Took the feedback: `inStock` now throws on an unknown SKU rather than returning false, ' +
          'and the test covers it.',
        commit: {
          message: 'inventory: throw on unknown SKUs rather than reporting them out of stock',
          files: [{
            path: 'test/inventory.test.js',
            content: [
              "import { stockStateOf } from '../src/inventory.js';",
              '',
              'export function testUnknownSku() {',
              "  if (stockStateOf('nope') !== 'unknown-sku') throw new Error('expected unknown-sku');",
              '}',
              '',
            ].join('\n'),
          }],
        },
      },
    ],

    'demo-protected': [{
      result:
        'Raised the tax rate to 21% as asked. Note that pricing.js is a protected file — ' +
        'this turn edited it, so it needs a human decision before it can land.',
      commit: {
        message: 'pricing: raise the tax rate to 21%',
        files: [{
          path: DEMO_PROTECTED_GLOB,
          content: [
            '// Price rules. This file is listed in [permissions] protected in',
            '// lazy.toml, so an agent that edits it is flagged for review after the',
            '// turn. The demo seeds a task that does exactly that on purpose.',
            '',
            'export const TAX_RATE = 0.21;',
            '',
            'export function priceOf(sku) {',
            '  return PRICES[sku] ?? 0;',
            '}',
            '',
            'const PRICES = {',
            "  'demo-mug': 950,",
            "  'demo-shirt': 2200,",
            '};',
            '',
            'export function withTax(amountInPence) {',
            '  return Math.round(amountInPence * (1 + TAX_RATE));',
            '}',
            '',
          ].join('\n'),
        }],
      },
    }],

    // No commit and a long hold: the point of this task is that its agent is
    // genuinely mid-turn when the demo finishes provisioning.
    'demo-working': [{
      result: 'Demo agent: this turn is held open so the task stays in `working`.',
      holdMs: WORKING_HOLD_MS,
    }],
  };
}

/** One seeded task's definition. */
export interface SeedTask {
  code: string;
  goal: string;
  prompt: string;
}

export const SEEDS: SeedTask[] = [
  {
    code: 'demo-backlog',
    goal: 'Show prices with tax included on the product page',
    prompt:
      'Prices are shown pre-tax today, which surprises people at checkout. Show the ' +
      'tax-inclusive price wherever a price appears. This task is deliberately never ' +
      'started: it is the demo\'s backlog state.',
  },
  {
    code: 'demo-conflict',
    goal: 'Rename the cart line-item quantity field to `qty`',
    prompt:
      'Rename `quantity` to `qty` on cart line items and update every caller. This task ' +
      'touches the same lines as the discount work, so it exists to show what a conflicting ' +
      'task looks like before it is merged.',
  },
  {
    code: 'demo-accepted',
    goal: 'Support per-line discounts in the cart',
    prompt: 'Add an optional per-line discount to cart items, plus a helper for the discount total.',
  },
  {
    code: 'demo-review',
    goal: 'Tell unknown SKUs apart from out-of-stock ones',
    prompt:
      'Stock lookups report an unknown SKU as out of stock, so a typo looks like a sold-out ' +
      'product. Distinguish the two.',
  },
  {
    code: 'demo-protected',
    goal: 'Raise the tax rate to 21%',
    prompt:
      'The tax rate moved to 21%. Update it. Note that the pricing file is protected — this ' +
      'task exists to show what a protected-file violation looks like in review.',
  },
  {
    code: 'demo-working',
    goal: 'Add a checkout summary endpoint',
    prompt:
      'Add an endpoint that returns the cart total, tax and discounts in one payload. This ' +
      'task is left running: it is the demo\'s `working` state.',
  },
];

/** Context the seeding steps need. */
export interface SeedContext {
  lazyCmd: LazyInvocation;
  repo: string;
  env: Record<string, string>;
  /** Called with a one-line progress message. */
  report: (message: string) => void;
}

/**
 * Drive the demo project into its seeded states.
 *
 * The ORDER is load-bearing and is the reason this is a sequence rather than a
 * fan-out:
 *
 *  - `demo-conflict` is started BEFORE `demo-accepted` is accepted, so its
 *    branch is cut from a base that does not contain the discount work. Start
 *    it afterwards and there is no conflict to demonstrate at all.
 *  - `demo-working` is started LAST and deliberately not waited on, so the demo
 *    finishes provisioning with that task genuinely mid-turn.
 */
export async function seedDemoTasks(ctx: SeedContext): Promise<string[]> {
  const { lazyCmd, repo, env } = ctx;
  const opts = { cwd: repo, env };

  for (const seed of SEEDS) {
    ctx.report(`creating ${seed.code}`);
    await lazy(`lazy create ${seed.code}`, lazyCmd, [
      'create', '--code', seed.code, '--goal', seed.goal, '--prompt', seed.prompt,
    ], opts);
  }

  // The conflict task must reach `blocked` from a base WITHOUT the discount
  // work — see the ordering note above.
  await runToBlocked(ctx, 'demo-conflict');

  await runToBlocked(ctx, 'demo-accepted');
  ctx.report('accepting demo-accepted');
  await lazy('lazy accept demo-accepted', lazyCmd, [
    'accept', 'demo-accepted', '--yes', '--reason',
    'Discounts look right and the helper is covered. Merging.',
  ], { ...opts, timeoutMs: 180_000 });

  await runToBlocked(ctx, 'demo-review');
  await seedReviewConversation(ctx);

  await runToBlocked(ctx, 'demo-protected');

  // Started, never waited on: the point is that it is still running.
  ctx.report('starting demo-working (left mid-turn on purpose)');
  await lazy('lazy start demo-working', lazyCmd, ['start', 'demo-working'], opts);

  return SEEDS.map(seed => seed.code);
}

/** Start a task and wait for its turn to finish. */
async function runToBlocked(ctx: SeedContext, code: string): Promise<void> {
  const opts = { cwd: ctx.repo, env: ctx.env };
  ctx.report(`running ${code}`);
  await lazy(`lazy start ${code}`, ctx.lazyCmd, ['start', code], opts);

  // `lazy wait` is the fast path, not the verdict. It can return the moment a
  // task transitions INTO `working` if it is called while the daemon is still
  // starting the turn — observed under load, reporting "is now working" and
  // exiting non-zero for a task that reached `blocked` a second later. So its
  // exit code is advisory and the TASK'S OWN STATE is what decides.
  const waited = await lazyTry(ctx.lazyCmd, ['wait', code], { ...opts, timeoutMs: 300_000 });

  const settled = await waitForSettledStatus(ctx, code);
  if (settled) return;

  // Genuinely stuck or genuinely failed. The usual cause is the demo agent
  // dying, and its stderr is on the turn — so show the task rather than an exit
  // code.
  const shown = await lazyTry(ctx.lazyCmd, ['show', code], opts);
  throw new Error(
    `Seeding ${code} never settled.\n` +
    `  wait said: ${waited.stdout.trim() || waited.stderr.trim()}\n` +
    `  task now:  ${shown.stdout.trim().split('\n').slice(0, 12).join('\n             ')}`,
  );
}

/**
 * Statuses a seeded turn is allowed to come to rest in.
 *
 * `conflict` belongs here as much as `blocked` does: the protected-file task is
 * SUPPOSED to land there, and that is a settled state awaiting a human, not a
 * failure.
 */
const SETTLED_STATUSES = new Set(['blocked', 'conflict']);

/**
 * Poll the task's own status until it settles, or give up.
 *
 * Asked of the daemon rather than parsed out of CLI text: the status is the
 * thing being asserted, and a substring match on rendered output is how a
 * "working(agent)" would quietly satisfy a check for "working".
 */
async function waitForSettledStatus(ctx: SeedContext, code: string): Promise<boolean> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const task = await demoStorage<{ status?: string } | null>(
      ctx.repo, 'getTask', { taskId: code },
    ).catch(() => null);

    if (task?.status && SETTLED_STATUSES.has(task.status)) return true;
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  return false;
}

/**
 * Give `demo-review` the things a real review accumulates: human comments, one
 * blocking decision and one non-blocking follow-up.
 *
 * Comments go through `lazy comment`, which never starts a turn — that is the
 * point of seeding them on a blocked task. The raised items go over the daemon's
 * RPC because there is no human create surface for them anywhere.
 */
async function seedReviewConversation(ctx: SeedContext): Promise<void> {
  const opts = { cwd: ctx.repo, env: ctx.env };
  ctx.report('seeding comments and raised items on demo-review');

  await lazy('lazy comment demo-review', ctx.lazyCmd, [
    'comment', 'demo-review', '-m',
    'Nice catch on the typo case. Before this lands: should `inStock` keep returning ' +
    'false for an unknown SKU, or throw? Callers currently treat false as "do not sell".',
  ], opts);

  await lazy('lazy comment demo-review', ctx.lazyCmd, [
    'comment', 'demo-review', '-m',
    'Also worth a test for the unknown-SKU path — the existing one only covers the cart.',
  ], opts);

  const task = await demoStorage<{ id: string } | null>(ctx.repo, 'getTask', { taskId: 'demo-review' });
  if (!task) throw new Error('Seeding: demo-review was created but the daemon cannot find it.');

  await demoStorage(ctx.repo, 'createRaisedItem', {
    taskId: task.id,
    input: {
      blocking: true,
      title: 'Unknown SKUs need a decision before this can land',
      content:
        'Should an unknown SKU throw, or keep reporting as out of stock? I assumed throwing is ' +
        'wrong for a storefront and kept the old return value, but the call sites read as if ' +
        'they want to know the difference.',
      explanation:
        'Anyone who mistypes a SKU sees "sold out" today, which sends them away instead of to a ' +
        'search box. Whichever way this goes it changes what every caller has to handle, so it ' +
        'is worth deciding before the change spreads. The new stockStateOf helper already ' +
        'reports all three cases; the open question is only what the old two-valued one does.',
      options: ['Keep returning false', 'Throw on unknown SKUs', 'Deprecate the boolean helper'],
    },
  });

  await demoStorage(ctx.repo, 'createRaisedItem', {
    taskId: task.id,
    input: {
      blocking: false,
      title: 'Stock levels are hardcoded in the source',
      content:
        'The stock map is a literal in the source file, so every stock change is a code change. ' +
        'Orthogonal to this task, but someone will hit it.',
      explanation:
        'Whoever runs the shop cannot change stock without a deploy. Not this task\'s problem — ' +
        'this one is about how unknown SKUs are reported — but it is the next thing that will ' +
        'hurt. The map lives alongside the lookups it backs.',
      proposed_code: 'demo-stock-from-store',
      proposed_prompt:
        'Stock levels are a hardcoded map in the inventory source, so changing stock needs a ' +
        'deploy. Move them behind a lookup that can be backed by something editable at runtime.',
    },
  });
}
