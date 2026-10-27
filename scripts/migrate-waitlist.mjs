// Creates the waitlist tables (revivex_waitlist, revivex_waitlist_rate) if they do not
// exist. Additive and idempotent: production and previews share this database, so it
// never drops, renames or alters anything that already exists.
//
//   DATABASE_URL=... node scripts/migrate-waitlist.mjs           apply, then describe
//   DATABASE_URL=... node scripts/migrate-waitlist.mjs --check   describe only, no changes
import { MIGRATION_SQL, neonDb } from '../lib/waitlist.js';

const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set'); process.exit(2); }
const check = process.argv.includes('--check');
const db = await neonDb(url);

const describe = async () => {
  const tables = await db.query(
    `select table_name from information_schema.tables where table_schema = 'public' and table_name in ('revivex_waitlist', 'revivex_waitlist_rate') order by 1`, []);
  const cols = await db.query(
    `select column_name, data_type from information_schema.columns where table_schema = 'public' and table_name = 'revivex_waitlist' order by ordinal_position`, []);
  const idx = await db.query(`select indexname from pg_indexes where schemaname = 'public' and tablename = 'revivex_waitlist' order by 1`, []);
  return { tables: tables.map(r => r.table_name), columns: cols.map(r => `${r.column_name}:${r.data_type}`), indexes: idx.map(r => r.indexname) };
};

if (!check) {
  // One statement per call (the HTTPS driver runs single statements).
  for (const stmt of MIGRATION_SQL.split(';').map(s => s.trim()).filter(Boolean)) await db.query(stmt, []);
}
console.log(JSON.stringify({ applied: !check, ...(await describe()) }, null, 2));
