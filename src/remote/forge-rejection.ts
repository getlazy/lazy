/**
 * What a forge's refusal of a push MEANS, and what fixes it.
 *
 * A push can fail two very different ways. A TRANSPORT failure (DNS, a reset
 * connection, a timeout) may succeed on retry, and "check your network" is the
 * right advice. A REFUSAL — the server answered and said no (`[remote
 * rejected]`, a 403, a revoked token, a protected branch, a token missing the
 * `workflow` scope, an organization's SAML SSO) — fails identically however
 * many times it is retried, and network advice sends the reader the wrong way
 * (2026-10-20: a token without `workflow` scope was retried three times and
 * reported as "Check your network connection … --offline-override").
 *
 * {@link classifyForgeRefusal} reads git's / the forge's text and names the
 * kind; {@link forgeRefusalFix} turns that into the one plain fix. The forge's
 * own words always travel alongside — this only adds the translation.
 * Exit codes decide success; text only names the failure.
 */

export type ForgeRefusalKind =
  | 'workflow_scope'
  | 'sso_required'
  | 'protected_branch'
  | 'forbidden'
  | 'unauthorized'
  | 'missing_credential'
  | 'not_found'
  | 'non_fast_forward'
  | 'rejected';

export interface ForgeRefusal {
  kind: ForgeRefusalKind;
  /** The organization named by an SSO refusal, when the forge said which. */
  org?: string;
  /** The forge's own SSO authorization URL, when it gave one. */
  ssoUrl?: string;
  /** The workflow file a `workflow`-scope refusal named. */
  workflowFile?: string;
}

type Forge = 'github' | 'gitlab' | undefined;

/**
 * GitHub's SAML SSO refusals, as GitHub words them: git's "The 'org'
 * organization has enabled or enforced SAML SSO", the API's "Resource protected
 * by organization SAML enforcement", an authorization URL (`/sso?authorization_request`),
 * or the `X-GitHub-SSO` header line.
 */
const SSO_REFUSAL = /\bSAML SSO\b|organization SAML enforcement|\/sso\?authorization_request|X-GitHub-SSO:\s*required|re-?authorize the OAuth Application/i;

/** GitHub's rate-limit answers, 403 or 429: transient by definition. */
const RATE_LIMITED = /secondary rate limit|rate limit exceeded|abuse detection mechanism|too many requests/i;

/** A transport failure: the server never answered. Retrying may help. */
export function isTransportFailure(text: string): boolean {
  return /could not resolve host|failed to connect|connection (timed out|refused|reset)|network is unreachable|operation timed out|early eof|the remote end hung up unexpectedly|ssl_connect|gnutls_handshake|timed out|rpc failed|unexpected disconnect|temporary failure in name resolution|returned error: 5\d\d\b/i
    .test(text);
}

/**
 * The refusal in `text`, or null when it is not a recognised server-side
 * refusal. A transport failure (connection reset, timeout, DNS, a 5xx) or an
 * unrecognised error is null and keeps its retry; when a text carries both
 * (git's `RPC failed; HTTP 403`), the refusal wins.
 */
export function classifyForgeRefusal(text: string): ForgeRefusal | null {
  // Rate limits are THROTTLING, not refusal: GitHub answers them with a 403
  // ("secondary rate limit", "API rate limit exceeded") that clears by itself,
  // so they keep their retries.
  if (RATE_LIMITED.test(text)) return null;
  const workflow = /refusing to allow an? (?:personal access token|oauth app|github app)[^\n]*?(?:create or update )?workflow [`'"]?([^`'"\s)]+)/i.exec(text);
  if (workflow) return { kind: 'workflow_scope', workflowFile: workflow[1] };

  // GitHub's own phrasings only — never a bare "sso"/"saml", which a repository
  // or branch NAME carries (`acme/sso-gateway`, `lazy/saml-login`).
  if (SSO_REFUSAL.test(text)) {
    const url = /(https:\/\/github\.com\/(?:orgs\/[^/\s]+\/)?sso\?[^\s'")]+|https:\/\/github\.com\/orgs\/[^/\s]+\/sso[^\s'")]*)/i.exec(text)?.[1];
    const org = /orgs\/([^/\s?]+)\/sso/i.exec(text)?.[1]
      ?? /the ['"`]?([^'"`\s]+)['"`]? organization/i.exec(text)?.[1];
    return { kind: 'sso_required', ...(org ? { org } : {}), ...(url ? { ssoUrl: url } : {}) };
  }
  if (/protected branch|GH006|GH013|branch is protected|you are not allowed to (?:force )?push code to protected branches|changes must be made through a pull request/i.test(text)) {
    return { kind: 'protected_branch' };
  }
  if (/permission to [^\s]+ denied|(?:returned error|http(?:\/[\d.]+)?|status(?: code)?|error):? 403\b|\b403 forbidden|write access to repository not granted|you are not allowed to push|insufficient_scope|not allowed to push code/i.test(text)) {
    return { kind: 'forbidden' };
  }
  // git ASKED for a username and had nobody to ask: no credential was offered
  // at all (no token in the environment for the helper to hand over). That is
  // not a refused token, and "reconnect with a fresh token" would send the
  // reader after one that does not exist.
  if (/could not read username|terminal prompts disabled/i.test(text)) {
    return { kind: 'missing_credential' };
  }
  if (/authentication failed|invalid username or password|(?:returned error|http(?:\/[\d.]+)?|status(?: code)?|error):? 401\b|\b401 unauthorized|bad credentials|http basic: access denied/i.test(text)) {
    return { kind: 'unauthorized' };
  }
  if (/repository not found|(?:returned error|http(?:\/[\d.]+)?|status(?: code)?|error):? 404\b|\b404 not found|does not appear to be a git repository|project you were looking for could not be found/i.test(text)) {
    return { kind: 'not_found' };
  }
  if (/\(non-fast-forward\)|\(fetch first\)|updates were rejected because/i.test(text)) {
    return { kind: 'non_fast_forward' };
  }
  if (/\[remote rejected\]|pre-receive hook declined|! \[rejected\]/i.test(text)) {
    return { kind: 'rejected' };
  }
  return null;
}

/** The one plain fix for a refusal, worded for the forge it came from. */
export function forgeRefusalFix(refusal: ForgeRefusal, forge: Forge = 'github'): string {
  const label = forge === 'gitlab' ? 'GitLab' : 'GitHub';
  switch (refusal.kind) {
    case 'workflow_scope':
      return `The token needs the \`workflow\` scope (classic token) or "Workflows: Read and write" (fine-grained token), ` +
        `because this branch changes ${refusal.workflowFile ? `\`${refusal.workflowFile}\`` : 'a file under `.github/workflows/`'}.`;
    case 'sso_required':
      return `Authorize this token for ${refusal.org ? `the ${refusal.org} organization's` : "the organization's"} SSO on GitHub ` +
        `(Settings → Developer settings → Tokens → Configure SSO)${refusal.ssoUrl ? `: ${refusal.ssoUrl}` : ''}.`;
    case 'protected_branch':
      return `The branch is protected on ${label}: this push is not allowed by its rules. Merge through a pull request, ` +
        `or ask a repository admin to allow this identity to push there.`;
    case 'forbidden':
      return forge === 'gitlab'
        ? 'The token can read the repository but not push. It needs the write_repository scope (and api for merge requests), and the account needs Developer access or above.'
        : 'The token can read the repository but not push. A fine-grained token needs "Contents: Read and write" (and "Pull requests: Read and write") for this repository; a classic token needs the repo scope.';
    case 'unauthorized':
      return `The ${label} token was refused — it is expired, revoked or mistyped. Reconnect the ${label} account with a fresh token.`;
    case 'missing_credential':
      return `No ${label} credential was offered, so the push could not authenticate. Connect your ${label} account (Account settings → Forge connections), or have a team admin set the team's ${label} integration.`;
    case 'not_found':
      return `${label} says the repository does not exist for this identity. Check the project's repository URL, and that the token is granted access to this repository.`;
    case 'non_fast_forward':
      return 'The remote branch has commits this one does not. Sync the task to bring them in, then push again.';
    case 'rejected':
      return `${label} refused the push; its message says why.`;
  }
}
