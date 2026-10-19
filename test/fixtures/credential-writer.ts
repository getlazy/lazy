import { access, open, unlink, writeFile } from 'fs/promises';
import { withCredentialFileLock, replaceCredentialFile } from '../../src/credentials/file-updates';
import { FileBackend } from '../../src/credentials/backends';
import { deleteCredential, setCredential } from '../../src/credentials/store';

const [projectRoot, prefix, barrier, target = 'file'] = process.argv.slice(2);
if (target === 'interrupt') {
  const probe = await open(`${barrier}.probe`, 'wx', 0o600);
  const prototype = Object.getPrototypeOf(probe);
  const write = prototype.writeFile;
  await probe.close();
  await unlink(`${barrier}.probe`);
  prototype.writeFile = async function () {
    await write.call(this, '{"partial":');
    await writeFile(barrier, 'partial write reached');
    await Bun.sleep(60_000);
    throw new Error('Interrupted-write fixture was not killed');
  };
  await withCredentialFileLock(projectRoot, () => replaceCredentialFile(projectRoot, '{"new":"value"}'));
  process.exit(0);
}
while (true) {
  try {
    await access(barrier);
    break;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await Bun.sleep(5);
  }
}
const backend = new FileBackend();
const reader = backend as unknown as { read(root: string): Promise<Record<string, string>> };
const read = reader.read.bind(backend);
reader.read = async (root) => {
  const snapshot = await read(root);
  await Bun.sleep(prefix === 'first' ? 10 : 30);
  return snapshot;
};
for (let iteration = 0; iteration < 30; iteration++) {
  const provider = target === 'rotation' ? 'shared' : `${prefix}-${iteration}`;
  if (target !== 'file') {
    await setCredential(projectRoot, { provider, kind: 'api-key', secret: `secret-${prefix}-${iteration}` }, 'file');
    if (target === 'mixed' && iteration % 2 === 1) {
      await deleteCredential(projectRoot, `${prefix}-${iteration - 1}`);
    }
  } else {
    await backend.set(projectRoot, provider, `secret-${provider}`);
    if (iteration % 2 === 1) await backend.remove(projectRoot, `${prefix}-${iteration - 1}`);
  }
}
