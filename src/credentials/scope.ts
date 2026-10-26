import { join } from 'path';
import { getCredentialIndexPath, getCredentialsPath, getDaemonBaseDir } from '../daemon/paths';

/** A project keeps its existing identity; a set has a path-independent identity. */
export type CredentialScope = string | { set: string };

export function validateSetName(name: string): string {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) {
    throw new Error(`Invalid credential set name "${name}". Use 1–64 lowercase letters, digits, . _ -, starting with a letter or digit.`);
  }
  return name;
}

export function credentialSetsDir(): string {
  return join(getDaemonBaseDir(), 'credential-sets');
}

export function credentialSetDir(name: string): string {
  return join(credentialSetsDir(), validateSetName(name));
}

export function credentialIndexPath(scope: CredentialScope): string {
  return typeof scope === 'string' ? getCredentialIndexPath(scope) : join(credentialSetDir(scope.set), 'credential-index.json');
}

export function credentialSecretsPath(scope: CredentialScope): string {
  return typeof scope === 'string' ? getCredentialsPath(scope) : join(credentialSetDir(scope.set), 'credentials.json');
}
