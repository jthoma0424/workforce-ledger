import { db, selectAll, upsertChunked } from '../supabase';
import { betProfit, cbbProject, evaluateSpread, evaluateTotal, gradeSpread, gradeTotal, mean, scoringRatings, shrinkPace } from '../model/math';
import { addDays, etDate } from './ingest';

export type CbbSettings = {
  hca: number; sigma: number; edge_threshold: number; total_sigma: number; total_edge_threshold: number;
  prior_weight: number; eff_cap: number; tempo_prior_games: number; default_price: number;
};

export async function getCbbSettings(): Promise<CbbSettings> {
  const { data } = await db().from('cbb_settings').select('*').eq('id', 1).maybeSingle();
  const s: any = data ?? {};
  const n = (k: string, d: number) => (s[k] === null || s[k] === undefined ? d : Number(s[k]));
  return {
    hca: n('hca', 3), sigma: n('sigma', 11), edge_threshold: n('edge_threshold', 3), total_sigma: n('total_sigma', 12),
    total_edge_threshold: n('total_edge_threshold', 4), prior_weight: n('prior_weight', 4), eff_cap: n('eff_cap', 35),
    tempo_prior_games: n('tempo_prior_games', 3), default_price: n('default_price', -110),
  };
}

export async function getCbbSources() {
  const { data } = await db().from('cbb_sources').select('*').order('key');
  return (data ?? []).map((s) => ({ ...s, weight: Number(s.weight) })) as { key: string; name: string; weight: number; enabled: boolean; notes: string | null }[];
}

const NON_D1 = { o: -12, d: 12 }; // non-D1 opponents: ~24 points per 100 worse than an average D1 team
const PRIOR_KEEP = 0.6;           // last season's ratings regressed 40% toward average

type OD = { o: number; d: number };

/**
 * Ratings as of `asOf`. Offense/defense are points per 100 possessions relative to the
 * average D1 team (defense = allowed, so lower is better); tempo is possessions per game.
 */
export async function computeCbbRatings(season: number, asOf = etDate()) {
  const s = await getCbbSettings();
  const sources = (await getCbbSources()).filter((x) => x.enabled && x.weight > 0);
  const w = new Map(sources.map((x) => [x.key, x.weight]));
  const teams = await selectAll<{ id: number; d1: boolean }>((a, b) => db().from('cbb_teams').select('id,d1').range(a, b));
  const isD1 = new Map(teams.map((t) => [t.id, !!t.d1]));

  // ---- games with possessions
  const games = await selectAll<any>((a, b) =>
    db().from('cbb_games').select('id,home_id,away_id,home_points,away_points,neutral_site,game_date').eq('season', season).eq('completed', true).lt('game_date', asOf).range(a, b),
  );
  const stats = new Map(
    (await selectAll<any>((a, b) => db().from('cbb_game_stats').select('game_id,possessions').range(a, b))).map((r) => [r.game_id, Number(r.possessions)]),
  );
  const played = games.filter((g) => g.home_points !== null && g.away_points !== null && stats.get(g.id)! > 40);
  const d1d1 = played.filter((g) => isD1.get(g.home_id) && isD1.get(g.away_id));

  // ---- external sources (latest snapshot of each) + last season's prior
  const ext = await selectAll<any>((a, b) =>
    db().from('cbb_source_ratings').select('source,team_id,as_of,offense,defense,tempo').eq('season', season).lte('as_of', asOf).order('as_of', { ascending: false }).range(a, b),
  );
  const newest = new Map<string, string>();
  const bySource = new Map<string, Map<number, { o: number; d: number; t: number | null }>>();
  for (const r of ext) {
    if (!newest.has(r.source)) newest.set(r.source, r.as_of);
    if (r.as_of !== newest.get(r.source) || r.offense === null || r.defense === null) continue;
    if (!bySource.has(r.source)) bySource.set(r.source, new Map());
    bySource.get(r.source)!.set(r.team_id, { o: Number(r.offense), d: Number(r.defense), t: r.tempo === null ? null : Number(r.tempo) });
  }
  const centered = new Map<string, Map<number, OD>>();
  const extTempo = new Map<number, number[]>();
  for (const [src, m] of bySource) {
    const d1v = [...m.entries()].filter(([id]) => isD1.get(id)).map(([, v]) => v);
    const mo = mean(d1v.map((v) => v.o)), md = mean(d1v.map((v) => v.d));
    const keep = src === 'prev' ? PRIOR_KEEP : 1;
    const c = new Map<number, OD>();
    for (const [id, v] of m) {
      c.set(id, { o: (v.o - mo) * keep, d: (v.d - md) * keep });
      if (v.t !== null && v.t > 50) {
        if (!extTempo.has(id)) extTempo.set(id, []);
        if (src !== 'prev' || !extTempo.get(id)!.length) extTempo.get(id)!.push(v.t);
      }
    }
    centered.set(src, c);
  }

  // league tempo & efficiency
  const L = d1d1.length >= 30 ? mean(d1d1.map((g) => stats.get(g.id)!))
    : mean([...extTempo.values()].map((v) => v[0])) || 68;
  const mu = d1d1.length >= 30 ? mean(d1d1.flatMap((g) => [100 * g.home_points / stats.get(g.id)!, 100 * g.away_points / stats.get(g.id)!]))
    : mean([...(bySource.get('prev')?.values() ?? [])].map((v) => v.o)) || 105;

  const blendExt = (id: number, keys: string[]) => {
    let o = 0, d = 0, tw = 0;
    for (const k of keys) {
      const v = centered.get(k)?.get(id), wk = w.get(k) ?? 0;
      if (v && wk > 0) { o += wk * v.o; d += wk * v.d; tw += wk; }
    }
    return tw > 0 ? { o: o / tw, d: d / tw } : null;
  };
  const extKeys = sources.map((x) => x.key).filter((k) => k !== 'inhouse');

  // ---- priors for the in-house model. All non-D1 opponents share one pseudo-team (-1):
  // they play too few D1 games to rate individually, and it keeps the solve small.
  const NON_D1_ID = -1;
  const key = (id: number) => (isD1.get(id) ? id : NON_D1_ID);
  const ids = new Set<number>();
  for (const [id, d1] of isD1) if (d1) ids.add(id);
  const priors = new Map<number, OD>([[NON_D1_ID, NON_D1]]);
  for (const id of ids) priors.set(id, blendExt(id, extKeys) ?? centered.get('prev')?.get(id) ?? { o: 0, d: 0 });

  // ---- in-house opponent-adjusted efficiency
  const comps = new Map<number, Record<string, OD>>();
  if (w.get('inhouse')) {
    const hcaEff = (s.hca * 100) / L;
    const rows = played.flatMap((g) => {
      const p = stats.get(g.id)!;
      return [
        { team: key(g.home_id), opp: key(g.away_id), points: (100 * g.home_points) / p, loc: (g.neutral_site ? 0 : 1) as 1 | 0 | -1 },
        { team: key(g.away_id), opp: key(g.home_id), points: (100 * g.away_points) / p, loc: (g.neutral_site ? 0 : -1) as 1 | 0 | -1 },
      ];
    });
    const sr = scoringRatings(rows, priors, { mu, hfa: hcaEff, cap: s.eff_cap, lambda: s.prior_weight });
    const d1v = [...sr.entries()].filter(([id]) => isD1.get(id)).map(([, v]) => v);
    const mo = mean(d1v.map((v) => v.o)), md = mean(d1v.map((v) => v.d));
    for (const [id, v] of sr) if (id !== NON_D1_ID) comps.set(id, { inhouse: { o: v.o - mo, d: v.d - md } });
  }
  for (const [src, m] of centered) {
    if (src === 'prev') continue;
    for (const [id, v] of m) { if (!isD1.get(id)) continue; if (!comps.has(id)) comps.set(id, {}); comps.get(id)![src] = v; }
  }

  // ---- tempo: own possessions per game, shrunk toward the external/prior tempo
  const possBy = new Map<number, number[]>();
  for (const g of played) for (const id of [g.home_id, g.away_id]) {
    if (!isD1.get(id)) continue;
    if (!possBy.has(id)) possBy.set(id, []);
    possBy.get(id)!.push(stats.get(g.id)!);
  }

  const out: any[] = [];
  for (const id of new Set([...ids, ...comps.keys()])) {
    const c = comps.get(id) ?? {};
    let o = 0, d = 0, tw = 0;
    for (const [k, v] of Object.entries(c)) { const wk = w.get(k) ?? 0; if (wk > 0) { o += wk * v.o; d += wk * v.d; tw += wk; } }
    const od = tw > 0 ? { o: o / tw, d: d / tw } : priors.get(id) ?? NON_D1;
    const tPrior = extTempo.get(id)?.length ? mean(extTempo.get(id)!) : L;
    const own = possBy.get(id) ?? [];
    const tempo = own.length ? shrinkPace(mean(own), own.length, tPrior, s.tempo_prior_games) : tPrior;
    out.push({
      season, as_of: asOf, team_id: id,
      net: r2(od.o - od.d), offense: r2(mu + od.o), defense: r2(mu + od.d), tempo: r2(tempo),
      components: Object.fromEntries(Object.entries(c).map(([k, v]) => [k, r2(v.o - v.d)])),
      computed_at: new Date().toISOString(),
    });
  }
  out.filter((r) => isD1.get(r.team_id)).sort((a, b) => b.net - a.net).forEach((r, i) => (r.rank = i + 1));
  await upsertChunked('cbb_ratings', out, 'season,as_of,team_id');
  return { asOf, teamsRated: out.length, gamesUsed: played.length, leagueTempo: r2(L), leagueEff: r2(mu), sources: [...centered.keys()] };
}

/** Predictions for today's and the next two days' games (Eastern time). Locked at tip-off. */
export async function buildCbbPredictions(season: number, today = etDate()) {
  const s = await getCbbSettings();
  const { data: latestAsOf } = await db().from('cbb_ratings').select('as_of').eq('season', season).lte('as_of', today).order('as_of', { ascending: false }).limit(1);
  const asOf = latestAsOf?.[0]?.as_of;
  if (!asOf) return { predictions: 0, note: 'no ratings yet' };
  const ratings = await selectAll<any>((a, b) => db().from('cbb_ratings').select('team_id,net,offense,defense,tempo,rank').eq('season', season).eq('as_of', asOf).range(a, b));
  const d1 = ratings.filter((r) => r.rank !== null);
  const mu = mean(d1.map((r) => Number(r.offense)));
  const L = mean(d1.map((r) => Number(r.tempo))) || 68;
  const team = new Map(ratings.map((r) => [r.team_id, { o: Number(r.offense) - mu, d: Number(r.defense) - mu, t: Number(r.tempo), net: Number(r.net) }]));
  const fallback = { o: NON_D1.o, d: NON_D1.d, t: L, net: NON_D1.o - NON_D1.d };

  const games = await selectAll<any>((a, b) =>
    db().from('cbb_games').select('*').gte('game_date', today).lte('game_date', addDays(today, 2)).range(a, b),
  );
  if (!games.length) return { predictions: 0 };
  const book = process.env.ODDS_BOOKMAKER || 'draftkings';
  const lines = await selectAll<any>((a, b) =>
    db().from('cbb_odds_lines').select('*').eq('book', book).gte('captured_at', new Date(Date.now() - 14 * 86400e3).toISOString()).order('captured_at', { ascending: false }).range(a, b),
  );
  const pick = (gid: number, f: 'home_spread' | 'total') => lines.find((l) => l.game_id === gid && l[f] !== null) ?? null;
  const existing = new Map(
    (await selectAll<any>((a, b) => db().from('cbb_predictions').select('game_id,frozen').gte('game_date', today).range(a, b))).map((p) => [p.game_id, p]),
  );

  const now = Date.now();
  const rows: any[] = [], freeze: number[] = [];
  for (const g of games) {
    if (existing.get(g.id)?.frozen) continue;
    if (g.start_date && new Date(g.start_date).getTime() <= now) { if (existing.has(g.id)) freeze.push(g.id); continue; }
    const h = team.get(g.home_id) ?? fallback, a = team.get(g.away_id) ?? fallback;
    const p = cbbProject(h, a, mu, L, s.hca, !!g.neutral_site);
    const row: any = {
      game_id: g.id, season, game_date: g.game_date, home_net: r2(h.net), away_net: r2(a.net),
      possessions_proj: r2(p.poss), home_points_proj: r1(p.homePts), away_points_proj: r1(p.awayPts),
      model_margin: r2(p.margin), model_spread: r2(-p.margin), model_total: r1(p.total),
      book: null, book_home_spread: null, book_home_price: null, book_away_price: null, edge: null, pick_team_id: null, pick_spread: null,
      cover_prob: null, ev: null, is_play: false,
      total_book: null, book_total: null, over_price: null, under_price: null, total_pick: null, total_edge: null, total_prob: null, total_ev: null, total_is_play: false,
      updated_at: new Date().toISOString(),
    };
    const sl = pick(g.id, 'home_spread');
    if (sl) {
      const hp = sl.home_price ?? s.default_price, ap = sl.away_price ?? s.default_price;
      const e = evaluateSpread(p.margin, Number(sl.home_spread), s.sigma, hp, ap);
      Object.assign(row, {
        book: sl.book, book_home_spread: Number(sl.home_spread), book_home_price: hp, book_away_price: ap,
        edge: r2(e.edge), pick_team_id: e.side === 'home' ? g.home_id : g.away_id, pick_spread: e.spread,
        cover_prob: r4(e.coverProb), ev: r4(e.ev), is_play: e.edge >= s.edge_threshold,
      });
    }
    const tl = pick(g.id, 'total');
    if (tl) {
      const op = tl.over_price ?? s.default_price, up = tl.under_price ?? s.default_price;
      const t = evaluateTotal(p.total, Number(tl.total), s.total_sigma, op, up);
      Object.assign(row, {
        total_book: tl.book, book_total: Number(tl.total), over_price: op, under_price: up,
        total_pick: t.side, total_edge: r2(t.edge), total_prob: r4(t.prob), total_ev: r4(t.ev), total_is_play: t.edge >= s.total_edge_threshold,
      });
    }
    rows.push(row);
  }
  await upsertChunked('cbb_predictions', rows, 'game_id');
  if (freeze.length) await db().from('cbb_predictions').update({ frozen: true }).in('game_id', freeze);
  return { predictions: rows.length, withLines: rows.filter((r) => r.book_home_spread !== null).length, frozen: freeze.length, ratingsAsOf: asOf };
}

export async function gradeCbb() {
  const preds = await selectAll<any>((a, b) =>
    db().from('cbb_predictions').select('game_id,pick_team_id,book_home_spread,total_pick,book_total').is('actual_margin', null).lte('game_date', etDate()).range(a, b),
  );
  const ids = preds.map((p) => p.game_id);
  const games = new Map<number, any>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await db().from('cbb_games').select('id,home_id,home_points,away_points,completed').in('id', ids.slice(i, i + 200));
    for (const g of data ?? []) games.set(g.id, g);
  }
  let graded = 0;
  for (const p of preds) {
    const g = games.get(p.game_id);
    if (!g?.completed || g.home_points === null) continue;
    const margin = g.home_points - g.away_points, total = g.home_points + g.away_points;
    const upd: any = { actual_margin: margin, actual_total: total, frozen: true };
    if (p.pick_team_id && p.book_home_spread !== null) upd.ats_result = gradeSpread(margin, p.pick_team_id === g.home_id ? 'home' : 'away', Number(p.book_home_spread));
    if (p.total_pick && p.book_total !== null) upd.total_result = gradeTotal(total, p.total_pick, Number(p.book_total));
    await db().from('cbb_predictions').update(upd).eq('game_id', p.game_id);
    graded++;
  }
  const bets = await selectAll<any>((a, b) =>
    db().from('cbb_bets').select('id,team_id,line,price,stake,market,side,cbb_games!inner(home_id,home_points,away_points,completed)').is('result', null).eq('cbb_games.completed', true).range(a, b),
  );
  for (const b of bets) {
    const g = b.cbb_games;
    if (g.home_points === null) continue;
    let result: 'win' | 'loss' | 'push';
    if (b.market === 'total') result = gradeTotal(g.home_points + g.away_points, b.side === 'under' ? 'under' : 'over', Number(b.line));
    else {
      const v = (g.home_points - g.away_points) * (b.team_id === g.home_id ? 1 : -1) + Number(b.line);
      result = v > 0 ? 'win' : v < 0 ? 'loss' : 'push';
    }
    await db().from('cbb_bets').update({ result, profit: Math.round(betProfit(result, Number(b.stake), b.price) * 100) / 100 }).eq('id', b.id);
  }
  return { predictionsGraded: graded, betsGraded: bets.length };
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
const r4 = (v: number) => Math.round(v * 10000) / 10000;
