import pg, { type PoolClient, type QueryResultRow } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';
// Calendar dates are business dates, not midnight instants in the server timezone.
pg.types.setTypeParser(1082, value => value);
export * from './schema.js';
export type Connection = Pick<PoolClient, 'query'>;
export class Database {
  readonly pool: pg.Pool;
  readonly drizzle;
  constructor(url: string) {
    this.pool = new pg.Pool({ connectionString: url, max: 10, connectionTimeoutMillis: 10000, statement_timeout: 30000, lock_timeout: 10000 });
    this.drizzle = drizzle(this.pool, { schema });
  }
  query<T extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []) { return this.pool.query<T>(text, values); }
  async transaction<T>(work: (connection: Connection) => Promise<T>): Promise<T> {
    const connection = await this.pool.connect();
    try { await connection.query('BEGIN'); const result = await work(connection); await connection.query('COMMIT'); return result; }
    catch (error) { await connection.query('ROLLBACK'); throw error; }
    finally { connection.release(); }
  }
  close() { return this.pool.end(); }
}
export const createDatabase = (url: string) => new Database(url);
