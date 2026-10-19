/**
 * A JWT-shaped login token as a Lazy Teams install behind a proxy hands out,
 * naming `iss`. Unsigned (the signature segment is filler): the CLI reads the
 * claims to check WHICH install issued a token and never verifies a signature —
 * that is the proxy's job.
 */
export function fakeTeamsJwt(iss: string): string {
  const seg = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  return [seg({ alg: 'RS256', typ: 'JWT' }), seg({ iss, aud: 'lazy-teams-cli', sub: '1' }), 'c2lnbmF0dXJl'].join('.');
}
