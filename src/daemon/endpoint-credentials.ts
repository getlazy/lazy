/** Endpoint RPC projections and control-plane credential provisioning. */
import { loadConfig } from '../config/loader';
import { endpointRequirements, normalizeEndpointScope, legacyDefaultEndpointOrigin, type EndpointRequirement } from '../credentials/endpoint-requirements';
import { parseChatGptTokens, serializeChatGptTokens } from '../credentials/chatgpt-tokens';
import type { ActorIdentity } from './actor-tokens';
import { optionalString, requireNonBlankString } from './rpc-params';
import { RpcError } from './rpc-error';
import { canonicalCredentialKey, endpointCredentialState, listEndpointCredentials, putEndpointCredential, revokeEndpointCredential, setCredentialBillingMode, SERVICE_CREDENTIAL_USER_ID } from './user-credentials';

export interface PutEndpointCredentialParams {
  userId: string;
  endpointId: string;
  origin: string;
  kind: 'oauth' | 'api-key';
  token: string;
  label?: string;
  ownerEmail?: string;
  ownerName?: string;
}
export interface EndpointCredentialsResult {
  endpoints: (EndpointRequirement & { yours?: Awaited<ReturnType<typeof endpointCredentialState>> })[];
}
function principal(params: Record<string, unknown>, caller: ActorIdentity): string | undefined {
  const asked = optionalString(params, 'userId');
  if (caller.kind === 'user') {
    if (asked !== undefined && canonicalCredentialKey(asked) !== canonicalCredentialKey(caller.email)) throw new RpcError(403, 'Forbidden: another member’s endpoint connections.');
    return caller.email;
  }
  return asked;
}
function control(caller: ActorIdentity): void {
  if (caller.kind !== 'control') throw new RpcError(403, 'Endpoint credential provisioning is a control-plane operation.');
}
export async function handleEndpointCredentials(root: string, params: Record<string, unknown>, caller: ActorIdentity): Promise<EndpointCredentialsResult> {
  const userId = principal(params, caller);
  const requirements = endpointRequirements(await loadConfig(root));
  const endpoints = [];
  for (const r of requirements) endpoints.push({ ...r, ...(userId === undefined ? {} : { yours: await endpointCredentialState(root, userId, r) }) });
  return { endpoints };
}
export async function handleListEndpointCredentials(root: string, params: Record<string, unknown>, caller: ActorIdentity) {
  return { credentials: await listEndpointCredentials(root, principal(params, caller)) };
}
export async function handlePutEndpointCredential(root: string, params: Record<string, unknown>, caller: ActorIdentity) {
  control(caller);
  const userId = requireNonBlankString(params, 'userId');
  const endpointId = requireNonBlankString(params, 'endpointId');
  const origin = optionalString(params, 'origin');
  if (origin === undefined) throw new RpcError(400, 'origin is required');
  const kind = requireNonBlankString(params, 'kind');
  let token = requireNonBlankString(params, 'token');
  const label = optionalString(params, 'label');
  const ownerEmail = optionalString(params, 'ownerEmail');
  const ownerName = optionalString(params, 'ownerName');
  const r = endpointRequirements(await loadConfig(root)).find(r => r.endpointId === endpointId);
  if (!r || !r.kinds.length) throw new RpcError(400, `Credential not taken for endpoint "${endpointId}": no paid endpoint with that identity is configured.`);
  if (!r.kinds.includes(kind as 'oauth' | 'api-key')) throw new RpcError(400, `Endpoint '${endpointId}' takes ${r.kinds.join(' or ')}, not '${kind}'.`);
  try {
    if (origin !== '') normalizeEndpointScope(origin);
    else if (!legacyDefaultEndpointOrigin(endpointId)) throw new Error('Blank origin consent is only valid for a reserved provider default.');
    if (r.session) token = serializeChatGptTokens(parseChatGptTokens(token, 'The ChatGPT credential'));
    // Service sessions refer to the holder's sole renewal chain. Other endpoint
    // service references also name the holder; integrations spend the holder's slots.
    const sameAs = canonicalCredentialKey(userId) === SERVICE_CREDENTIAL_USER_ID && r.session ? ownerEmail : undefined;
    if (canonicalCredentialKey(userId) === SERVICE_CREDENTIAL_USER_ID && r.session && !sameAs) throw new Error('A service session requires ownerEmail identifying its holder.');
    return await putEndpointCredential(root, { userId, endpointId, origin, provider: r.provider, session: r.session, kind: kind as 'oauth' | 'api-key', token, label, ownerEmail, ownerName, renewable: r.session && !sameAs, sameAs });
  } catch (err) { throw new RpcError(400, `Could not connect endpoint '${endpointId}': ${err instanceof Error ? err.message : String(err)}`); }
}
export async function handleRevokeEndpointCredential(root: string, params: Record<string, unknown>, caller: ActorIdentity) {
  control(caller);
  return { revoked: await revokeEndpointCredential(root, requireNonBlankString(params, 'userId'), requireNonBlankString(params, 'endpointId')) };
}
export async function handleSetCredentialBillingMode(root: string, params: Record<string, unknown>, caller: ActorIdentity) {
  control(caller);
  if (params.mode !== 'member') throw new RpcError(400, "mode must be 'member'; credential operations cannot disable member billing.");
  await setCredentialBillingMode(root);
  return { mode: 'member' as const };
}
