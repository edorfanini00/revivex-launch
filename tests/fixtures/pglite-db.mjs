// LOCAL database for tests: PGlite (real Postgres compiled to WebAssembly, in memory)
// with the citext extension, exposed through the same { query(text, params) -> rows }
// shape the Neon driver gives lib/waitlist.js. Never touches the shared Neon database.
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { MIGRATION_SQL } from '../../lib/waitlist.js';

export async function createTestDb({ migrate = true } = {}) {
  const pg = new PGlite({ extensions: { citext } });
  const calls = [];
  let failNext = null;
  const db = {
    calls,
    failNext(err) { failNext = err; },
    async query(text, params = []) {
      calls.push(text.trim().split(/\s+/).slice(0, 3).join(' '));
      if (failNext) { const e = failNext; failNext = null; throw e; }
      return (await pg.query(text, params)).rows;
    },
  };
  const runMigration = () => pg.exec(MIGRATION_SQL);
  if (migrate) await runMigration();
  return { pg, db, runMigration, rows: async () => (await pg.query('select * from revivex_waitlist order by id')).rows };
}
