import { logger } from '../utils/logger';

/** Record a lost renewal through the daemon's Storage, including CLI refreshes. */
export async function recordCredentialRenewalFailure(root: string, label: string, message: string): Promise<void> {
  logger.error(`[credentials] ${message}`);
  const { getDaemonProjectRoot, getOrCreateStorage } = await import('../daemon/rpc-handlers');
  const storage = getDaemonProjectRoot() === root
    ? await getOrCreateStorage()
    : await (async () => {
      const { tryRemoteStorage } = await import('../preconditions');
      const opened = await tryRemoteStorage(root);
      if (!opened) throw new Error('The project daemon is unavailable; the failed renewal could not be added to its inbox.');
      return opened;
    })();
  await storage.createSystemMessage({
    source: 'credential-renewal',
    kind: 'alert',
    title: `A renewed ChatGPT session could not be saved: ${label}`,
    body: message,
  }, { collapseRepeats: true });
}
