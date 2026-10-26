import Link from 'next/link';
import { db, selectAll } from '@/lib/supabase';
import { cbbCurrentSeason } from '@/lib/cbb/ingest';
import { betProfit, breakEven } from '@/lib/model/math';
import { Empty, Stat } from '../../components';
import { fmtNum, fmtPct, fmtSigned, signClass } from '@/lib/format';

export const dynamic = 'force-dynamic';

type G = { date: string; edge: number; result: 'win' | 'loss' | 'push'; play: boolean; price: number; modelErr: number; lineErr: number };

function summarize(rows: G[]) {
  const w = rows.filter((r) => r.result === 'win').length, l = rows.filter((r) => r.result === 'loss').length, pu = rows.filter((r) => r.result === 'push').length;
  const units = rows.reduce((s, r) => s + betProfit(r.result, 1, r.price ?? -110), 0);
  return { w, l, pu, pct: w + l ? w / (w + l) : null, units, roi: rows.length ? units / rows.length : null };
}
const rec = (s: ReturnType<typeof summarize>) => `${s.w}-${s.l}${s.pu ? `-${s.pu}` : ''}`;

export default async function CbbPerformance({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const sp = await searchParams;
  const season = await cbbCurrentSeason();
  const isTot = sp.market === 'totals';
  const raw = await selectAll<any>((a, b) =>
    db().from('cbb_predictions').select('*').eq('season', season).not(isTot ? 'total_result' : 'ats_result', 'is', null).range(a, b),
  );
  const games = new Map<number, any>();
  const ids = raw.map((r) => r.game_id);
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await db().from('cbb_games').select('id,home_id').in('id', ids.slice(i, i + 200));
    for (const g of data ?? []) games.set(g.id, g);
  }
  const rows: G[] = raw.map((r) => isTot
    ? { date: r.game_date, edge: Number(r.total_edge), result: r.total_result, play: !!r.total_is_play, price: r.total_pick === 'under' ? r.under_price : r.over_price,
        modelErr: Math.abs(r.actual_total - r.model_total), lineErr: Math.abs(r.actual_total - r.book_total) }
    : { date: r.game_date, edge: Number(r.edge), result: r.ats_result, play: !!r.is_play, price: r.pick_team_id === games.get(r.game_id)?.home_id ? r.book_home_price : r.book_away_price,
        modelErr: Math.abs(r.actual_margin - r.model_margin), lineErr: Math.abs(r.actual_margin + Number(r.book_home_spread)) });
  const all = summarize(rows), plays = summarize(rows.filter((r) => r.play)), be = breakEven(-110);
  const buckets: [string, number, number][] = [['0–2', 0, 2], ['2–4', 2, 4], ['4–6', 4, 6], ['6–8', 6, 8], ['8+', 8, 999]];
  // Group by week (Monday start) so the table stays readable over a long season
  const weekOf = (d: string) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return x.toISOString().slice(0, 10); };
  const weeks = [...new Set(rows.map((r) => weekOf(r.date)))].sort();

  return (
    <>
      <h1>Basketball performance</h1>
      <div className="tabs">
        <Link href="/cbb/performance" className={`tab ${!isTot ? 'active' : ''}`}>Spreads</Link>
        <Link href="/cbb/performance?market=totals" className={`tab ${isTot ? 'active' : ''}`}>Totals</Link>
      </div>
      <p className="sub">Graded against the DraftKings line at tip-off. Break-even at -110 is {fmtPct(be)}.</p>
      {!rows.length ? <Empty>No graded games yet.</Empty> : (
        <>
          <div className="stats">
            <Stat k="All picks" v={rec(all)} />
            <Stat k="All picks win %" v={fmtPct(all.pct)} cls={all.pct && all.pct > be ? 'pos' : 'neg'} />
            <Stat k="Plays" v={rec(plays)} />
            <Stat k="Plays units" v={fmtSigned(plays.units, 2)} cls={signClass(plays.units)} />
            <Stat k="Model avg miss" v={fmtNum(rows.reduce((s, r) => s + r.modelErr, 0) / rows.length, 2)} />
            <Stat k="Line avg miss" v={fmtNum(rows.reduce((s, r) => s + r.lineErr, 0) / rows.length, 2)} />
          </div>
          <div className="grid">
            <div>
              <h2>By edge size</h2>
              <div className="tablewrap"><table>
                <thead><tr><th>Edge</th><th className="n">Record</th><th className="n">Win %</th><th className="n">Units</th><th className="n">ROI</th></tr></thead>
                <tbody>{buckets.map(([lab, lo, hi]) => {
                  const x = summarize(rows.filter((r) => r.edge >= lo && r.edge < hi));
                  return <tr key={lab}><td>{lab}</td><td className="n">{rec(x)}</td><td className={`n ${x.pct && x.pct > be ? 'pos' : 'neg'}`}>{fmtPct(x.pct)}</td>
                    <td className={`n ${signClass(x.units)}`}>{fmtSigned(x.units, 2)}</td><td className={`n ${signClass(x.roi)}`}>{x.roi != null ? fmtSigned(x.roi * 100, 1) + '%' : '—'}</td></tr>;
                })}</tbody>
              </table></div>
            </div>
            <div>
              <h2>By week (plays)</h2>
              <div className="tablewrap"><table>
                <thead><tr><th>Week of</th><th className="n">Plays</th><th className="n">Win %</th><th className="n">Units</th><th className="n">All picks</th></tr></thead>
                <tbody>{weeks.map((wk) => {
                  const wr = rows.filter((r) => weekOf(r.date) === wk), x = summarize(wr.filter((r) => r.play)), a = summarize(wr);
                  return <tr key={wk}><td>{wk}</td><td className="n">{rec(x)}</td><td className="n">{fmtPct(x.pct)}</td>
                    <td className={`n ${signClass(x.units)}`}>{fmtSigned(x.units, 2)}</td><td className="n muted">{a.w}-{a.l}</td></tr>;
                })}</tbody>
              </table></div>
            </div>
          </div>
        </>
      )}
    </>
  );
}
