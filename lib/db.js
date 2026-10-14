// Postgres access for Vercel functions: Neon's HTTP driver, one round trip per query,
// parameterised statements only. Tests inject any `query(text, params) -> rows`.
import { neon } from '@neondatabase/serverless';

const clients = new Map();

export function sqlClient(url) {
  if (!clients.has(url)) {
    const sql = neon(url, { fetchOptions: { cache: 'no-store' } });
    clients.set(url, (text, params = []) => sql.query(text, params));
  }
  return clients.get(url);
}
