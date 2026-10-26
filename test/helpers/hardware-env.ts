/** Hardware fixtures supply their own lazy launch state, on hosts and in agents. */
export function hardwareTestEnv(
  overrides: Record<string, string | undefined> = {},
  inherited: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  return {
    ...Object.fromEntries(Object.entries(inherited).filter(([key]) => !key.startsWith('LAZY_'))),
    ...overrides,
  };
}
