/**
 * The demo's fixture repository: a small, real git project with real history.
 *
 * It is deliberately a PLAUSIBLE project rather than a pile of `file1.txt`.
 * Everything a reviewer looks at in the demo — a diff, a conflict, a
 * protected-file violation — reads as nonsense if the underlying repo is
 * nonsense, and the point of the demo is to judge review SURFACES, which means
 * the content passing through them has to look like work.
 *
 * It is also small on purpose: five files and four commits, so `lazy playground up`
 * costs a second rather than a minute, and a diff fits on a screen.
 */

import { mkdir, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { run$ } from './runtime';

/** Git identity every fixture commit is made under. */
const GIT_IDENTITY = [
  '-c', 'user.email=demo@lazy.invalid',
  '-c', 'user.name=Lazy Demo',
];

/** A file in the fixture repo, as of one commit. */
interface FixtureFile {
  path: string;
  content: string;
}

/** One commit of the fixture repo's history. */
interface FixtureCommit {
  message: string;
  files: FixtureFile[];
}

/**
 * The `[permissions] protected` glob the demo configures.
 *
 * Exported because the seeding code needs the SAME value to make a task that
 * violates it — a demo whose "protected file violation" task does not actually
 * violate the configured pattern would be a screenshot of a bug, not a feature.
 */
export const DEMO_PROTECTED_GLOB = 'src/pricing.js';

/**
 * The file two demo tasks both edit, which is how the conflict case is seeded.
 *
 * One task's change is accepted into the parent first; the second task then has
 * a genuine merge conflict to resolve, which is what `lazy sync` and the review
 * surfaces have to show correctly.
 */
export const DEMO_CONFLICT_FILE = 'src/cart.js';

const HISTORY: FixtureCommit[] = [
  {
    message: 'Initial commit: the Lazy Demo Shop',
    files: [
      {
        // Committed, because that is where a project's `[serve]` declaration
        // lives: the daemon reads the PROJECT ROOT's lazy.toml, and under a fleet
        // backend the root is a clone made inside the machine — nothing the demo
        // writes after the fact can reach it. A bare port is addressed by its
        // number, so the shop is `8080.<task>.lazy.localhost`. `lazy init` keeps
        // a committed lazy.toml and only points its storage at the store.
        path: 'lazy.toml',
        content: [
          '# Lazy configuration for the demo shop.',
          '',
          '[serve]',
          '# The port a task\'s dev server listens on inside its environment; lazy',
          '# publishes it and the Services card shows where it answers.',
          'ports = [8080]',
          '',
        ].join('\n'),
      },
      {
        path: 'README.md',
        content: [
          '# Lazy Demo Shop',
          '',
          'A tiny shopping-cart library that exists so lazy has something real to',
          'review. It is not a product. Every task in this demo project changes a',
          'file in here, so diffs, conflicts and protected-file rules are about',
          'code that plausibly belongs together.',
          '',
          '## Layout',
          '',
          '- `src/cart.js` — the cart itself',
          '- `src/pricing.js` — price rules (protected: agents may not edit it)',
          '- `src/inventory.js` — stock lookups',
          '',
        ].join('\n'),
      },
      {
        path: '.gitignore',
        content: 'node_modules/\n*.log\n',
      },
    ],
  },
  {
    message: 'Add the cart',
    files: [
      {
        path: 'src/cart.js',
        content: [
          '// The shopping cart. Deliberately simple: the demo is about review',
          '// surfaces, not about carts.',
          '',
          'export function createCart() {',
          '  return { items: [] };',
          '}',
          '',
          'export function addItem(cart, sku, quantity) {',
          '  cart.items.push({ sku, quantity });',
          '  return cart;',
          '}',
          '',
          'export function itemCount(cart) {',
          '  return cart.items.length;',
          '}',
          '',
        ].join('\n'),
      },
    ],
  },
  {
    message: 'Add pricing rules',
    files: [
      {
        path: 'src/pricing.js',
        content: [
          '// Price rules. This file is listed in [permissions] protected in',
          '// lazy.toml, so an agent that edits it is flagged for review after the',
          '// turn. The demo seeds a task that does exactly that on purpose.',
          '',
          'export const TAX_RATE = 0.2;',
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
      },
    ],
  },
  {
    message: 'Add inventory lookups and a test',
    files: [
      {
        path: 'src/inventory.js',
        content: [
          '// Stock lookups, backed by a map because the demo has no database.',
          '',
          'const STOCK = {',
          "  'demo-mug': 4,",
          "  'demo-shirt': 0,",
          '};',
          '',
          'export function inStock(sku) {',
          '  return (STOCK[sku] ?? 0) > 0;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'test/cart.test.js',
        content: [
          "import { createCart, addItem, itemCount } from '../src/cart.js';",
          '',
          'export function testAddItem() {',
          '  const cart = addItem(createCart(), \'demo-mug\', 2);',
          '  if (itemCount(cart) !== 1) throw new Error(\'expected one line item\');',
          '}',
          '',
        ].join('\n'),
      },
    ],
  },
];

/**
 * Create the fixture repository, with history, at `repoPath`.
 *
 * The repo's git identity is pinned per-command rather than written into its
 * config: the demo runs inside an agent container where the ambient
 * `user.email` may be unset, and a fixture that only builds on a machine with a
 * configured git identity is a fixture that fails in CI.
 */
export async function createFixtureRepo(repoPath: string, env: Record<string, string>): Promise<void> {
  await mkdir(repoPath, { recursive: true });

  const git = async (what: string, args: string[]) =>
    await run$(what, ['git', ...args], { cwd: repoPath, env });

  // `-b main` rather than relying on init.defaultBranch: the demo's branch name
  // appears in every seeded task's base, and a repo that comes up on `master`
  // on one machine and `main` on another makes those unreproducible.
  await git('git init', ['init', '-b', 'main']);

  for (const commit of HISTORY) {
    for (const file of commit.files) {
      const full = join(repoPath, file.path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, file.content);
    }
    await git('git add', ['add', '-A']);
    await git('git commit', [...GIT_IDENTITY, 'commit', '-m', commit.message]);
  }
}
