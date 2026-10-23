import Link from 'next/link';
import { notFound } from 'next/navigation';
import { db, selectAll } from '@/lib/supabase';
import { currentSeason } from '@/lib/season';
import { teamMap } from '@/lib/queries';
import { getSources } from '@/lib/model/compute';
import { Stat, Team } from '../../components';
import { fmtKick, fmtNum, fmtPct, fmtSigned, fmtSpread, signClass } from '@/lib/format';

export const dynamic = 'force-dynamic';

const ADV: [string, (o: any) => number | null | undefined, 'pct' | 'num'][] = [
  ['EPA/play', (o) => o?.ppa, 'num'],
  ['Success rate', (o) => o?.successRate, 'pct'],
  ['Explosiveness', (o) => o?.explosiveness, 'num'],
  ['Pass EPA/play', (o) => o?.passingPlays?.ppa, 'num'],
  ['Rush EPA/play', (o) => o?.rushingPlays?.ppa, 'num'],
  ['Standard downs SR', (o) => o?.standardDowns?.successRate, 'pct'],
  ['Passing downs SR', (o) => o?.passingDowns?.successRate, 'pct'],
  ['Pts per opportunity', (o) => o?.pointsPerOpportunity, 'num'],
  ['Line yards', (o) => o?.lineYards, 'num'],
  ['Stuff rate', (o) => o?.stuffRate, 'pct'],
  ['Havoc rate', (o) => o?.havoc?.total, 'pct'],
  ['Avg starting field pos.', (o) => o?.fieldPosition?.averageStart, 'num'],
];

export default async function TeamPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string>> }) {
  const { id: idStr } = await params;
  const sp = await searchParams;
  const id = Number(idStr);
  const season = sp.season ? Number(sp.season) : currentSeason();
  const teams = await teamMap();
  const team = teams.get(id);
  if (!team) notFound();
  const sources = (await getSources()).filter((s) => s.enabled);

  const [ratings, games, preds, statsRes] = await Promise.all([
    selectAll<any>((a, b) => db().from('power_ratings').select('*').eq('season', season).eq('team_id', id).order('week').range(a, b)),
    selectAll<any>((a, b) => db().from('games').select('*').eq('season', season).or(`home_id.eq.${id},away_id.eq.${id}`).order('start_date').range(a, b)),
    selectAll<any>((a, b) => db().from('predictions').select('*').eq('season', season).range(a, b)),
    db().from('team_stats').select('metrics,week').eq('season', season).eq('team_id', id).eq('source', 'cfbd_advanced').order('week', { ascending: false }).limit(1),
  ]);
  const pmap = new Map(preds.map((p) => [p.game_id, p]));
  const latest = ratings[ratings.length - 1];
  const adv = statsRes.data?.[0]?.metrics;

  return (
    <>
      <h1><Team t={team} link={false} /></h1>
      <p className="sub">{team.conference} · {season}</p>
      <div className="stats">
        <Stat k="Power rating" v={fmtSigned(latest?.rating)} />
        <Stat k="FBS rank" v={latest?.rank ?? '—'} />
        {sources.map((s) => <Stat key={s.key} k={s.name} v={fmtNum(latest?.components?.[s.key])} />)}
      </div>

      <div className="grid">
        <div>
          <h2>Schedule & model</h2>
          <div className="tablewrap">
            <table>
              <thead><tr><th>Wk</th><th>Opponent</th><th className="n">Model</th><th className="n">Line</th><th className="n">Edge</th><th>Result</th></tr></thead>
              <tbody>
                {games.map((g) => {
                  const home = g.home_id === id;
                  const opp = teams.get(home ? g.away_id : g.home_id);
                  const p = pmap.get(g.id);
                  const sgn = home ? 1 : -1; // show spreads from this team's perspective
                  const my = home ? g.home_points : g.away_points, their = home ? g.away_points : g.home_points;
                  return (
                    <tr key={g.id}>
                      <td>{g.week}</td>
                      <td>{g.neutral_site ? 'vs' : home ? 'vs' : '@'} <Team t={opp} /> <span className="muted">{g.completed ? '' : fmtKick(g.start_date)}</span></td>
                      <td className="n">{p ? fmtSpread(p.model_spread * sgn) : '—'}</td>
                      <td className="n">{p?.book_home_spread != null ? fmtSpread(p.book_home_spread * sgn) : '—'}</td>
                      <td className={`n ${signClass(p?.edge)}`}>{p?.edge != null ? <Link href={`/game/${g.id}`}>{fmtSigned(p.edge)}</Link> : '—'}</td>
                      <td>{g.completed ? <span className={my > their ? 'pos' : 'neg'}>{my > their ? 'W' : 'L'} {my}-{their}</span> : ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
        <div>
          <h2>Rating by week</h2>
          <div className="tablewrap">
            <table>
              <thead><tr><th>Wk</th><th className="n">Rank</th><th className="n">Rating</th>{sources.map((s) => <th key={s.key} className="n">{s.key.toUpperCase()}</th>)}</tr></thead>
              <tbody>
                {ratings.map((r) => (
                  <tr key={r.week}>
                    <td>{r.week}</td><td className="n">{r.rank ?? '—'}</td><td className="n"><b>{fmtSigned(r.rating)}</b></td>
                    {sources.map((s) => <td key={s.key} className="n muted">{fmtNum(r.components?.[s.key])}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {adv && (
        <>
          <h2>Advanced stats (CFBD, garbage time excluded)</h2>
          <div className="tablewrap" style={{ maxWidth: 560 }}>
            <table>
              <thead><tr><th>Metric</th><th className="n">Offense</th><th className="n">Defense</th></tr></thead>
              <tbody>
                {ADV.map(([label, get, kind]) => (
                  <tr key={label}><td>{label}</td><td className="n">{fmtStat(get(adv.offense), kind)}</td><td className="n">{fmtStat(get(adv.defense), kind)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

function fmtStat(v: number | null | undefined, kind: 'pct' | 'num') {
  if (v === null || v === undefined) return '—';
  return kind === 'pct' ? fmtPct(v) : v.toFixed(Math.abs(v) < 2 ? 3 : 1);
}
