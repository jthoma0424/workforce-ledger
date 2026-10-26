import { db, selectAll, upsertChunked } from '../supabase';
import { betProfit, evaluateSpread, evaluateTotal, fitWeights, gradeSpread, gradeTotal, mean, movRatings, paceFactor, projectScore, scoringRatings, shrinkPace } from './math';

export type Settings = {
  hfa: number; sigma: number; edge_threshold: number; margin_cap: number; prior_weight: number; default_price: number;
  total_sigma: number; total_edge_threshold: number; points_cap: number; pace_weight: number;
};
export type Source = { key: string; name: string; origin: string; scale: number; weight: number; enabled: boolean };

const NON_FBS_DEFAULT = -20; // average FCS team vs. average FBS team, points
const NON_FBS_OD = { o: -10, d: 10 }; // FCS: scores ~10 fewer, allows ~10 more than average FBS
const OD_SOURCES = ['sp', 'wepa', 'tcc_mov']; // sources that carry offense/defense splits

/** Average points per team per game in completed FBS-vs-FBS games before `week`. */
export async function leagueAvgPoints(season: number, week: number, isFbs?: Map<number, boolean>): Promise<number> {
  if (!isFbs) {
    const teams = await selectAll<{ id: number; classification: string | null }>((a, b) => db().from('teams').select('id,classification').range(a, b));
    isFbs = new Map(teams.map((t) => [t.id, t.classification === 'fbs']));
  }
  const games = await selectAll<any>((a, b) =>
    db().from('games').select('home_id,away_id,home_points,away_points').eq('season', season).eq('completed', true).lt('week', week).range(a, b),
  );
  const pts: number[] = [];
  for (const g of games) {
    if (g.home_points === null || !isFbs.get(g.home_id) || !isFbs.get(g.away_id)) continue;
    pts.push(g.home_points, g.away_points);
  }
  return pts.length >= 40 ? mean(pts) : 28;
}

export async function getSettings(): Promise<Settings> {
  const { data } = await db().from('model_settings').select('*').eq('id', 1).single();
  const s = data ?? {};
  return {
    hfa: Number(s.hfa ?? 2.5), sigma: Number(s.sigma ?? 14), edge_threshold: Number(s.edge_threshold ?? 3),
    margin_cap: Number(s.margin_cap ?? 28), prior_weight: Number(s.prior_weight ?? 3), default_price: Number(s.default_price ?? -110),
    total_sigma: Number(s.total_sigma ?? 13.5), total_edge_threshold: Number(s.total_edge_threshold ?? 3), points_cap: Number(s.points_cap ?? 30),
    pace_weight: Number(s.pace_weight ?? 1),
  };
}

export async function getSources(): Promise<Source[]> {
  const { data } = await db().from('rating_sources').select('*').order('key');
  return (data ?? []).map((s) => ({ ...s, scale: Number(s.scale), weight: Number(s.weight) }));
}

/** Weighted mean over whichever sources a team has. */
function blend(components: Record<string, number>, weights: Map<string, number>): number | null {
  let num = 0, den = 0;
  for (const [k, v] of Object.entries(components)) {
    const w = weights.get(k) ?? 0;
    if (w > 0) { num += w * v; den += w; }
  }
  return den > 0 ? num / den : null;
}

/**
 * Plays per game (both teams' snaps) for each team, from the newest CFBD advanced-stats
 * snapshot at or before `week`. Games are counted up to when that snapshot was taken,
 * then each team is shrunk toward the FBS average so early-season numbers aren't extreme.
 */
export async function teamPace(season: number, week: number, isFbs: Map<number, boolean>) {
  const stats = await selectAll<any>((a, b) =>
    db().from('team_stats').select('team_id,week,metrics,fetched_at').eq('season', season).eq('source', 'cfbd_advanced').lte('week', week)
      .order('week', { ascending: false }).range(a, b),
  );
  const latest = new Map<number, any>();
  for (const r of stats) if (!latest.has(r.team_id)) latest.set(r.team_id, r);
  const games = await selectAll<any>((a, b) =>
    db().from('games').select('home_id,away_id,start_date').eq('season', season).eq('completed', true).range(a, b),
  );
  const raw = new Map<number, { ppg: number; games: number }>();
  for (const [id, r] of latest) {
    const plays = Number(r.metrics?.offense?.plays ?? 0) + Number(r.metrics?.defense?.plays ?? 0);
    const asOf = r.fetched_at ? new Date(r.fetched_at).getTime() : Date.now();
    const n = games.filter((g) => (g.home_id === id || g.away_id === id) && new Date(g.start_date).getTime() < asOf).length;
    if (plays > 0 && n > 0) raw.set(id, { ppg: plays / n, games: n });
  }
  const fbs = [...raw.entries()].filter(([id]) => isFbs.get(id)).map(([, v]) => v.ppg);
  const league = fbs.length >= 10 ? mean(fbs) : 0;
  const pace = new Map<number, number>();
  if (league > 0) for (const [id, v] of raw) pace.set(id, shrinkPace(v.ppg, v.games, league));
  return { pace, league };
}

/**
 * Build power ratings for model week `week`, using only source snapshots taken
 * at or before that week and game results from earlier weeks.
 */
export async function computePowerRatings(season: number, week: number) {
  const settings = await getSettings();
  const sources = (await getSources()).filter((s) => s.enabled);
  const teams = await selectAll<{ id: number; classification: string | null }>((a, b) => db().from('teams').select('id,classification').range(a, b));
  const isFbs = new Map(teams.map((t) => [t.id, t.classification === 'fbs']));

  // 1) Latest snapshot of each external source as of `week`
  const raw = await selectAll<any>((a, b) =>
    db().from('source_ratings').select('source,team_id,week,rating,offense,defense').eq('season', season).lte('week', week).neq('source', 'tcc_mov')
      .order('week', { ascending: false }).range(a, b),
  );
  const latest = new Map<string, Map<number, number>>(); // source -> team -> raw
  const latestOD = new Map<string, Map<number, { o: number; d: number }>>(); // source -> team -> raw off/def
  const latestWeek = new Map<string, number>();
  for (const r of raw) {
    if (!latestWeek.has(r.source)) latestWeek.set(r.source, r.week);
    if (r.week !== latestWeek.get(r.source)) continue; // only the newest snapshot of each source
    if (!latest.has(r.source)) latest.set(r.source, new Map());
    latest.get(r.source)!.set(r.team_id, Number(r.rating));
    if (r.offense !== null && r.defense !== null && OD_SOURCES.includes(r.source)) {
      if (!latestOD.has(r.source)) latestOD.set(r.source, new Map());
      latestOD.get(r.source)!.set(r.team_id, { o: Number(r.offense), d: Number(r.defense) });
    }
  }

  // 2) Convert each source to points vs. the average FBS team
  const comps = new Map<number, Record<string, number>>();
  for (const s of sources) {
    const m = latest.get(s.key);
    if (!m || !m.size) continue;
    const fbsMean = mean([...m.entries()].filter(([id]) => isFbs.get(id)).map(([, v]) => v));
    for (const [id, v] of m) {
      if (!comps.has(id)) comps.set(id, {});
      comps.get(id)![s.key] = (v - fbsMean) * s.scale;
    }
  }
  const weights = new Map(sources.map((s) => [s.key, s.weight]));

  // 3) In-house MOV rating, regularized toward the external composite
  const priors = new Map<number, number>();
  for (const t of teams) {
    const ext = comps.has(t.id) ? blend(comps.get(t.id)!, new Map([...weights].filter(([k]) => k !== 'tcc_mov'))) : null;
    if (ext !== null) priors.set(t.id, ext);
    else if (isFbs.get(t.id)) priors.set(t.id, 0);
  }
  const games = await selectAll<any>((a, b) =>
    db().from('games').select('home_id,away_id,home_points,away_points,neutral_site').eq('season', season).eq('completed', true).lt('week', week).range(a, b),
  );
  const results = games
    .filter((g) => g.home_points !== null && g.away_points !== null)
    .map((g) => {
      for (const id of [g.home_id, g.away_id]) if (!priors.has(id)) priors.set(id, isFbs.get(id) ? 0 : NON_FBS_DEFAULT);
      return { home: g.home_id, away: g.away_id, margin: g.home_points - g.away_points, neutral: g.neutral_site };
    });
  const useMov = sources.some((s) => s.key === 'tcc_mov');
  if (useMov && (results.length || priors.size)) {
    const mov = movRatings(results, priors, { hfa: settings.hfa, cap: settings.margin_cap, lambda: settings.prior_weight });
    const fbsMean = mean([...mov.entries()].filter(([id]) => isFbs.get(id)).map(([, v]) => v));
    const now = new Date().toISOString();
    const movRows: any[] = [];
    for (const [id, v] of mov) {
      const c = v - fbsMean;
      if (!comps.has(id)) comps.set(id, {});
      comps.get(id)!.tcc_mov = c;
      movRows.push({ season, week, source: 'tcc_mov', team_id: id, rating: Math.round(c * 100) / 100, fetched_at: now });
    }
    await upsertChunked('source_ratings', movRows, 'season,week,source,team_id');
  }

  // 4) Offense / defense ratings for totals (points vs. average FBS team)
  const od = new Map<number, Record<string, { o: number; d: number }>>();
  const scaleOf = new Map(sources.map((s) => [s.key, s.scale]));
  for (const [src, m] of latestOD) {
    if (!weights.get(src)) continue;
    const f = [...m.entries()].filter(([id]) => isFbs.get(id));
    const mo = mean(f.map(([, v]) => v.o)), md = mean(f.map(([, v]) => v.d));
    const sc = scaleOf.get(src) ?? 1;
    for (const [id, v] of m) {
      if (!od.has(id)) od.set(id, {});
      od.get(id)![src] = { o: (v.o - mo) * sc, d: (v.d - md) * sc };
    }
  }
  const blendOD = (c: Record<string, { o: number; d: number }>, keys = OD_SOURCES) => {
    let o = 0, d = 0, w = 0;
    for (const k of keys) if (c[k] && (weights.get(k) ?? 0) > 0) { const wk = weights.get(k)!; o += wk * c[k].o; d += wk * c[k].d; w += wk; }
    return w > 0 ? { o: o / w, d: d / w } : null;
  };
  const mu = await leagueAvgPoints(season, week, isFbs);
  if (useMov) {
    const odPriors = new Map<number, { o: number; d: number }>();
    for (const id of priors.keys()) {
      const ext = od.has(id) ? blendOD(od.get(id)!, OD_SOURCES.filter((k) => k !== 'tcc_mov')) : null;
      odPriors.set(id, ext ?? (isFbs.get(id) ? { o: 0, d: 0 } : NON_FBS_OD));
    }
    const scoreRows = games
      .filter((g) => g.home_points !== null && g.away_points !== null)
      .flatMap((g) => [
        { team: g.home_id, opp: g.away_id, points: g.home_points, loc: (g.neutral_site ? 0 : 1) as 1 | 0 | -1 },
        { team: g.away_id, opp: g.home_id, points: g.away_points, loc: (g.neutral_site ? 0 : -1) as 1 | 0 | -1 },
      ]);
    const sr = scoringRatings(scoreRows, odPriors, { mu, hfa: settings.hfa, cap: settings.points_cap, lambda: settings.prior_weight });
    const f = [...sr.entries()].filter(([id]) => isFbs.get(id));
    const mo = mean(f.map(([, v]) => v.o)), md = mean(f.map(([, v]) => v.d));
    for (const [id, v] of sr) {
      if (!od.has(id)) od.set(id, {});
      od.get(id)!.tcc_mov = { o: v.o - mo, d: v.d - md };
    }
  }

  // 5) Pace (plays per game) for totals
  const { pace } = await teamPace(season, week, isFbs);

  // 6) Final composite + rank (rank among FBS only)
  const rows: any[] = [];
  for (const [id, c] of comps) {
    const r = blend(c, weights);
    if (r === null) continue;
    const odv = (od.has(id) ? blendOD(od.get(id)!) : null) ?? (isFbs.get(id) ? null : NON_FBS_OD);
    rows.push({
      season, week, team_id: id, rating: Math.round(r * 100) / 100, components: roundObj(c),
      offense: odv ? Math.round(odv.o * 100) / 100 : null, defense: odv ? Math.round(odv.d * 100) / 100 : null,
      pace: pace.has(id) ? Math.round(pace.get(id)! * 10) / 10 : null,
      computed_at: new Date().toISOString(),
    });
  }
  rows.filter((r) => isFbs.get(r.team_id)).sort((a, b) => b.rating - a.rating).forEach((r, i) => (r.rank = i + 1));
  await upsertChunked('power_ratings', rows, 'season,week,team_id');
  return { teamsRated: rows.length, sources: [...latest.keys()], movGames: results.length, leagueAvgPoints: Math.round(mu * 10) / 10 };
}

function roundObj(o: Record<string, number>) {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v * 100) / 100]));
}

/** Pick the line to model against: live DraftKings first, then CFBD's DraftKings, then consensus. */
export function bookPriority(): string[] {
  const book = process.env.ODDS_BOOKMAKER || 'draftkings';
  return [book, `cfbd_${book}`, 'cfbd_consensus'];
}

export async function buildPredictions(season: number, week: number) {
  const s = await getSettings();
  const prs = await selectAll<any>((a, b) => db().from('power_ratings').select('team_id,rating,offense,defense,pace,rank').eq('season', season).eq('week', week).range(a, b));
  const paceMap = new Map(prs.filter((r) => r.pace !== null).map((r) => [r.team_id, Number(r.pace)]));
  const fbsPace = prs.filter((r) => r.rank !== null && r.pace !== null).map((r) => Number(r.pace));
  const leaguePace = fbsPace.length >= 10 ? mean(fbsPace) : 0;
  const ratings = new Map(prs.map((r) => [r.team_id, Number(r.rating)]));
  const odMap = new Map(prs.filter((r) => r.offense !== null && r.defense !== null).map((r) => [r.team_id, { o: Number(r.offense), d: Number(r.defense) }]));
  const mu = await leagueAvgPoints(season, week);
  const games = await selectAll<any>((a, b) => db().from('games').select('*').eq('season', season).eq('week', week).range(a, b));
  if (!games.length) return { games: 0 };
  const ids = games.map((g) => g.id);
  // Newest first, so the first row with a value is the current line for each book/market.
  const lines = await selectAll<any>((a, b) => db().from('odds_lines').select('*').in('game_id', ids).order('captured_at', { ascending: false }).range(a, b));
  const existing = new Map(
    (await selectAll<any>((a, b) => db().from('predictions').select('game_id,frozen').in('game_id', ids).range(a, b))).map((p) => [p.game_id, p]),
  );
  const priority = bookPriority();
  const pickLine = (gameId: number, field: 'home_spread' | 'total') => {
    for (const b of priority) {
      const l = lines.find((l) => l.game_id === gameId && l.book === b && l[field] !== null);
      if (l) return l;
    }
    return null;
  };
  const now = Date.now();
  const rows: any[] = [];
  const freeze: number[] = [];
  for (const g of games) {
    if (existing.get(g.id)?.frozen) continue;
    // Lock predictions at kickoff so the record reflects what you could actually bet.
    if (g.start_date && new Date(g.start_date).getTime() <= now) {
      if (existing.has(g.id)) freeze.push(g.id);
      continue;
    }
    const hr = ratings.get(g.home_id) ?? null;
    const ar = ratings.get(g.away_id) ?? null;
    if (hr === null || ar === null) continue;
    const margin = hr - ar + (g.neutral_site ? 0 : s.hfa);
    const row: any = {
      game_id: g.id, season, week, home_rating: hr, away_rating: ar,
      model_margin: round(margin), model_spread: round(-margin),
      book: null, book_home_spread: null, book_home_price: null, book_away_price: null,
      edge: null, pick_team_id: null, pick_spread: null, cover_prob: null, ev: null, is_play: false,
      home_points_proj: null, away_points_proj: null, model_total: null, pace_factor: null,
      total_book: null, book_total: null, over_price: null, under_price: null,
      total_pick: null, total_edge: null, total_prob: null, total_ev: null, total_is_play: false,
      updated_at: new Date().toISOString(),
    };
    const line = pickLine(g.id, 'home_spread');
    if (line) {
      const hp = line.home_price ?? s.default_price, ap = line.away_price ?? s.default_price;
      const e = evaluateSpread(margin, Number(line.home_spread), s.sigma, hp, ap);
      Object.assign(row, {
        book: line.book, book_home_spread: Number(line.home_spread), book_home_price: hp, book_away_price: ap,
        edge: round(e.edge), pick_team_id: e.side === 'home' ? g.home_id : g.away_id, pick_spread: e.spread,
        cover_prob: round(e.coverProb, 4), ev: round(e.ev, 4), is_play: e.edge >= s.edge_threshold,
      });
    }
    // Totals: projected points from offense/defense ratings
    const ho = odMap.get(g.home_id), ao = odMap.get(g.away_id);
    if (ho && ao) {
      const base = projectScore(ho, ao, mu, s.hfa, !!g.neutral_site);
      // Pace: a team without pace data (e.g. FCS) is treated as league-average speed.
      const pf = leaguePace > 0 && s.pace_weight > 0
        ? paceFactor(paceMap.get(g.home_id) ?? leaguePace, paceMap.get(g.away_id) ?? leaguePace, leaguePace, s.pace_weight)
        : 1;
      const proj = { homePts: base.homePts * pf, awayPts: base.awayPts * pf, total: base.total * pf };
      Object.assign(row, {
        home_points_proj: round(proj.homePts, 1), away_points_proj: round(proj.awayPts, 1), model_total: round(proj.total, 1), pace_factor: round(pf, 3),
      });
      const tl = pickLine(g.id, 'total');
      if (tl) {
        const op = tl.over_price ?? s.default_price, up = tl.under_price ?? s.default_price;
        const t = evaluateTotal(proj.total, Number(tl.total), s.total_sigma, op, up);
        Object.assign(row, {
          total_book: tl.book, book_total: Number(tl.total), over_price: op, under_price: up,
          total_pick: t.side, total_edge: round(t.edge), total_prob: round(t.prob, 4), total_ev: round(t.ev, 4),
          total_is_play: t.edge >= s.total_edge_threshold,
        });
      }
    }
    rows.push(row);
  }
  await upsertChunked('predictions', rows, 'game_id');
  if (freeze.length) await db().from('predictions').update({ frozen: true }).in('game_id', freeze);
  return { predictions: rows.length, withTotals: rows.filter((r) => r.book_total !== null).length, frozen: freeze.length };
}

/** Grade finished predictions and bets (spreads and totals). */
export async function gradeAll(season: number) {
  const preds = await selectAll<any>((a, b) =>
    db().from('predictions').select('game_id,pick_team_id,book_home_spread,total_pick,book_total,games!inner(home_id,home_points,away_points,completed)')
      .eq('season', season).is('actual_margin', null).eq('games.completed', true).range(a, b),
  );
  let graded = 0;
  for (const p of preds) {
    const g = p.games;
    if (g.home_points === null) continue;
    const margin = g.home_points - g.away_points;
    const total = g.home_points + g.away_points;
    const upd: any = { actual_margin: margin, actual_total: total, frozen: true };
    if (p.pick_team_id && p.book_home_spread !== null) {
      upd.ats_result = gradeSpread(margin, p.pick_team_id === g.home_id ? 'home' : 'away', Number(p.book_home_spread));
    }
    if (p.total_pick && p.book_total !== null) {
      upd.total_result = gradeTotal(total, p.total_pick, Number(p.book_total));
    }
    await db().from('predictions').update(upd).eq('game_id', p.game_id);
    graded++;
  }

  const bets = await selectAll<any>((a, b) =>
    db().from('bets').select('id,team_id,spread,price,stake,market,side,games!inner(home_id,home_points,away_points,completed)')
      .is('result', null).eq('games.completed', true).range(a, b),
  );
  for (const b of bets) {
    const g = b.games;
    if (g.home_points === null) continue;
    let result: 'win' | 'loss' | 'push';
    if (b.market === 'total') {
      result = gradeTotal(g.home_points + g.away_points, b.side === 'under' ? 'under' : 'over', Number(b.spread));
    } else {
      const v = (g.home_points - g.away_points) * (b.team_id === g.home_id ? 1 : -1) + Number(b.spread);
      result = v > 0 ? 'win' : v < 0 ? 'loss' : 'push';
    }
    await db().from('bets').update({ result, profit: round(betProfit(result, Number(b.stake), b.price), 2) }).eq('id', b.id);
  }
  return { predictionsGraded: graded, betsGraded: bets.length };
}

/**
 * Fit blend weights + HFA from completed games, using the rating components
 * that were stored *before* each game (no look-ahead).
 */
export async function calibrate(season: number) {
  const sources = (await getSources()).filter((s) => s.enabled);
  const keys = sources.map((s) => s.key);
  const games = await selectAll<any>((a, b) =>
    db().from('games').select('id,season,week,home_id,away_id,home_points,away_points,neutral_site').in('season', [season, season - 1]).eq('completed', true).range(a, b),
  );
  const pr = await selectAll<any>((a, b) =>
    db().from('power_ratings').select('season,week,team_id,rating,components').in('season', [season, season - 1]).range(a, b),
  );
  const byKey = new Map(pr.map((r) => [`${r.season}|${r.week}|${r.team_id}`, r]));
  const X: number[][] = [], home: number[] = [], y: number[] = [];
  for (const g of games) {
    const h = byKey.get(`${g.season}|${g.week}|${g.home_id}`), a = byKey.get(`${g.season}|${g.week}|${g.away_id}`);
    if (!h || !a || g.home_points === null) continue;
    // A source missing for a team falls back to that team's composite rating.
    X.push(keys.map((k) => Number(h.components?.[k] ?? h.rating) - Number(a.components?.[k] ?? a.rating)));
    home.push(g.neutral_site ? 0 : 1);
    y.push(g.home_points - g.away_points);
  }
  if (y.length < 50) return { ok: false, games: y.length, message: 'Need at least 50 completed games with stored pregame ratings. Let the model run a few weeks first.' };
  const fit = fitWeights(X, home, y, 5);
  const total = fit.weights.reduce((a, b) => a + b, 0) || 1;
  return {
    ok: true,
    games: y.length,
    hfa: round(fit.hfa),
    sigma: round(fit.rmse),
    shrink: round(total, 3), // <1 means the blended ratings are too spread out
    weights: Object.fromEntries(keys.map((k, i) => [k, round(fit.weights[i] / total, 3)])),
  };
}

function round(v: number, d = 2) {
  const f = 10 ** d;
  return Math.round(v * f) / f;
}
