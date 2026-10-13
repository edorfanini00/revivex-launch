// LOCAL ONLY: an in-process Postgres (PGlite) with the CRM migration applied, so the
// real SQL in lib/crm-store.js runs in unit tests without a network or a server.
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { migrate } from '../../scripts/crm/migrate.mjs';

export async function createTestDb() {
  const pg = await PGlite.create({ extensions: { citext } });
  const query = async (text, params = []) => (await pg.query(text, params)).rows;
  const log = console.log;
  console.log = () => {};
  try { await migrate(query); } finally { console.log = log; }
  return { pg, query, close: () => pg.close() };
}
