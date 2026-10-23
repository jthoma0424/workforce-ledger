import { db, insertChunked, selectAll, upsertChunked } from '../supabase';
import { aliasesForTeam, NameResolver, normalizeName } from '../names';

const BASE = 'https://api.collegebasketballdata.com';
export const CBB_TABLES = { aliases: 'cbb_aliases', teams: 'cbb_teams', unmatched: 'cbb_unmatched' };

/** CollegeBasketballData client. Same account/tier as CollegeFootballData (shared quota). */
export async function cbbd<T = any>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
  const key = process.env.CBBD_API_KEY || process.env.CFBD_API_KEY;
  if (!key) throw new Error('CFBD_API_KEY (or CBBD_API_KEY) not set');
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, String(v));
  const res = await fetch(`${BASE}${path}?${qs}`, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, cache: 'no-store' });
  if (!res.ok) throw new Error(`CBBD ${path} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<T>;
}

const num = (v: any): number | null => (v === null || v === undefined || v === '' || isNaN(Number(v)) ? null : Number(v));

/** Eastern-time calendar date (YYYY-MM-DD) for a timestamp. */
export function etDate(d: Date | string | number = new Date()): string {
  return new Date(d).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Season label used by CBBD = the year the season ends (Nov 2026 → 2027). Overridable with CBB_SEASON. */
export function cbbSeasonGuess(now = new Date()): number {
  if (process.env.CBB_SEASON) return Number(process.env.CBB_SEASON);
  return now.getUTCMonth() >= 6 ? now.getUTCFullYear() + 1 : now.getUTCFullYear();
}
/** Prefer the season number CBBD itself attached to games around today. */
export async function cbbCurrentSeason(): Promise<number> {
  if (process.env.CBB_SEASON) return Number(process.env.CBB_SEASON);
  const today = etDate();
  const { data } = await db().from('cbb_games').select('season,game_date').lte('game_date', addDays(today, 30)).order('game_date', { ascending: false }).limit(1);
  return data?.[0]?.season ?? cbbSeasonGuess();
}

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------
const CBB_VARIANTS: Record<string, string> = {
  'UConn': 'UConn', 'Connecticut': 'UConn', 'Ole Miss': 'Ole Miss', 'Mississippi': 'Ole Miss', 'Pitt': 'Pittsburgh',
  'Miami (FL)': 'Miami', 'Miami FL': 'Miami', 'Miami Florida': 'Miami', 'Miami (OH)': 'Miami (OH)', 'Miami Ohio': 'Miami (OH)',
  'UNC': 'North Carolina', 'NC State': 'NC State', 'N.C. State': 'NC State', 'North Carolina State': 'NC State',
  'USC': 'USC', 'Southern California': 'USC', 'LSU': 'LSU', 'BYU': 'BYU', 'SMU': 'SMU', 'TCU': 'TCU', 'UCF': 'UCF',
  'VCU': 'VCU', 'UNLV': 'UNLV', 'UAB': 'UAB', 'UTEP': 'UTEP', 'UTSA': 'UTSA', 'Saint Mary\'s': 'Saint Mary\'s',
  "St. Mary's (CA)": "Saint Mary's", "Saint Mary's (CA)": "Saint Mary's", 'Loyola Chicago': 'Loyola Chicago', 'Loyola (Chi)': 'Loyola Chicago',
  'Hawaii': "Hawai'i", 'San Jose State': 'San José State', 'UMass': 'Massachusetts', 'App State': 'Appalachian State',
  'FAU': 'Florida Atlantic', 'FIU': 'Florida International', 'ETSU': 'East Tennessee State', 'UNCW': 'UNC Wilmington',
  'UIC': 'UIC', 'Illinois Chicago': 'UIC', 'SIUE': 'SIU Edwardsville', 'Texas A&M-CC': 'Texas A&M-Corpus Christi',
};

export async function syncCbbTeams(season: number) {
  let teams = await cbbd<any[]>('/teams', { season });
  if (!teams.length) teams = await cbbd<any[]>('/teams'); // season label not published yet
  // D1 = teams with an adjusted rating last season or this season (CBBD only rates D1)
  const d1 = new Set<number>();
  for (const s of [season, season - 1]) {
    const adj = await cbbd<any[]>('/ratings/adjusted', { season: s }).catch(() => [] as any[]);
    for (const r of adj) if (r.teamId) d1.add(r.teamId);
  }
  const rows = teams.filter((t) => t.id && t.school).map((t) => ({
    id: t.id, school: t.school, mascot: t.mascot ?? null, abbreviation: t.abbreviation ?? null,
    display_name: t.displayName ?? null, conference: t.conference ?? null, logo: t.logos?.[0] ?? null,
    d1: d1.size ? d1.has(t.id) : !!t.conference, updated_at: new Date().toISOString(),
  }));
  await upsertChunked('cbb_teams', rows, 'id');

  const aliasMap = new Map<string, { team_id: number; r: number }>();
  for (const t of rows) {
    const names = aliasesForTeam({ id: t.id, school: t.school, mascot: t.mascot, alt_names: [t.display_name, t.abbreviation].filter((x): x is string => !!x && x.length > 3), classification: null });
    for (const a of names) {
      const r = t.d1 ? 0 : 1;
      const prev = aliasMap.get(a);
      if (!prev || r < prev.r) aliasMap.set(a, { team_id: t.id, r });
    }
  }
  const bySchool = new Map(rows.map((t) => [t.school, t.id]));
  for (const [variant, school] of Object.entries(CBB_VARIANTS)) {
    const id = bySchool.get(school);
    if (id) aliasMap.set(normalizeName(variant), { team_id: id, r: -1 });
  }
  const manual = await selectAll<{ alias: string }>((a, b) => db().from('cbb_aliases').select('alias').eq('source', 'manual').range(a, b));
  const manualSet = new Set(manual.map((m) => m.alias));
  const aliasRows = [...aliasMap.entries()].filter(([a]) => !manualSet.has(a)).map(([alias, v]) => ({ alias, team_id: v.team_id, source: 'auto' }));
  await upsertChunked('cbb_aliases', aliasRows, 'alias');
  return { teams: rows.length, d1: rows.filter((r) => r.d1).length, aliases: aliasRows.length };
}

// ---------------------------------------------------------------------------
// Games + possessions
// ---------------------------------------------------------------------------
export async function syncCbbGames(from: string, to: string) {
  const known = new Set((await selectAll<{ id: number }>((a, b) => db().from('cbb_teams').select('id').range(a, b))).map((t) => t.id));
  let games = 0, boxes = 0;
  // 7-day windows keep each response small
  for (let start = from; start <= to; start = addDays(start, 7)) {
    const end = addDays(start, 7) < addDays(to, 1) ? addDays(start, 7) : addDays(to, 1);
    const g = await cbbd<any[]>('/games', { startDateRange: `${start}T05:00:00Z`, endDateRange: `${end}T05:00:00Z` });
    const rows = g
      .filter((x) => known.has(x.homeTeamId) && known.has(x.awayTeamId))
      .map((x) => {
        const status = String(x.status ?? '').toLowerCase();
        return {
          id: x.id, season: x.season, season_type: x.seasonType ?? null, start_date: x.startDate, game_date: etDate(x.startDate),
          neutral_site: !!x.neutralSite, conference_game: !!x.conferenceGame, tournament: x.tournament ?? null,
          home_id: x.homeTeamId, away_id: x.awayTeamId, home_points: num(x.homePoints), away_points: num(x.awayPoints),
          status, completed: status === 'final' && num(x.homePoints) !== null, updated_at: new Date().toISOString(),
        };
      });
    await upsertChunked('cbb_games', rows, 'id');
    games += rows.length;

    // Box scores only exist for games already played
    if (start <= etDate()) {
      const b = await cbbd<any[]>('/games/teams', { startDateRange: `${start}T05:00:00Z`, endDateRange: `${end}T05:00:00Z` });
      const byGame = new Map<number, { home?: number; away?: number }>();
      for (const r of b) {
        const p = num(r.teamStats?.possessions);
        if (p === null || !r.gameId) continue;
        const e = byGame.get(r.gameId) ?? {};
        if (r.isHome) e.home = p; else e.away = p;
        byGame.set(r.gameId, e);
      }
      const statRows = [...byGame.entries()].map(([game_id, e]) => {
        const vals = [e.home, e.away].filter((v): v is number => v !== undefined);
        return { game_id, home_poss: e.home ?? null, away_poss: e.away ?? null, possessions: vals.reduce((s, v) => s + v, 0) / vals.length };
      });
      await upsertChunked('cbb_game_stats', statRows, 'game_id');
      boxes += statRows.length;
    }
  }
  return { games, boxScores: boxes };
}

// ---------------------------------------------------------------------------
// External ratings
// ---------------------------------------------------------------------------
async function saveSource(season: number, asOf: string, source: string, rows: { team_id: number; offense: number | null; defense: number | null; tempo: number | null; raw?: any }[]) {
  const seen = new Set<number>();
  const clean = rows.filter((r) => r.team_id && !seen.has(r.team_id) && (seen.add(r.team_id), true))
    .map((r) => ({ season, as_of: asOf, source, team_id: r.team_id, offense: r.offense, defense: r.defense, tempo: r.tempo, raw: r.raw ?? null, fetched_at: new Date().toISOString() }));
  await upsertChunked('cbb_source_ratings', clean, 'season,as_of,source,team_id');
  return clean.length;
}

/** CBBD opponent-adjusted efficiency (this season) + team pace. */
export async function syncCbbdRatings(season: number) {
  const asOf = etDate();
  const [adj, stats] = await Promise.all([
    cbbd<any[]>('/ratings/adjusted', { season }),
    cbbd<any[]>('/stats/team/season', { season }).catch(() => [] as any[]),
  ]);
  const pace = new Map(stats.map((s) => [s.teamId, num(s.pace)]));
  const n = await saveSource(season, asOf, 'cbbd', adj.map((r) => ({
    team_id: r.teamId, offense: num(r.offensiveRating), defense: num(r.defensiveRating), tempo: pace.get(r.teamId) ?? null, raw: r,
  })));
  return { cbbd: n };
}

/** Last season's final ratings, used as this season's starting point. Stored as source 'prev'. */
export async function syncCbbPrior(season: number) {
  const [adj, stats] = await Promise.all([
    cbbd<any[]>('/ratings/adjusted', { season: season - 1 }),
    cbbd<any[]>('/stats/team/season', { season: season - 1 }).catch(() => [] as any[]),
  ]);
  const pace = new Map(stats.map((s) => [s.teamId, num(s.pace)]));
  const n = await saveSource(season, '2000-01-01', 'prev', adj.map((r) => ({
    team_id: r.teamId, offense: num(r.offensiveRating), defense: num(r.defensiveRating), tempo: pace.get(r.teamId) ?? null,
  })));
  return { prior: n };
}

/** Bart Torvik T-Rank team results CSV. Columns found by header name (team, adjoe, adjde, adjt). */
export function parseTorvikCsv(text: string): { team: string; o: number; d: number; t: number | null }[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const split = (l: string) => l.match(/("([^"]|"")*"|[^,]*)(,|$)/g)!.map((c) => c.replace(/,$/, '').replace(/^"|"$/g, '').trim());
  const head = split(lines[0]).map((h) => h.toLowerCase());
  const ti = head.indexOf('team'), oi = head.indexOf('adjoe'), di = head.indexOf('adjde'), pi = head.indexOf('adjt');
  if (ti < 0 || oi < 0 || di < 0) return [];
  const out = [];
  for (const l of lines.slice(1)) {
    const c = split(l);
    const o = Number(c[oi]), d = Number(c[di]), t = pi >= 0 ? Number(c[pi]) : NaN;
    if (c[ti] && Number.isFinite(o) && Number.isFinite(d)) out.push({ team: c[ti], o, d, t: Number.isFinite(t) ? t : null });
  }
  return out;
}

export async function syncTorvik(season: number) {
  const res = await fetch(`https://barttorvik.com/${season}_team_results.csv`, { headers: { 'User-Agent': 'Mozilla/5.0 (personal model)' }, cache: 'no-store' });
  if (!res.ok) throw new Error(`Torvik ${res.status}`);
  const rows = parseTorvikCsv(await res.text());
  if (!rows.length) throw new Error('Torvik CSV parsed 0 rows (layout may have changed)');
  const resolver = await new NameResolver('torvik', CBB_TABLES).load();
  const n = await saveSource(season, etDate(), 'torvik', rows.map((r) => ({ team_id: resolver.resolve(r.team)!, offense: r.o, defense: r.d, tempo: r.t })).filter((r) => r.team_id));
  await resolver.flushMisses();
  return { torvik: n, unmatched: resolver.missCount };
}

/** Pasted "Team, AdjO, AdjD, AdjT" rows (e.g. from KenPom) into the 'manual' source. */
export async function importCbbManual(season: number, text: string) {
  const resolver = await new NameResolver('manual', CBB_TABLES).load();
  const rows: any[] = [];
  for (const line of text.split(/\r?\n/)) {
    const cells = line.split(/\t|,/).map((c) => c.trim().replace(/^"|"$/g, ''));
    const team = cells.find((c) => c && isNaN(Number(c)));
    const nums = cells.filter((c) => c !== '' && !isNaN(Number(c))).map(Number);
    if (!team || nums.length < 2) continue;
    // Accept "rank, team, AdjO, AdjD, AdjT": take the last 2–3 numbers
    const [o, d, t] = nums.length >= 3 ? nums.slice(-3) : [nums[0], nums[1], null];
    const id = resolver.resolve(team);
    if (id) rows.push({ team_id: id, offense: o, defense: d, tempo: t });
  }
  const n = await saveSource(season, etDate(), 'manual', rows);
  await resolver.flushMisses();
  return { imported: n, unmatched: resolver.missCount };
}

// ---------------------------------------------------------------------------
// DraftKings odds (The Odds API)
// ---------------------------------------------------------------------------
export async function syncCbbOdds() {
  const key = process.env.ODDS_API_KEY;
  if (!key) throw new Error('ODDS_API_KEY not set');
  const book = process.env.ODDS_BOOKMAKER || 'draftkings';
  const url = new URL('https://api.the-odds-api.com/v4/sports/basketball_ncaab/odds/');
  url.search = new URLSearchParams({ apiKey: key, regions: 'us', markets: 'spreads,totals', bookmakers: book, oddsFormat: 'american' }).toString();
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Odds API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const remaining = res.headers.get('x-requests-remaining');
  const events: any[] = await res.json();

  const resolver = await new NameResolver('odds_api', CBB_TABLES).load();
  const today = etDate();
  const games = await selectAll<any>((a, b) =>
    db().from('cbb_games').select('id,home_id,away_id,start_date').gte('game_date', addDays(today, -1)).lte('game_date', addDays(today, 7)).range(a, b),
  );
  const latest = await selectAll<any>((a, b) => db().from('cbb_odds_lines').select('*').eq('book', book).gte('captured_at', new Date(Date.now() - 14 * 86400e3).toISOString()).order('captured_at', { ascending: false }).range(a, b));
  const last = new Map<number, any>();
  for (const l of latest) if (!last.has(l.game_id)) last.set(l.game_id, l);

  const rows: any[] = [];
  let matched = 0, unmatched = 0;
  for (const ev of events) {
    const h = resolver.resolve(ev.home_team), a = resolver.resolve(ev.away_team);
    if (!h || !a) { unmatched++; continue; }
    const t = new Date(ev.commence_time).getTime();
    const g = games.find((g) => Math.abs(new Date(g.start_date).getTime() - t) < 36 * 3600e3 &&
      ((g.home_id === h && g.away_id === a) || (g.home_id === a && g.away_id === h)));
    if (!g) { unmatched++; continue; }
    matched++;
    const bk = ev.bookmakers?.find((b: any) => b.key === book);
    const sp = bk?.markets?.find((m: any) => m.key === 'spreads');
    const to = bk?.markets?.find((m: any) => m.key === 'totals');
    if (!sp && !to) continue;
    const homeName = g.home_id === h ? ev.home_team : ev.away_team;
    const ho = sp?.outcomes?.find((o: any) => o.name === homeName), ao = sp?.outcomes?.find((o: any) => o.name !== homeName);
    const ov = to?.outcomes?.find((o: any) => /^over$/i.test(o.name)), un = to?.outcomes?.find((o: any) => /^under$/i.test(o.name));
    const row = {
      game_id: g.id, book,
      home_spread: ho?.point ?? null, home_price: ho?.price ?? null, away_spread: ao?.point ?? null, away_price: ao?.price ?? null,
      total: ov?.point ?? un?.point ?? null, over_price: ov?.price ?? null, under_price: un?.price ?? null,
    };
    const prev = last.get(g.id);
    const same = (x: any, y: any) => (x == null ? null : Number(x)) === (y == null ? null : Number(y));
    if (prev && (['home_spread', 'home_price', 'away_price', 'total', 'over_price', 'under_price'] as const).every((k) => same(prev[k], (row as any)[k]))) continue;
    rows.push(row);
  }
  if (rows.length) await insertChunked('cbb_odds_lines', rows);
  await resolver.flushMisses();
  return { events: events.length, matched, unmatched, newLines: rows.length, creditsRemaining: remaining };
}
