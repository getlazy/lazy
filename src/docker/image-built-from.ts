/**
 * Read the `lazy.built.from` label off an image: the branch commit the daemon
 * last rebuilt it from. Shared by the daemon (boot: what the image in use came
 * from) and `lazy doctor`.
 */
import { spawn } from '../utils/spawn';
import { BUILT_FROM_LABEL, parseBuiltFromLabel, type BuiltFromCommit } from '../capture/built-from-label';

/** Null when the image is missing, unreadable or carries no (parsable) label. */
export async function readBuiltFromLabel(imageName: string, binary: string = 'docker'): Promise<BuiltFromCommit | null> {
  const inspect = spawn(
    [binary, 'image', 'inspect', imageName, '--format', `{{index .Config.Labels "${BUILT_FROM_LABEL}"}}`],
    { stdout: 'pipe', stderr: 'ignore', timeout: 30_000 },
  );
  const [out, code] = await Promise.all([new Response(inspect.stdout).text(), inspect.exited]);
  return code === 0 ? parseBuiltFromLabel(out.trim()) : null;
}
