/**
 * Quote one argument for a shell command the human will paste.
 *
 * A file path with a space or a quote in it is exactly the case where
 * hand-reconstruction goes wrong, so the composed command must survive it.
 */
export function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}
