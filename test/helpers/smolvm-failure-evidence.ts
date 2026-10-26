import { mkdir, readFile, readdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';

/** Carries the collected output even when its durable copy could not be saved. */
export class SmolvmEvidenceSaveError extends Error {
  constructor(readonly report: string, errors: string[]) {
    super(`could not save all smolvm failure evidence: ${errors.join('; ')}`);
  }
}

/** Called from afterEach: Bun timeouts do not run a test callback's catch. */
export async function finishSmolvmHardwareTest(options: {
  succeeded: boolean;
  keepOnFailure: boolean;
  capture: () => Promise<string>;
  cleanup: (keep: boolean) => Promise<void>;
  report?: (message: string) => void;
}): Promise<void> {
  let keep = !options.succeeded && options.keepOnFailure;
  if (!options.succeeded) {
    const report = options.report ?? console.error;
    try { report(await options.capture()); }
    catch (err) {
      keep = true;
      if (err instanceof SmolvmEvidenceSaveError) report(err.report);
      report(`smolvm: retaining the failed fixture because evidence capture failed: ${String(err)}`);
    }
  }
  await options.cleanup(keep);
}

/** Each probe owns its timeout; one broken route must not hide the others. */
export async function saveSmolvmFailureEvidence(
  destination: string,
  probes: Record<string, () => Promise<unknown>>,
): Promise<string> {
  const errors: string[] = [];
  try {
    await rm(destination, { recursive: true, force: true });
    await mkdir(destination, { recursive: true, mode: 0o700 });
  } catch (err) {
    errors.push(`prepare ${destination}: ${String(err)}`);
  }
  const sections = await Promise.all(Object.entries(probes).map(async ([name, probe]) => {
    let value: unknown;
    try { value = await probe(); }
    catch (err) { value = { diagnosticError: err instanceof Error ? err.message : String(err) }; }
    let body: string;
    try { body = typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? String(value); }
    catch (err) {
      body = `could not serialize ${name}: ${String(err)}`;
      errors.push(body);
    }
    // Save each result as soon as it arrives, even if another hardware probe stalls.
    try { await writeFile(join(destination, `${name}.txt`), body, { mode: 0o600 }); }
    catch (err) { errors.push(`save ${name}: ${String(err)}`); }
    return `--- ${name} ---\n${body}`;
  }));
  const report = `smolvm failure evidence: ${destination}\n${sections.join('\n\n')}`;
  try { await writeFile(join(destination, 'report.txt'), report, { mode: 0o600 }); }
  catch (err) { errors.push(`save report: ${String(err)}`); }
  if (errors.length > 0) throw new SmolvmEvidenceSaveError(report, errors);
  return report;
}

/** Read only fixture evidence, never the daemon's token/credential files. */
export async function evidenceFiles(dir: string, include: (name: string) => boolean): Promise<Record<string, unknown>> {
  const files: Record<string, unknown> = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() || entry.isSymbolicLink()) {
      // Protocol mailboxes are symlinks into the project-specific smolvm share.
      // The suite supplies these fixture-only roots; no walk of the project tree.
      try { files[entry.name] = await evidenceFiles(path, include); }
      catch (err) { files[entry.name] = { diagnosticError: String(err) }; }
    } else if (entry.isFile() && include(entry.name)) {
      try { files[entry.name] = await readFile(path, 'utf8'); }
      catch (err) { files[entry.name] = { diagnosticError: String(err) }; }
    }
  }
  return files;
}
