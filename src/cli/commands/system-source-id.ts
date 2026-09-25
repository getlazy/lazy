/**
 * `lazy system source-id` — print the identity of a lazy source tree.
 *
 * Two readers, and they are the reason this is a command rather than an
 * internal function:
 *
 *  - **The self-host image build**, with `--write`, to bake
 *    `.source-fingerprint` into the shipped lazy checkout. It used to compute
 *    that with a `find | xargs sha256sum | sha256sum | awk` pipeline, which was
 *    a second implementation of src/utils/source-id.ts that nothing kept honest.
 *  - **Lazy Teams**, which has to ask "which lazy code would I launch a daemon
 *    from?" without running that code. The fleet supervisor already shells out
 *    to lazy for provisioning (it is the documented carve-out in
 *    lazy-teams/CLAUDE.md), so this joins the verbs it may call.
 *
 * Deliberately does NOT require a lazy project. The question is about a source
 * checkout, not about a store — and the image build runs it in a tree that has
 * never been `lazy init`ed.
 */

import { parseFlags } from '../helpers';
import { writeFile } from 'fs/promises';
import { join, resolve } from 'path';
import {
  FINGERPRINT_FILE,
  computeSourceIdentityOf,
  getSourceIdentity,
  sourceCheckoutRoot,
  sourceIdentityOf,
  type SourceIdentity,
} from '../../utils/source-id';
import { VERSION } from '../../version';

export async function commandSystemSourceId(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'checkout', takesValue: true },
    { name: 'write', takesValue: false },
    { name: 'json', takesValue: false },
  ], 'system source-id');

  const checkout = parsed.flags.get('checkout') as string | undefined;
  const write = parsed.flags.get('write') === true;
  const json = parsed.flags.get('json') === true;

  let identity: SourceIdentity;
  try {
    // `--write` always COMPUTES, and never reads a baked value — a writer that
    // preferred the baked file could only rewrite a stale one with itself, so a
    // leftover `.source-fingerprint` would pin the checkout's identity for ever
    // and no re-bake could dislodge it. See computeSourceIdentityOf.
    //
    // Otherwise: a named checkout is read as it is NOW; with no argument the
    // answer is about the code this process is running, which is the cached one.
    const root = checkout ? resolve(checkout) : sourceCheckoutRoot();
    if (write) {
      if (root === null) {
        console.error('Error: --write needs a source checkout to write into, and this is a compiled binary.');
        console.error('       Pass --checkout <path> naming the lazy tree to fingerprint.');
        process.exit(1);
      }
      identity = await computeSourceIdentityOf(root);
    } else {
      identity = checkout ? await sourceIdentityOf(resolve(checkout)) : await getSourceIdentity();
    }
  } catch (err) {
    const where = checkout ? resolve(checkout) : 'this checkout';
    console.error(`Error: could not read the lazy source tree at ${where}: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  if (write) {
    // `checkoutPath` is non-null by construction here: the `--write` branch
    // above refuses a compiled binary before computing anything.
    const target = join(identity.checkoutPath!, FINGERPRINT_FILE);
    await writeFile(target, `${identity.id}\n`, 'utf-8');
    if (!json) console.error(`Wrote ${target}`);
  }

  if (json) {
    console.log(JSON.stringify({ ...identity, version: VERSION }));
    return;
  }
  console.log(identity.id);
}

export function systemSourceIdUsage(): void {
  console.log(`Usage: lazy system source-id [options]

Print the identity of a lazy source tree — a content fingerprint of the code
that decides what a daemon actually runs. Two trees with the same id are the
same lazy; different ids mean different code, whether or not the version string
moved.

Options:
  --checkout <path>  Fingerprint this checkout instead of the running one
  --write            Also write the id to .source-fingerprint in that checkout
  --json             Print id, kind and checkout path as JSON

The 'kind' says where the answer came from: 'baked' (a .source-fingerprint
written by a build), 'computed' (the tree was hashed just now), or 'build' (a
compiled binary with no source tree, so the id is not comparable to a checkout's).

Examples:
  lazy system source-id                       # What is this lazy?
  lazy system source-id --json                # …with kind and path
  lazy system source-id --checkout /opt/lazy --write
                                              # Bake the fingerprint at image build`);
}
