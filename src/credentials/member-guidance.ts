const MEMBER_HOW_TO_GET: Record<string, string> = {
  openai: 'An API key from platform.openai.com/api-keys.',
  openrouter: 'An API key from openrouter.ai/keys.',
  fireworks: 'An API key from app.fireworks.ai.',
  ollama: 'An API key from ollama.com.',
  cursor: 'An API key from the Cursor dashboard.',
  anthropic: 'A `claude setup-token` token, or an API key from the Anthropic console.',
};

export function memberCredentialGuidance(credential: string, session: boolean): string {
  if (session) {
    return 'Run `codex login` (or `codex login --device-auth`) on your own machine and paste the contents of ' +
      '~/.codex/auth.json. Use a login made for this purpose: lazy renews it, which signs out any other copy.';
  }
  return MEMBER_HOW_TO_GET[credential] ??
    'The API key (or token) this endpoint accepts — ask whoever runs that service.';
}
