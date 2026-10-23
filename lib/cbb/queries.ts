import 'server-only';
import { db, selectAll } from '../supabase';

export async function cbbTeamMap() {
  const teams = await selectAll<any>((a, b) => db().from('cbb_teams').select('id,school,logo,conference,d1').range(a, b));
  return new Map<number, any>(teams.map((t) => [t.id, t]));
}

export async function latestCbbRatings(season: number) {
  const { data } = await db().from('cbb_ratings').select('as_of').eq('season', season).order('as_of', { ascending: false }).limit(1);
  const asOf = data?.[0]?.as_of as string | undefined;
  if (!asOf) return { asOf: null, rows: [] as any[] };
  const rows = await selectAll<any>((a, b) => db().from('cbb_ratings').select('*').eq('season', season).eq('as_of', asOf).range(a, b));
  return { asOf, rows };
}
