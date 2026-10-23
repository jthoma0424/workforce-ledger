import Link from 'next/link';
import { notFound } from 'next/navigation';
import { db, selectAll } from '@/lib/supabase';
import { cbbCurrentSeason } from '@/lib/cbb/ingest';
import { cbbTeamMap, latestCbbRatings } from '@/lib/cbb/queries';
import { Stat, Team } from '../../../components';
import { fmtKick, fmtNum, fmtSigned, fmtSpread, signClass } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function CbbTeamPage({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  const season = await cbbCurrentSeason();
  const teams = await cbbTeamMap();
  const team = teams.get(id);
  if (!team) notFound();
  const [{ rows }, games] = await Promise.all([
    latestCbbRatings(season),
    selectAll<any>((a, b) => db().from('cbb_games').select('*').eq('season', season).or(`home_id.eq.${id},away_id.eq.${id}`).order('start_date').range(a, b)),
  ]);
  const r = rows.find((x) => x.team_id === id);
  const preds = new Map<number, any>();
  const ids = games.map((g) => g.id);
  for (let i = 0; i < ids.length; i += 150) {
    const { data } = await db().from('cbb_predictions').select('*').in('game_id', ids.slice(i, i + 150));
    for (const p of data ?? []) preds.set(p.game_id, p);
  }

  return (
    <>
      <h1><Team t={team} link={false} /></h1>
      <p className="sub">{team.conference}</p>
      <div className="stats">
        <Stat k="Rank" v={r?.rank ?? '—'} />
        <Stat k="Net (per 100)" v={fmtSigned(r?.net)} />
        <Stat k="AdjO" v={fmtNum(r?.offense)} />
        <Stat k="AdjD" v={fmtNum(r?.defense)} />
        <Stat k="Tempo" v={fmtNum(r?.tempo)} />
      </div>
      <h2>Schedule</h2>
      <div className="tablewrap"><table>
        <thead><tr><th>Date</th><th>Opponent</th><th className="n">Model</th><th className="n">DK</th><th className="n">Edge</th><th>Result</th></tr></thead>
        <tbody>
          {games.map((g) => {
            const home = g.home_id === id, opp = teams.get(home ? g.away_id : g.home_id), p = preds.get(g.id), sgn = home ? 1 : -1;
            const my = home ? g.home_points : g.away_points, th = home ? g.away_points : g.home_points;
            return (
              <tr key={g.id}>
                <td className="muted">{fmtKick(g.start_date)}</td>
                <td>{g.neutral_site ? 'vs' : home ? 'vs' : '@'} <Team t={opp} base="/cbb/team" /></td>
                <td className="n">{p ? fmtSpread(p.model_spread * sgn) : '—'}</td>
                <td className="n">{p?.book_home_spread != null ? fmtSpread(p.book_home_spread * sgn) : '—'}</td>
                <td className={`n ${signClass(p?.edge)}`}>{p?.edge != null ? <Link href={`/cbb/game/${g.id}`}>{fmtSigned(p.edge)}</Link> : '—'}</td>
                <td>{g.completed ? <span className={my > th ? 'pos' : 'neg'}>{my > th ? 'W' : 'L'} {my}-{th}</span> : ''}</td>
              </tr>
            );
          })}
        </tbody>
      </table></div>
    </>
  );
}
