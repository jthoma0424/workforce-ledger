import { test } from 'node:test';
import assert from 'node:assert/strict';
import { breakEven, evaluateSpread, fitWeights, gradeSpread, movRatings, normCdf, payout } from '../lib/model/math.ts';
import { parseManualCsv, parseRatingTable, parseSagarin } from '../lib/scrapers/parsers.ts';

const close = (a: number, b: number, eps = 1e-3) => assert.ok(Math.abs(a - b) < eps, `${a} !≈ ${b}`);

test('normal CDF', () => {
  close(normCdf(0), 0.5);
  close(normCdf(1.96), 0.975);
  close(normCdf(-1), 0.1587);
});

test('pricing', () => {
  close(payout(-110), 0.9091);
  close(payout(150), 1.5);
  close(breakEven(-110), 0.5238);
});

test('spread evaluation picks the right side', () => {
  // Model: home by 10. DK: home -7  => +3 edge on home
  const e = evaluateSpread(10, -7, 14);
  assert.equal(e.side, 'home');
  close(e.edge, 3);
  assert.ok(e.coverProb > 0.58 && e.coverProb < 0.59);
  assert.ok(e.ev > 0);
  // Model: home by 3. DK: home -10 => away +10 has 7 pts of edge
  const f = evaluateSpread(3, -10, 14);
  assert.equal(f.side, 'away');
  close(f.edge, 7);
  assert.equal(f.spread, 10);
});

test('ATS grading', () => {
  assert.equal(gradeSpread(10, 'home', -7), 'win');
  assert.equal(gradeSpread(7, 'home', -7), 'push');
  assert.equal(gradeSpread(3, 'away', -7), 'win');
  assert.equal(gradeSpread(14, 'away', -7), 'loss');
});

test('MOV ratings recover true strengths', () => {
  const truth = new Map([[1, 14], [2, 7], [3, 0], [4, -7], [5, -14]]);
  const games = [];
  for (const h of truth.keys()) for (const a of truth.keys()) if (h !== a) games.push({ home: h, away: a, margin: truth.get(h)! - truth.get(a)! + 2.5, neutral: false });
  const r = movRatings(games, new Map([...truth.keys()].map((k) => [k, 0])), { hfa: 2.5, cap: 1000, lambda: 0.001 });
  const m = [...r.values()].reduce((a, b) => a + b, 0) / r.size;
  for (const [id, v] of truth) close(r.get(id)! - m, v, 0.05);
});

test('weight fitting finds the informative source and HFA', () => {
  const X: number[][] = [], home: number[] = [], y: number[] = [];
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
  for (let i = 0; i < 400; i++) {
    const good = rnd() * 40, noise = rnd() * 40;
    X.push([good, noise]); home.push(1); y.push(good + 3 + rnd() * 4);
  }
  const fit = fitWeights(X, home, y, 0.01);
  close(fit.weights[0], 1, 0.05);
  assert.ok(fit.weights[1] < 0.05);
  close(fit.hfa, 3, 0.3);
});

test('Sagarin parser', () => {
  const txt = `
   1  Alabama              A  =  95.26    5   0   76.44(   9)    0   0  |    2   0  |   91.30    7 |   96.12    4 |   99.58    1 |  103.50    1  SEC                 (A)
  64  South Dakota State   AA =  74.10    4   1   60.11( 120)    0   0  |    0   1  |   75.00   60 |   73.20   66 |   74.00   65 |   73.90   66  MISSOURI VALLEY     (AA)
  65  Miami-Ohio           A  =  73.90    3   2   65.00(  80)    0   0  |    0   1  |   72.80   70 |   73.10   67 |   74.20   64 |   75.00   60  MAC                 (A)`;
  const r = parseSagarin(txt);
  assert.equal(r.length, 3);
  assert.equal(r[0].team, 'Alabama');
  assert.equal(r[0].rating, 91.3);
  assert.equal(r[1].division, 'AA');
  assert.equal(r[2].team, 'Miami-Ohio');
});

test('generic table parser + manual csv', () => {
  const html = `<table><tr><th>Rk</th><th>Team</th><th>FEI</th></tr><tr><td>1</td><td>Georgia (5-0)</td><td>1.42</td></tr><tr><td>2</td><td>Texas</td><td>-0.31</td></tr></table>`;
  assert.deepEqual(parseRatingTable(html, /^FEI$/i), [{ team: 'Georgia', rating: 1.42 }, { team: 'Texas', rating: -0.31 }]);
  assert.deepEqual(parseManualCsv('Team,Rating\n1\tOhio State\t26.1\n"Texas A&M", 12'), [{ team: 'Ohio State', rating: 26.1 }, { team: 'Texas A&M', rating: 12 }]);
});

import { evaluateTotal, gradeTotal, projectScore, scoringRatings } from '../lib/model/math.ts';

test('totals evaluation and grading', () => {
  const o = evaluateTotal(58, 54.5, 13.5);
  assert.equal(o.side, 'over'); close(o.edge, 3.5); assert.ok(o.prob > 0.6 && o.prob < 0.61);
  const u = evaluateTotal(45, 51, 13.5);
  assert.equal(u.side, 'under'); close(u.edge, 6);
  assert.equal(gradeTotal(60, 'over', 54.5), 'win');
  assert.equal(gradeTotal(50, 'over', 54.5), 'loss');
  assert.equal(gradeTotal(54, 'under', 54), 'push');
});

test('scoring ratings recover offense/defense', () => {
  const O = new Map([[1, 10], [2, 4], [3, 0], [4, -6], [5, -8]]);
  const D = new Map([[1, -7], [2, 3], [3, 0], [4, 5], [5, -1]]);
  const rows: any[] = [];
  for (const h of O.keys()) for (const a of O.keys()) if (h !== a) {
    rows.push({ team: h, opp: a, points: 28 + O.get(h)! + D.get(a)! + 1.25, loc: 1 });
    rows.push({ team: a, opp: h, points: 28 + O.get(a)! + D.get(h)! - 1.25, loc: -1 });
  }
  const r = scoringRatings(rows, new Map(), { mu: 28, hfa: 2.5, cap: 1000, lambda: 0.001 });
  const mo = [...r.values()].reduce((s, v) => s + v.o, 0) / r.size;
  const md = [...r.values()].reduce((s, v) => s + v.d, 0) / r.size;
  // O and D are identified up to a shared constant; check after centering
  const tO = [...O.values()].reduce((a, b) => a + b, 0) / O.size, tD = [...D.values()].reduce((a, b) => a + b, 0) / D.size;
  for (const id of O.keys()) { close(r.get(id)!.o - mo, O.get(id)! - tO, 0.05); close(r.get(id)!.d - md, D.get(id)! - tD, 0.05); }
  const p = projectScore({ o: 10, d: -7 }, { o: -6, d: 5 }, 28, 2.5, false);
  close(p.homePts, 44.25); close(p.awayPts, 13.75); close(p.total, 58);
});

import { paceFactor, shrinkPace } from '../lib/model/math.ts';

test('pace factor', () => {
  close(paceFactor(140, 140, 140), 1);               // two average teams
  close(paceFactor(154, 154, 140), 1.1);             // two fast teams play faster than either usually does
  close(paceFactor(126, 126, 140), 0.9);             // two slow teams
  close(paceFactor(154, 126, 140), 0.99);            // fast vs slow roughly cancels
  close(paceFactor(154, 154, 140, 0), 1);            // weight 0 = off
  close(paceFactor(154, 154, 140, 0.5), Math.sqrt(1.1));
  close(shrinkPace(160, 2, 140, 2), 150);
  assert.equal(paceFactor(0, 140, 140), 1);
});

import { cbbProject } from '../lib/model/math.ts';

test('basketball projection', () => {
  const avg = { o: 0, d: 0, t: 68 };
  const p0 = cbbProject(avg, avg, 105, 68, 3, false);
  close(p0.poss, 68); close(p0.total, 2 * 68 * 1.05); close(p0.margin, 3);
  const good = { o: 10, d: -8, t: 72 }, bad = { o: -6, d: 5, t: 64 };
  const p = cbbProject(good, bad, 105, 68, 3, true);
  close(p.poss, 72 * 64 / 68);
  close(p.homePts, p.poss * 120 / 100); close(p.awayPts, p.poss * 91 / 100);
});
