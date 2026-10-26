import { findLazyRoot } from '../../project-paths';
import { rehomeProjectStore } from '../../daemon/store-ownership';
import { parseFlags } from '../helpers';
import { promptYesNo } from '../editor';

export async function commandSystemStoreRehome(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'from', takesValue: true },
    { name: 'yes', takesValue: false },
  ], 'system store-rehome');
  const previous = parsed.flags.get('from');
  const root = findLazyRoot();
  if (!root || typeof previous !== 'string' || !previous.trim()) {
    throw new Error('Run lazy system store-rehome --from <previous-checkout|unowned> --yes inside the intended owning project. Stop the previous daemon first.');
  }
  if (parsed.flags.get('yes') !== true &&
      !(await promptYesNo(`Transfer the configured store from "${previous}" to "${root}"? The previous daemon must be stopped.`, false))) {
    return;
  }
  await rehomeProjectStore(root, previous);
  console.log(`Store ownership transferred from "${previous}" to "${root}".`);
  console.log('Ownership recorded. Start the daemon: `lazy daemon start`.');
}

export function systemStoreRehomeUsage(): void {
  console.log(`Usage: lazy system store-rehome --from <previous-checkout|unowned> [--yes]

Explicitly give this project's configured store to this checkout after stopping
the previous daemon. Use --from unowned for an older store without an owner.

Options:
  --from <checkout>  Previous checkout path, or unowned for an older store
  --yes             Skip the confirmation prompt`);
}
