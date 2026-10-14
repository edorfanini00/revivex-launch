// Applies db/migrations/*.sql (idempotent) to the database in DATABASE_URL.
// Usage: DATABASE_URL=postgres://... node scripts/crm/migrate.mjs
// Run by an operator before deploying code that needs the tables; never on cold start.
import fs from 'node:fs';
import { neon } from '@neondatabase/serverless';

export function splitStatements(sqlText) {
  return sqlText
    .split('\n').map(l => l.replace(/--.*$/, '')).join('\n')
    .split(/;\s*(?:\n|$)/).map(s => s.trim()).filter(Boolean);
}

export function migrationFiles() {
  const dir = new URL('../../db/migrations/', import.meta.url);
  return fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort().map(f => ({ name: f, sql: fs.readFileSync(new URL(f, dir), 'utf8') }));
}

export async function migrate(query) {
  for (const { name, sql } of migrationFiles()) {
    for (const stmt of splitStatements(sql)) await query(stmt, []);
    console.log(`applied ${name}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL is required'); process.exit(1); }
  const sql = neon(url);
  await migrate((t, p) => sql.query(t, p));
  const tables = await sql.query("select table_name from information_schema.tables where table_schema = 'public' order by 1");
  console.log('tables:', tables.map(t => t.table_name).join(', '));
}
