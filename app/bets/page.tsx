import Link from 'next/link';
import { db, selectAll } from '@/lib/supabase';
import { teamMap } from '@/lib/queries';
import { deleteBet } from '../actions';
import { Empty, Stat, Team } from '../components';
import { fmtKick, fmtPrice, fmtSigned, fmtSpread, signClass } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function Bets() {
  const [teams, bets] = await Promise.all([
    teamMap(),
    selectAll<any>((a, b) => db().from('bets').select('*, games(id,week,season,start_date,home_id,away_id,home_points,away_points,completed)').order('placed_at', { ascending: false }).range(a, b)),
  ]);
  const settled = bets.filter((b) => b.result);
  const w = settled.filter((b) => b.result === 'win').length;
  const l = settled.filter((b) => b.result === 'loss').length;
  const p = settled.filter((b) => b.result === 'push').length;
  const profit = settled.reduce((s, b) => s + Number(b.profit ?? 0), 0);
  const risked = settled.reduce((s, b) => s + Number(b.stake), 0);

  return (
    <>
      <h1>Bet tracker</h1>
      <p className="sub">Log bets from any game page. They grade automatically when the game goes final.</p>
      <div className="stats">
        <Stat k="Record" v={`${w}-${l}${p ? `-${p}` : ''}`} />
        <Stat k="Units" v={fmtSigned(profit, 2)} cls={signClass(profit)} />
        <Stat k="ROI" v={risked ? fmtSigned((profit / risked) * 100, 1) + '%' : '—'} cls={signClass(profit)} />
        <Stat k="Pending" v={bets.length - settled.length} />
      </div>
      {!bets.length ? <Empty>No bets yet. Open a game from the <Link href="/">slate</Link> to log one.</Empty> : (
        <div className="tablewrap">
          <table>
            <thead><tr><th>Game</th><th>Wk</th><th>Bet</th><th className="n">Price</th><th className="n">Stake</th><th>Result</th><th className="n">Profit</th><th>Notes</th><th></th></tr></thead>
            <tbody>
              {bets.map((b) => {
                const g = b.games;
                return (
                  <tr key={b.id}>
                    <td>{g ? <Link href={`/game/${g.id}`}>{teams.get(g.away_id)?.school} @ {teams.get(g.home_id)?.school}</Link> : '—'} <span className="muted">{g ? fmtKick(g.start_date) : ''}</span></td>
                    <td>{g?.week}</td>
                    <td>{b.market === 'total' ? <>{b.side === 'under' ? 'Under' : 'Over'} {b.spread}</> : <><Team t={teams.get(b.team_id)} /> {fmtSpread(b.spread)}</>}</td>
                    <td className="n">{fmtPrice(b.price)}</td>
                    <td className="n">{b.stake}</td>
                    <td>{b.result ? <span className={`badge ${b.result}`}>{b.result.toUpperCase()}</span> : <span className="muted">pending</span>}</td>
                    <td className={`n ${signClass(b.profit)}`}>{b.profit != null ? fmtSigned(b.profit, 2) : ''}</td>
                    <td className="muted">{b.notes}</td>
                    <td><form action={deleteBet}><input type="hidden" name="id" value={b.id} /><button className="danger" type="submit">×</button></form></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
