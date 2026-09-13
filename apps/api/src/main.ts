import cors from '@fastify/cors';
import Fastify from 'fastify';
import { openDatabase } from './db.ts';
import { registerRoutes } from './routes.ts';

const PORT = Number(process.env.PAGER_API_PORT ?? 4000);

async function main(): Promise<void> {
  const handle = await openDatabase();
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'warn' } });

  // The dashboard is served from a different origin in development.
  await app.register(cors, { origin: true });
  await registerRoutes(app, { db: handle.db });

  const shutdown = async (): Promise<void> => {
    await app.close();
    await handle.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  await app.listen({ port: PORT, host: '127.0.0.1' });
  console.log(`Pager Developer API listening on http://127.0.0.1:${PORT}`);
  console.log(`  database ${process.env.DATABASE_URL ?? 'pglite://.pager/db'}`);
}

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
