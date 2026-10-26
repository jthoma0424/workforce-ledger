import 'server-only';
import { db, selectAll } from './supabase';
import { currentSeason, currentWeek } from './season';

export async function resolveWeek(sp: { season?: string; week?: string }) {
  const season = sp.season ? Number(sp.season) : currentSeason();
  const week = sp.week ? Number(sp.week) : (await currentWeek(season)).week;
  const wk = await selectAll<{ week: number }>((a, b) => db().from('games').select('week').eq('season', season).range(a, b));
  const weeks = [...new Set(wk.map((g) => g.week))].sort((a, b) => a - b);
  return { season, week, weeks };
}

export async function teamMap() {
  const teams = await selectAll<any>((a, b) => db().from('teams').select('id,school,logo,conference,classification,color').range(a, b));
  return new Map<number, any>(teams.map((t) => [t.id, t]));
}
