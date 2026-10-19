/**
 * A fetch that failed because the branch is not on the remote at all.
 *
 * git says "couldn't find remote ref <branch>" for that, and it is an answer,
 * not a connectivity problem: retrying cannot change it, and the generic
 * "check your network connection / --offline-override" advice sends the reader
 * after the wrong thing. Drivers throw this instead, without retrying, so the
 * caller can say what is actually true ("branch X does not exist on origin")
 * and, for a lazy task branch, fall back to the local branch.
 */
export class RemoteBranchMissingError extends Error {
  constructor(readonly branch: string, readonly remote: string) {
    super(`Branch ${branch} does not exist on ${remote}.`);
    this.name = 'RemoteBranchMissingError';
  }
}

/** Whether git's fetch stderr says the ref is not on the remote. */
export function isRemoteRefMissing(stderr: string): boolean {
  const s = stderr.toLowerCase();
  return s.includes("couldn't find remote ref") || s.includes('no such remote ref');
}
