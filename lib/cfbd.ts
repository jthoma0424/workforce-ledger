import { db, insertChunked, selectAll, upsertChunked } from './supabase';
import { aliasesForTeam, KNOWN_VARIANTS, NameResolver, normalizeName } from './names';
import { modelWeek } from './season';

const BASE = 'https://api.collegefootballdata.com';

/** Minimal CFBD v2 client. Free tier is ~1,000 calls/month, so jobs are frugal. */
export async function cfbd<T = any>(path: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
  const key = process.env.CFBD_API_KEY;
  if (!key) throw new Error('CFBD_API_KEY not set');
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, String(v));
  const res = await fetch(`${BASE}${path}?${qs}`, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`CFBD ${path} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<T>;
}

const num = (v: any): number | null => (v === null || v === undefined || v === '' || isNaN(Number(v)) ? null : Number(v));

// ---------------------------------------------------------------------------
// Teams, calendar, games
// ---------------------------------------------------------------------------
export async function syncTeams(season: number) {
  const teams = await cfbd<any[]>('/teams', { year: season });
  const rows = teams
    .filter((t) => t.id && t.school)
    .map((t) => ({
      id: t.id,
      school: t.school,
      mascot: t.mascot ?? null,
      abbreviation: t.abbreviation ?? null,
      conference: t.conference ?? null,
      classification: t.classification ?? null,
      color: t.color ?? null,
      logo: t.logos?.[0] ?? null,
      alt_names: (t.alternateNames ?? t.alt_names ?? [t.alt_name1, t.alt_name2, t.alt_name3]).filter(Boolean),
      updated_at: new Date().toISOString(),
    }));
  // Schools can collide on name across divisions in the raw list; keep the first.
  const seen = new Set<string>();
  const unique = rows.filter((r) => (seen.has(r.school) ? false : (seen.add(r.school), true)));
  await upsertChunked('teams', unique, 'id');

  // Auto aliases. FBS teams win collisions over lower divisions.
  const rank = (c: string | null) => (c === 'fbs' ? 0 : c === 'fcs' ? 1 : 2);
  const aliasMap = new Map<string, { team_id: number; r: number }>();
  for (const t of unique) {
    for (const a of aliasesForTeam(t)) {
      const prev = aliasMap.get(a);
      if (!prev || rank(t.classification) < prev.r) aliasMap.set(a, { team_id: t.id, r: rank(t.classification) });
    }
  }
  const bySchool = new Map(unique.map((t) => [t.school, t.id]));
  for (const [variant, school] of Object.entries(KNOWN_VARIANTS)) {
    const id = bySchool.get(school);
    if (id) aliasMap.set(normalizeName(variant), { team_id: id, r: -1 });
  }
  // Don't overwrite aliases you mapped by hand on the Admin page.
  const manual = await selectAll<{ alias: string }>((a, b) => db().from('team_aliases').select('alias').eq('source', 'manual').range(a, b));
  const manualSet = new Set(manual.map((m) => m.alias));
  const aliasRows = [...aliasMap.entries()]
    .filter(([alias]) => !manualSet.has(alias))
    .map(([alias, v]) => ({ alias, team_id: v.team_id, source: 'auto' }));
  await upsertChunked('team_aliases', aliasRows, 'alias');
  return { teams: unique.length, aliases: aliasRows.length };
}

export async function syncCalendar(season: number) {
  const cal = await cfbd<any[]>('/calendar', { year: season });
  const rows = cal.map((c) => ({
    season,
    week: c.week,
    season_type: c.seasonType ?? c.season_type ?? 'regular',
    start_date: c.startDate ?? c.firstGameStart ?? c.first_game_start,
    end_date: c.endDate ?? c.lastGameStart ?? c.last_game_start,
  }));
  await upsertChunked('calendar', rows, 'season,week,season_type');
  return { weeks: rows.length };
}

async function maxRegularWeek(season: number) {
  const { data } = await db().from('calendar').select('week').eq('season', season).eq('season_type', 'regular').order('week', { ascending: false }).limit(1);
  return data?.[0]?.week ?? 15;
}

export async function syncGames(season: number) {
  const maxReg = await maxRegularWeek(season);
  const known = new Set(
    (await selectAll<{ id: number }>((a, b) => db().from('teams').select('id').range(a, b))).map((t) => t.id),
  );
  let total = 0;
  for (const seasonType of ['regular', 'postseason']) {
    const games = await cfbd<any[]>('/games', { year: season, seasonType, classification: 'fbs' });
    const rows = games
      .map((g) => {
        const homeId = g.homeId ?? g.home_id;
        const awayId = g.awayId ?? g.away_id;
        return {
          id: g.id,
          season,
          week: modelWeek(g.week, seasonType, maxReg),
          season_type: seasonType,
          start_date: g.startDate ?? g.start_date,
          neutral_site: !!(g.neutralSite ?? g.neutral_site),
          conference_game: !!(g.conferenceGame ?? g.conference_game),
          home_id: known.has(homeId) ? homeId : null,
          away_id: known.has(awayId) ? awayId : null,
          home_points: num(g.homePoints ?? g.home_points),
          away_points: num(g.awayPoints ?? g.away_points),
          completed: !!g.completed,
          updated_at: new Date().toISOString(),
        };
      })
      .filter((r) => r.home_id && r.away_id);
    await upsertChunked('games', rows, 'id');
    total += rows.length;
  }
  return { games: total };
}

// ---------------------------------------------------------------------------
// Ratings & advanced stats (snapshotted at the current model week)
// ---------------------------------------------------------------------------
export async function syncRatingsAndStats(season: number, week: number) {
  const resolver = await new NameResolver('cfbd').load();
  const now = new Date().toISOString();
  const out: Record<string, number | string> = {};
  const { data: srcRows } = await db().from('rating_sources').select('key,enabled');
  const enabled = new Set((srcRows ?? []).filter((s) => s.enabled).map((s) => s.key));

  type Item = { team: string; rating: number | null; offense?: number | null; defense?: number | null; raw: any; logMiss?: boolean };
  const save = async (source: string, items: Item[]) => {
    // One row per team: two spellings that resolve to the same team would otherwise
    // make the upsert fail ("cannot affect row a second time").
    const byTeam = new Map<number, any>();
    for (const i of items) {
      if (i.rating === null || !Number.isFinite(i.rating)) continue;
      const team_id = resolver.resolve(i.team, { logMiss: i.logMiss !== false });
      if (!team_id || byTeam.has(team_id)) continue;
      byTeam.set(team_id, {
        season, week, source, team_id, rating: i.rating,
        offense: i.offense ?? null, defense: i.defense ?? null, raw: i.raw, fetched_at: now,
      });
    }
    await upsertChunked('source_ratings', [...byTeam.values()], 'season,week,source,team_id');
    out[source] = byTeam.size;
  };

  const settled = async (name: string, fn: () => Promise<void>) => {
    if (['sp', 'fpi', 'srs', 'elo', 'wepa'].includes(name) && !enabled.has(name)) { out[name] = 'disabled'; return; }
    try {
      await fn();
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      out[`${name}_error`] = /\b(401|403)\b/.test(msg)
        ? 'Not included in your CFBD plan (opponent-adjusted metrics need Patreon Tier 1, $1/mo). Turn this source off on Admin, or upgrade.'
        : msg.slice(0, 200);
      console.error(name, msg);
    }
  };

  await settled('sp', async () => {
    const sp = await cfbd<any[]>('/ratings/sp', { year: season });
    await save('sp', sp.filter((r) => r.team !== 'nationalAverages').map((r) => ({
      team: r.team, rating: num(r.rating), offense: num(r.offense?.rating), defense: num(r.defense?.rating), raw: r,
    })));
  });
  await settled('fpi', async () => {
    const fpi = await cfbd<any[]>('/ratings/fpi', { year: season });
    await save('fpi', fpi.map((r) => ({
      team: r.team, rating: num(r.fpi), offense: num(r.efficiencies?.offense), defense: num(r.efficiencies?.defense), raw: r,
    })));
  });
  await settled('srs', async () => {
    const srs = await cfbd<any[]>('/ratings/srs', { year: season });
    // SRS covers every division; keep FBS/FCS and don't flag lower-division names as unmatched.
    const div = (r: any) => String(r.division ?? r.classification ?? '').toLowerCase();
    await save('srs', srs
      .filter((r) => !div(r) || ['fbs', 'fcs'].includes(div(r)))
      .map((r) => ({ team: r.team, rating: num(r.rating), raw: r, logMiss: div(r) !== 'fcs' })));
  });
  await settled('elo', async () => {
    const elo = await cfbd<any[]>('/ratings/elo', { year: season });
    await save('elo', elo.map((r) => ({ team: r.team, rating: num(r.elo), raw: r })));
  });
  await settled('wepa', async () => {
    const w = await cfbd<any[]>('/wepa/team/season', { year: season });
    await save('wepa', w.map((r) => {
      const off = num(r.epa?.total), def = num(r.epaAllowed?.total);
      return { team: r.team, rating: off !== null && def !== null ? off - def : null, offense: off, defense: def, raw: r };
    }));
  });

  // Raw advanced stats (for the team pages / your own feature work)
  await settled('advanced', async () => {
    const adv = await cfbd<any[]>('/stats/season/advanced', { year: season, excludeGarbageTime: true });
    const rows = adv
      .map((r) => ({ season, week, source: 'cfbd_advanced', team_id: resolver.resolve(r.team), metrics: { offense: r.offense, defense: r.defense }, fetched_at: now }))
      .filter((r) => r.team_id);
    await upsertChunked('team_stats', rows, 'season,week,source,team_id');
    out.advanced = rows.length;
  });

  await resolver.flushMisses();
  return out;
}

// ---------------------------------------------------------------------------
// CFBD betting lines (multiple books incl. consensus; good for backtests)
// ---------------------------------------------------------------------------
export async function syncCfbdLines(season: number) {
  const gameIds = new Set(
    (await selectAll<{ id: number }>((a, b) => db().from('games').select('id').eq('season', season).range(a, b))).map((g) => g.id),
  );
  const latest = await selectAll<any>((a, b) =>
    db().from('latest_lines').select('game_id,book,home_spread,total').like('book', 'cfbd_%').range(a, b),
  );
  const key = (sp: any, tot: any) => `${sp ?? ''}|${tot ?? ''}`;
  const last = new Map(latest.map((l) => [`${l.game_id}|${l.book}`, key(l.home_spread === null ? null : Number(l.home_spread), l.total === null ? null : Number(l.total))]));
  const rows: any[] = [];
  for (const seasonType of ['regular', 'postseason']) {
    const games = await cfbd<any[]>('/lines', { year: season, seasonType });
    for (const g of games) {
      if (!gameIds.has(g.id)) continue;
      for (const l of g.lines ?? []) {
        const spread = num(l.spread);
        const total = num(l.overUnder ?? l.over_under);
        if (spread === null && total === null) continue;
        const book = 'cfbd_' + String(l.provider).toLowerCase().replace(/[^a-z0-9]+/g, '');
        const k = key(spread, total);
        if (last.get(`${g.id}|${book}`) === k) continue;
        last.set(`${g.id}|${book}`, k);
        rows.push({
          game_id: g.id, book,
          home_spread: spread, away_spread: spread === null ? null : -spread, home_price: -110, away_price: -110,
          total, over_price: total === null ? null : -110, under_price: total === null ? null : -110,
        });
      }
    }
  }
  if (rows.length) await insertChunked('odds_lines', rows);
  return { cfbdLines: rows.length };
}
