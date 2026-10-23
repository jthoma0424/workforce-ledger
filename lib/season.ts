import { db } from './supabase';

/** CFB seasons run Aug–Jan; January bowl games belong to the prior season. */
export function currentSeason(now = new Date()): number {
  if (process.env.SEASON) return Number(process.env.SEASON);
  return now.getUTCMonth() >= 5 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
}

/**
 * The "model week" = the next week with unplayed games. Ratings computed for
 * week N use only results through week N-1.
 */
export async function currentWeek(season: number, now = new Date()): Promise<{ week: number; seasonType: string }> {
  const { data } = await db()
    .from('calendar')
    .select('week,season_type,start_date,end_date')
    .eq('season', season)
    .order('start_date', { ascending: true });
  const rows = data ?? [];
  if (!rows.length) return { week: 1, seasonType: 'regular' };
  const iso = now.toISOString();
  const row = rows.find((r) => r.end_date && r.end_date >= iso) ?? rows[rows.length - 1];
  // Postseason weeks are numbered 1.. in CFBD; map them after the regular season.
  if (row.season_type === 'postseason') {
    const maxReg = Math.max(...rows.filter((r) => r.season_type === 'regular').map((r) => r.week));
    return { week: maxReg + row.week, seasonType: 'postseason' };
  }
  return { week: row.week, seasonType: row.season_type };
}

/** Convert a CFBD (week, seasonType) to our continuous model week. */
export function modelWeek(week: number, seasonType: string, maxRegularWeek: number) {
  return seasonType === 'postseason' ? maxRegularWeek + week : week;
}
