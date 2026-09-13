import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createDatabase, type DatabaseHandle } from '@pager/db';

/**
 * Database bootstrap for the API process.
 *
 * The API owns the database connection. With PGlite that is a hard requirement —
 * it is an embedded engine and only one process may hold a data directory — which
 * is why the dashboard reads through this API rather than opening the store itself.
 */

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const MIGRATIONS = join(REPO_ROOT, 'packages', 'db', 'migrations');

// Relative pglite paths resolve against the repository root, so `pnpm api` and
// `pnpm api:seed` address the same store regardless of where they are invoked.
process.env.PAGER_DATA_ROOT ??= REPO_ROOT;

export const DEFAULT_DATABASE_URL = 'pglite://.pager/db';

export async function openDatabase(url = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL): Promise<DatabaseHandle> {
  const handle = await createDatabase(url);
  await applyMigrations(handle);
  return handle;
}

export async function applyMigrations(handle: DatabaseHandle): Promise<void> {
  const file = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()[0]!;
  const statements = readFileSync(join(MIGRATIONS, file), 'utf8').split('--> statement-breakpoint');

  for (const statement of statements) {
    const sql = statement.trim();
    if (!sql) continue;
    try {
      if (handle.pglite) await handle.pglite.exec(sql);
      else await handle.db.execute(sql as never);
    } catch (err) {
      // Idempotent: the API restarts against an existing database routinely.
      if (!/already exists/i.test(String(err))) throw err;
    }
  }
}
