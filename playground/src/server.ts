// Entry point: `bun run src/server.ts`. PORT and DATABASE are the only settings.

import { createApp } from './app';
import { Store } from './store';

const port = Number(process.env.PORT ?? 3000);
const database = process.env.DATABASE ?? 'linkshelf.sqlite';

const store = new Store(database);
const server = Bun.serve({ port, hostname: '0.0.0.0', fetch: createApp(store) });

console.log(`linkshelf listening on http://localhost:${server.port} (database: ${database})`);
