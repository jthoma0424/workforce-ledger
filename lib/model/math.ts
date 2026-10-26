// Pure model math — no I/O, unit-tested in tests/math.test.ts.

/** Standard normal CDF (Abramowitz–Stegun 7.1.26, |err| < 1.5e-7). */
export function normCdf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

/** Profit per 1 unit risked at American odds. -110 -> 0.909, +150 -> 1.5 */
export function payout(price: number): number {
  return price < 0 ? 100 / -price : price / 100;
}

/** Win probability needed to break even at a price. -110 -> 52.38% */
export function breakEven(price: number): number {
  return 1 / (1 + payout(price));
}

export type SpreadEval = {
  side: 'home' | 'away';
  edge: number;        // points of value on the chosen side
  coverProb: number;   // P(chosen side covers), pushes ignored
  ev: number;          // expected profit per 1 unit risked
  spread: number;      // the chosen side's spread
  price: number;
};

/**
 * Compare a predicted home margin to a book's home spread.
 * Home covers when (actual margin + homeSpread) > 0, so the home edge is
 * modelMargin + homeSpread. Example: model says home by 10, DK has home -7 -> +3 edge on home.
 * Cover probability assumes actual margin ~ Normal(modelMargin, sigma).
 */
export function evaluateSpread(modelMargin: number, homeSpread: number, sigma: number, homePrice = -110, awayPrice = -110): SpreadEval {
  const homeEdge = modelMargin + homeSpread;
  const pHome = normCdf(homeEdge / sigma);
  const home = { side: 'home' as const, edge: homeEdge, coverProb: pHome, ev: pHome * payout(homePrice) - (1 - pHome), spread: homeSpread, price: homePrice };
  const away = { side: 'away' as const, edge: -homeEdge, coverProb: 1 - pHome, ev: (1 - pHome) * payout(awayPrice) - pHome, spread: -homeSpread, price: awayPrice };
  return home.ev >= away.ev ? home : away;
}

/** Grade a spread bet. `margin` is the actual home margin. */
export function gradeSpread(margin: number, side: 'home' | 'away', homeSpread: number): 'win' | 'loss' | 'push' {
  const v = margin + homeSpread;
  if (v === 0) return 'push';
  return (v > 0) === (side === 'home') ? 'win' : 'loss';
}

export function betProfit(result: 'win' | 'loss' | 'push', stake: number, price: number): number {
  return result === 'win' ? stake * payout(price) : result === 'loss' ? -stake : 0;
}

/** Soft cap on margin of victory so blowouts don't dominate (tanh-shaped). */
export function capMargin(m: number, cap: number): number {
  return cap * Math.tanh(m / cap);
}

/** Solve A x = b (A square) with Gaussian elimination + partial pivoting. */
export function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const piv = M[c][c];
    if (Math.abs(piv) < 1e-12) continue;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / piv;
      if (f === 0) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => (Math.abs(row[i]) < 1e-12 ? 0 : row[n] / row[i]));
}

export type GameResult = { home: number; away: number; margin: number; neutral: boolean };

/**
 * In-house margin-of-victory rating. Minimizes
 *   Σ (capped margin − (r_home − r_away + hfa))² + λ Σ (r_t − prior_t)²
 * The prior (e.g. the market-style composite or last year's rating) keeps early-season
 * ratings sane; λ is "games worth" of prior weight.
 */
export function movRatings(games: GameResult[], priors: Map<number, number>, opts: { hfa: number; cap: number; lambda: number }): Map<number, number> {
  const ids = new Set<number>();
  for (const g of games) { ids.add(g.home); ids.add(g.away); }
  for (const id of priors.keys()) ids.add(id);
  const list = [...ids];
  const idx = new Map(list.map((id, i) => [id, i]));
  const n = list.length;
  const A = Array.from({ length: n }, () => new Array(n).fill(0));
  const b = new Array(n).fill(0);
  for (const g of games) {
    const h = idx.get(g.home)!, a = idx.get(g.away)!;
    const y = capMargin(g.margin, opts.cap) - (g.neutral ? 0 : opts.hfa);
    A[h][h] += 1; A[a][a] += 1; A[h][a] -= 1; A[a][h] -= 1;
    b[h] += y; b[a] -= y;
  }
  for (let i = 0; i < n; i++) {
    A[i][i] += opts.lambda;
    b[i] += opts.lambda * (priors.get(list[i]) ?? 0);
  }
  const x = solve(A, b);
  return new Map(list.map((id, i) => [id, x[i]]));
}

/**
 * Fit blend weights by ridge regression on past games:
 *   margin ≈ hfa·home + Σ w_s · (rating_home_s − rating_away_s)
 * Negative weights are clipped to 0 and the fit is repeated (simple NNLS).
 * Returns weights and the fitted home-field advantage.
 */
export function fitWeights(X: number[][], homeFlag: number[], y: number[], lambda = 5): { weights: number[]; hfa: number; rmse: number } {
  const k = X[0]?.length ?? 0;
  let active = Array.from({ length: k }, (_, i) => i);
  let w = new Array(k).fill(0), hfa = 0;
  for (let iter = 0; iter < k + 1; iter++) {
    const p = active.length + 1;
    const A = Array.from({ length: p }, () => new Array(p).fill(0));
    const b = new Array(p).fill(0);
    for (let g = 0; g < y.length; g++) {
      const row = [...active.map((j) => X[g][j]), homeFlag[g]];
      for (let i = 0; i < p; i++) {
        b[i] += row[i] * y[g];
        for (let j = 0; j < p; j++) A[i][j] += row[i] * row[j];
      }
    }
    for (let i = 0; i < p - 1; i++) A[i][i] += lambda; // don't shrink HFA
    const sol = solve(A, b);
    w = new Array(k).fill(0);
    active.forEach((j, i) => (w[j] = sol[i]));
    hfa = sol[p - 1];
    const neg = active.filter((j) => w[j] < 0);
    if (!neg.length) break;
    active = active.filter((j) => w[j] >= 0);
  }
  let se = 0;
  for (let g = 0; g < y.length; g++) {
    const pred = X[g].reduce((s, x, j) => s + x * w[j], 0) + hfa * homeFlag[g];
    se += (y[g] - pred) ** 2;
  }
  return { weights: w, hfa, rmse: Math.sqrt(se / Math.max(1, y.length)) };
}

export function mean(xs: number[]) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

// ---------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------
export type TotalEval = { side: 'over' | 'under'; edge: number; prob: number; ev: number; price: number };

/** Compare a projected game total to a book total. Actual total ~ Normal(modelTotal, sigma). */
export function evaluateTotal(modelTotal: number, bookTotal: number, sigma: number, overPrice = -110, underPrice = -110): TotalEval {
  const overEdge = modelTotal - bookTotal;
  const pOver = normCdf(overEdge / sigma);
  const over = { side: 'over' as const, edge: overEdge, prob: pOver, ev: pOver * payout(overPrice) - (1 - pOver), price: overPrice };
  const under = { side: 'under' as const, edge: -overEdge, prob: 1 - pOver, ev: (1 - pOver) * payout(underPrice) - pOver, price: underPrice };
  return over.ev >= under.ev ? over : under;
}

export function gradeTotal(actualTotal: number, side: 'over' | 'under', bookTotal: number): 'win' | 'loss' | 'push' {
  if (actualTotal === bookTotal) return 'push';
  return (actualTotal > bookTotal) === (side === 'over') ? 'win' : 'loss';
}

export type TeamScore = { team: number; opp: number; points: number; loc: 1 | 0 | -1 }; // loc: 1 home, -1 away, 0 neutral

/**
 * In-house offense/defense ratings from points scored. For each team-game:
 *   points − mu − loc·hfa/2 ≈ O_team + D_opp
 * O = points scored above average vs. an average defense; D = points allowed above
 * average vs. an average offense (higher D = worse defense). Ridge toward priors.
 */
export function scoringRatings(
  rows: TeamScore[], priors: Map<number, { o: number; d: number }>,
  opts: { mu: number; hfa: number; cap: number; lambda: number },
): Map<number, { o: number; d: number }> {
  const ids = new Set<number>();
  for (const r of rows) { ids.add(r.team); ids.add(r.opp); }
  for (const id of priors.keys()) ids.add(id);
  const list = [...ids];
  const idx = new Map(list.map((id, i) => [id, i]));
  const n = list.length;
  const N = 2 * n; // [O_0..O_n-1, D_0..D_n-1]
  const A = Array.from({ length: N }, () => new Array(N).fill(0));
  const b = new Array(N).fill(0);
  for (const r of rows) {
    const o = idx.get(r.team)!, d = n + idx.get(r.opp)!;
    const y = capMargin(r.points - opts.mu - (r.loc * opts.hfa) / 2, opts.cap);
    A[o][o] += 1; A[d][d] += 1; A[o][d] += 1; A[d][o] += 1;
    b[o] += y; b[d] += y;
  }
  for (let i = 0; i < n; i++) {
    const p = priors.get(list[i]) ?? { o: 0, d: 0 };
    A[i][i] += opts.lambda; b[i] += opts.lambda * p.o;
    A[n + i][n + i] += opts.lambda; b[n + i] += opts.lambda * p.d;
  }
  const x = solve(A, b);
  return new Map(list.map((id, i) => [id, { o: x[i], d: x[n + i] }]));
}

/** Projected points for each side given offense/defense ratings. */
export function projectScore(
  home: { o: number; d: number }, away: { o: number; d: number }, mu: number, hfa: number, neutral: boolean,
) {
  const h = neutral ? 0 : hfa / 2;
  const homePts = mu + home.o + away.d + h;
  const awayPts = mu + away.o + home.d - h;
  return { homePts, awayPts, total: homePts + awayPts, margin: homePts - awayPts };
}

// ---------------------------------------------------------------------------
// Pace
// ---------------------------------------------------------------------------
/** Shrink a team's plays-per-game toward the league average (early-season samples are small). */
export function shrinkPace(playsPerGame: number, games: number, league: number, priorGames = 2): number {
  return (playsPerGame * games + league * priorGames) / (games + priorGames);
}

/**
 * Pace multiplier for a matchup. Each team's ratings were earned at roughly its own
 * typical game pace; two fast teams together play faster than either one usually does.
 *   expected plays = paceA × paceB / league
 *   factor = expected plays / average of the two teams' usual pace
 * `weight` dampens the effect (0 = off, 1 = full).
 */
export function paceFactor(paceA: number, paceB: number, league: number, weight = 1): number {
  if (!(paceA > 0 && paceB > 0 && league > 0)) return 1;
  const expected = (paceA * paceB) / league;
  const baseline = (paceA + paceB) / 2;
  return Math.pow(expected / baseline, weight);
}

// ---------------------------------------------------------------------------
// Basketball (tempo-free) projection
// ---------------------------------------------------------------------------
export type CbbTeam = { o: number; d: number; t: number }; // o/d: points per 100 vs. average (d: allowed, higher = worse); t: possessions per game

/**
 * KenPom-style projection.
 *   possessions = tempoA × tempoB / leagueTempo
 *   points = possessions × (leagueEff + own offense + opponent defense) / 100 ± half the home-court edge
 */
export function cbbProject(home: CbbTeam, away: CbbTeam, leagueEff: number, leagueTempo: number, hca: number, neutral: boolean) {
  const poss = (home.t * away.t) / leagueTempo;
  const h = neutral ? 0 : hca / 2;
  const homePts = (poss * (leagueEff + home.o + away.d)) / 100 + h;
  const awayPts = (poss * (leagueEff + away.o + home.d)) / 100 - h;
  return { poss, homePts, awayPts, margin: homePts - awayPts, total: homePts + awayPts };
}
