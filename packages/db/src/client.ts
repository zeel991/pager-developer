import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePg } from 'drizzle-orm/postgres-js';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import postgres from 'postgres';
import * as schema from './schema.js';

/**
 * Two drivers, one schema.
 *
 * `postgres://...` uses a real server — this is the production and docker-compose
 * path. `pglite://<dir>` or `pglite://memory` runs Postgres compiled to WASM in this
 * process, which is what local development and the test suite use: it needs no
 * daemon, so an evaluation run cannot be blocked on infrastructure being up.
 *
 * Both go through the same Drizzle schema and the same queries. PGlite is real
 * Postgres, not a SQLite-shaped approximation, so a query that works in tests works
 * against the server.
 */

export type Database =
  | ReturnType<typeof drizzlePg<typeof schema>>
  | ReturnType<typeof drizzlePglite<typeof schema>>;

export interface DatabaseHandle {
  db: Database;
  /** Underlying PGlite instance, when the pglite driver is in use. */
  pglite: PGlite | null;
  close(): Promise<void>;
}

export function isPgliteUrl(url: string): boolean {
  return url.startsWith('pglite://');
}

export async function createDatabase(
  url: string,
  opts: { max?: number } = {},
): Promise<DatabaseHandle> {
  if (isPgliteUrl(url)) {
    const target = url.slice('pglite://'.length);
    const client = new PGlite(target === 'memory' || target === '' ? undefined : target);
    await client.waitReady;
    return {
      db: drizzlePglite(client, { schema }),
      pglite: client,
      close: () => client.close(),
    };
  }

  const sql = postgres(url, { max: opts.max ?? 10, onnotice: () => {} });
  return {
    db: drizzlePg(sql, { schema }),
    pglite: null,
    close: () => sql.end({ timeout: 5 }),
  };
}

export { schema };
