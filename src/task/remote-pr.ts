import type { Task } from '../types';

export function remotePrUrl(task: Task): string | null {
  const metadata = task.metadata;
  const candidate = metadata?.github_remote_ref_url ?? metadata?.gitlab_remote_ref_url
    ?? metadata?.remote_ref_url ?? metadata?.github_pr_url;
  if (typeof candidate !== 'string') return null;
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}
