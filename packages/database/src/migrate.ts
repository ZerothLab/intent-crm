import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createDatabase, type Database } from './index.js';
export async function migrate(db: Database) {
  await db.transaction(async tx => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('intent_migrations'))");
    await tx.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    const folder = fileURLToPath(new URL('../migrations/', import.meta.url));
    for (const version of (await readdir(folder)).filter(f => f.endsWith('.sql')).sort()) {
      const source = await readFile(resolve(folder, version), 'utf8');
      const checksum = createHash('sha256').update(source).digest('hex');
      const prior = (await tx.query('SELECT checksum FROM schema_migrations WHERE version=$1',[version])).rows[0];
      if (prior) { if (prior.checksum !== checksum) throw new Error(`Migration checksum changed: ${version}`); continue; }
      await tx.query(source);
      await tx.query('INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)',[version,checksum]);
    }
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const url = process.env.DATABASE_URL; if (!url) throw new Error('DATABASE_URL is required');
  const db=createDatabase(url); try { await migrate(db); console.info('Database migrations applied.'); } finally { await db.close(); }
}
