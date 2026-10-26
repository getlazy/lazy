// Only the external token endpoint is replaced; resolution and persistence are real.
import { resolveChatGptSession } from '../../src/credentials/chatgpt-session';
import { CHATGPT_TOKEN_URL } from '../../src/credentials/chatgpt-tokens';

const [root, endpoint] = process.argv.slice(2);
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input, init) => {
  if (String(input) !== CHATGPT_TOKEN_URL) throw new Error('Unexpected request in session renewal fixture');
  return realFetch(endpoint!, init);
}) as typeof fetch;

const session = await resolveChatGptSession(root!);
if (!session) throw new Error('The shared session was not resolved');
