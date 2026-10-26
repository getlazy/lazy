/**
 * Registering this machine's lazy SSH key with Lazy Teams, under the signed-in
 * member (`POST <teams>/api/cli/ssh_keys`, CLI-scoped token). Teams lists it
 * under Account settings → SSH keys, where it can be revoked; registering the
 * same key again is answered with the existing record, so `--install` can be
 * re-run safely.
 */

export interface RegisteredSshKey {
  id: string;
  name: string;
  fingerprint: string;
}

export async function registerSshKey(opts: {
  teamsUrl: string;
  token: string;
  publicKey: string;
  name: string;
  fetcher?: typeof fetch;
}): Promise<RegisteredSshKey> {
  const url = `${opts.teamsUrl.replace(/\/$/, '')}/api/cli/ssh_keys`;
  let response: Response;
  try {
    response = await (opts.fetcher ?? fetch)(url, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        authorization: `Bearer ${opts.token}`,
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ public_key: opts.publicKey, name: opts.name }),
    });
  } catch (err) {
    throw new Error(`Could not reach ${opts.teamsUrl} to register your SSH key: ${err instanceof Error ? err.message : String(err)}`);
  }
  let body: Record<string, unknown> = {};
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch (err) {
    if (response.ok) throw new Error(`${url} answered without JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!response.ok) {
    const why = typeof body.error === 'string' ? body.error : `HTTP ${response.status}`;
    throw new Error(`${opts.teamsUrl} refused to register your SSH key: ${why}`);
  }
  const key = (body.ssh_key ?? body) as Record<string, unknown>;
  if (typeof key.fingerprint !== 'string') throw new Error(`${url} answered without the registered key's fingerprint.`);
  return {
    id: String(key.id ?? ''),
    name: typeof key.name === 'string' ? key.name : opts.name,
    fingerprint: key.fingerprint,
  };
}
