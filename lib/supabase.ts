import 'server-only';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;

/** Server-only Supabase client using the service-role key (bypasses RLS). */
export function db(): SupabaseClient {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  client = createClient(url, key, { auth: { persistSession: false } });
  return client;
}

/** Throw on Supabase errors so jobs fail loudly. */
export function check<T>(res: { data: T; error: { message: string } | null }, ctx: string): T {
  if (res.error) throw new Error(`${ctx}: ${res.error.message}`);
  return res.data;
}

/** Upsert in chunks (PostgREST payload limits). */
export async function upsertChunked(table: string, rows: object[], onConflict: string, size = 500) {
  for (let i = 0; i < rows.length; i += size) {
    const res = await db().from(table).upsert(rows.slice(i, i + size), { onConflict });
    if (res.error) throw new Error(`upsert ${table}: ${res.error.message}`);
  }
}

export async function insertChunked(table: string, rows: object[], size = 500) {
  for (let i = 0; i < rows.length; i += size) {
    const res = await db().from(table).insert(rows.slice(i, i + size));
    if (res.error) throw new Error(`insert ${table}: ${res.error.message}`);
  }
}

/** Fetch every row of a query, paging past the 1000-row default limit. */
export async function selectAll<T = any>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>,
  page = 1000,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += page) {
    const { data, error } = await build(from, from + page - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < page) break;
  }
  return out;
}
