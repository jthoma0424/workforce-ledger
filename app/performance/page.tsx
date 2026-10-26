import Link from 'next/link';
import { db, selectAll } from '@/lib/supabase';
import { currentSeason } from '@/lib/season';
import { betProfit, breakEven } from '@/lib/model/math';
import { Empty, Stat } from '../components';
import { fmtNum, fmtPct, fmtSigned, signClass } from '@/lib/format';

export const dynamic = 'force-dynamic';

// One graded pick, normalized so spreads and totals share the same summaries.
type G = { week: number; edge: number; result: 'win' | 'loss' | 'push'; play: boolean; price: number; modelErr: number; lineErr: number };

function summarize(rows: G[]) {
  const w = rows.filter((r) => r.result === 'win').length;
  const l = rows.filter((r) => r.result === 'loss').length;
  const pu = rows.filter((r) => r.result === 'push').length;
  const units = rows.reduce((s, r) => s + betProfit(r.result, 1, r.price ?? -110), 0);
  return { w, l, pu, pct: w + l ? w / (w + l) : null, units, roi: rows.length ? units / rows.length : null };
}

export default async function Performance({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const sp = await searchParams;
  const season = sp.season ? Number(sp.season) : currentSeason();
  const market = sp.market === 'totals' ? 'totals' : 'spreads';
  const isTot = market === 'totals';

  const raw = await selectAll<any>((a, b) =>
    db().from('predictions')
      .select('week,edge,ats_result,is_play,model_margin,book_home_spread,actual_margin,book_home_price,book_away_price,pick_team_id,total_edge,total_result,total_is_play,model_total,book_total,actual_total,total_pick,over_price,under_price,games!inner(home_id)')
      .eq('season', season).not(isTot ? 'total_result' : 'ats_result', 'is', null).range(a, b),
  );
  const rows: G[] = raw.map((r) => isTot
    ? {
        week: r.week, edge: Number(r.total_edge), result: r.total_result, play: !!r.total_is_play,
        price: r.total_pick === 'under' ? r.under_price : r.over_price,
        modelErr: Math.abs(r.actual_total - r.model_total), lineErr: Math.abs(r.actual_total - r.book_total),
      }
    : {
        week: r.week, edge: Number(r.edge), result: r.ats_result, play: !!r.is_play,
        price: r.pick_team_id === r.games.home_id ? r.book_home_price : r.book_away_price,
        modelErr: Math.abs(r.actual_margin - r.model_margin), lineErr: Math.abs(r.actual_margin + Number(r.book_home_spread)),
      });

  const all = summarize(rows);
  const plays = summarize(rows.filter((r) => r.play));
  const be = breakEven(-110);
  const maeModel = rows.reduce((s, r) => s + r.modelErr, 0) / (rows.length || 1);
  const maeLine = rows.reduce((s, r) => s + r.lineErr, 0) / (rows.length || 1);
  const buckets: [string, number, number][] = [['0–1.5', 0, 1.5], ['1.5–3', 1.5, 3], ['3–5', 3, 5], ['5–7', 5, 7], ['7+', 7, 999]];
  const weeks = [...new Set(rows.map((r) => r.week))].sort((a, b) => a - b);
  const rec = (s: ReturnType<typeof summarize>) => `${s.w}-${s.l}${s.pu ? `-${s.pu}` : ''}`;
  const label = isTot ? 'O/U' : 'ATS';
  const tab = (m: string, text: string) => (
    <Link href={`/performance?season=${season}&market=${m}`} className={`tab ${market === m ? 'active' : ''}`}>{text}</Link>
  );

  return (
    <>
      <h1>Model performance · {season}</h1>
      <div className="tabs">{tab('spreads', 'Spreads')}{tab('totals', 'Totals')}</div>
      <p className="sub">Graded against the line the model saw at kickoff. Break-even at -110 is {fmtPct(be)}.</p>
      {!rows.length ? <Empty>No graded {market} yet. They appear after games with a captured line go final.</Empty> : (
        <>
          <div className="stats">
            <Stat k={`All picks ${label}`} v={rec(all)} />
            <Stat k="All picks win %" v={fmtPct(all.pct)} cls={all.pct && all.pct > be ? 'pos' : 'neg'} />
            <Stat k={`Plays ${label}`} v={rec(plays)} />
            <Stat k="Plays units (1u flat)" v={fmtSigned(plays.units, 2)} cls={signClass(plays.units)} />
            <Stat k="Model avg miss (pts)" v={fmtNum(maeModel, 2)} />
            <Stat k="Line avg miss (pts)" v={fmtNum(maeLine, 2)} />
          </div>
          <div className="grid">
            <div>
              <h2>By edge size</h2>
              <div className="tablewrap"><table>
                <thead><tr><th>Edge</th><th className="n">Record</th><th className="n">Win %</th><th className="n">Units</th><th className="n">ROI</th></tr></thead>
                <tbody>
                  {buckets.map(([lab, lo, hi]) => {
                    const s = summarize(rows.filter((r) => r.edge >= lo && r.edge < hi));
                    return (
                      <tr key={lab}><td>{lab}</td><td className="n">{rec(s)}</td>
                        <td className={`n ${s.pct && s.pct > be ? 'pos' : 'neg'}`}>{fmtPct(s.pct)}</td>
                        <td className={`n ${signClass(s.units)}`}>{fmtSigned(s.units, 2)}</td>
                        <td className={`n ${signClass(s.roi)}`}>{s.roi != null ? fmtSigned(s.roi * 100, 1) + '%' : '—'}</td></tr>
                    );
                  })}
                </tbody>
              </table></div>
            </div>
            <div>
              <h2>By week (plays)</h2>
              <div className="tablewrap"><table>
                <thead><tr><th>Week</th><th className="n">Plays</th><th className="n">Win %</th><th className="n">Units</th><th className="n">All picks</th></tr></thead>
                <tbody>
                  {weeks.map((w) => {
                    const wr = rows.filter((r) => r.week === w);
                    const s = summarize(wr.filter((r) => r.play)), a = summarize(wr);
                    return (
                      <tr key={w}><td>{w}</td><td className="n">{rec(s)}</td><td className="n">{fmtPct(s.pct)}</td>
                        <td className={`n ${signClass(s.units)}`}>{fmtSigned(s.units, 2)}</td><td className="n muted">{a.w}-{a.l}</td></tr>
                    );
                  })}
                </tbody>
              </table></div>
            </div>
          </div>
        </>
      )}
    </>
  );
}
