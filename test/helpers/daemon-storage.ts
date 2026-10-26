import { writeFile } from 'fs/promises';
import { join } from 'path';
import { closeAllStorage, getOrCreateStorage, initDaemonStorage } from '../../src/daemon/rpc-handlers';
import { pinConfig } from './pin-config';
import { testStorageOptions } from './storage';

/** Open the real daemon singleton for a new, empty temporary project fixture. */
export async function openTestDaemonStorage(root: string): Promise<() => Promise<void>> {
  await closeAllStorage();
  await writeFile(join(root, 'lazy.toml'), `[storage]\nbackend = "external"\nexternal_path = ${JSON.stringify(testStorageOptions(root).externalPath)}\n`);
  const unpin = pinConfig(root);
  initDaemonStorage(root);
  await getOrCreateStorage();
  return async () => {
    await closeAllStorage();
    unpin();
  };
}
