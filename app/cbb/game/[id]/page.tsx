import { notFound } from 'next/navigation';
import { db } from '@/lib/supabase';
import { getCbbSettings } from '@/lib/cbb/model';
import { cbbTeamMap, latestCbbRatings } from '@/lib/cbb/queries';
import { normCdf } from '@/lib/model/math';
import { addCbbBet } from '../../actions';
import { Stat, Team } from '../../../components';
import { fmtKick, fmtNum, fmtPct, fmtPrice, fmtSigned, fmtSpread, signClass } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function CbbGame({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { data: g } = await db().from('cbb_games').select('*').eq('id', id).maybeSingle();
  if (!g) notFound();
  const [teams, s, predRes, linesRes, { rows: ratings }] = await Promise.all([
    cbbTeamMap(), getCbbSettings(),
    db().from('cbb_predictions').select('*').eq('game_id', id).maybeSingle(),
    db().from('cbb_odds_lines').select('*').eq('game_id', id).order('captured_at', { ascending: true }),
    latestCbbRatings(g.season),
  ]);
  const p = predRes.data;
  const home = teams.get(g.home_id), away = teams.get(g.away_id);
  const rh = ratings.find((r) => r.team_id === g.home_id), ra = ratings.find((r) => r.team_id === g.away_id);
  const winProb = p?.model_margin != null ? normCdf(Number(p.model_margin) / s.sigma) : null;
  const pickHome = p?.pick_team_id === g.home_id;
  const srcKeys = [...new Set([...Object.keys(rh?.components ?? {}), ...Object.keys(ra?.components ?? {})])];

  return (
    <>
      <h1><Team t={away} base="/cbb/team" /> @ <Team t={home} base="/cbb/team" /></h1>
      <p className="sub">{fmtKick(g.start_date)}{g.neutral_site ? ' · Neutral site' : ''}{g.tournament ? ` · ${g.tournament}` : ''}{g.completed ? ` · Final ${g.away_points}-${g.home_points}` : ''}</p>
      <div className="stats">
        <Stat k="Model spread (home)" v={fmtSpread(p?.model_spread)} />
        <Stat k="DraftKings (home)" v={fmtSpread(p?.book_home_spread)} />
        <Stat k="Spread edge" v={fmtSigned(p?.edge)} cls={signClass(p?.edge)} />
        <Stat k="Spread pick" v={p?.pick_team_id ? `${teams.get(p.pick_team_id)?.school} ${fmtSpread(p.pick_spread)}` : '—'} />
        <Stat k={`${home?.school ?? 'Home'} win prob.`} v={fmtPct(winProb)} />
      </div>
      <div className="stats">
        <Stat k="Projected score" v={p ? `${fmtNum(p.away_points_proj)} – ${fmtNum(p.home_points_proj)}` : '—'} />
        <Stat k="Possessions" v={fmtNum(p?.possessions_proj)} />
        <Stat k="Model total" v={fmtNum(p?.model_total)} />
        <Stat k="DraftKings total" v={fmtNum(p?.book_total)} />
        <Stat k="Total edge" v={fmtSigned(p?.total_edge)} cls={signClass(p?.total_edge)} />
        <Stat k="Total pick" v={p?.total_pick ? `${p.total_pick === 'over' ? 'Over' : 'Under'} ${fmtNum(p.book_total)}` : '—'} />
      </div>

      <div className="grid">
        <div>
          <h2>Team ratings</h2>
          <div className="tablewrap"><table>
            <thead><tr><th></th><th className="n">{away?.school}</th><th className="n">{home?.school}</th></tr></thead>
            <tbody>
              <tr><td>Rank</td><td className="n">{ra?.rank ?? '—'}</td><td className="n">{rh?.rank ?? '—'}</td></tr>
              <tr><td>Net (per 100)</td><td className="n"><b>{fmtSigned(ra?.net)}</b></td><td className="n"><b>{fmtSigned(rh?.net)}</b></td></tr>
              <tr><td>AdjO</td><td className="n">{fmtNum(ra?.offense)}</td><td className="n">{fmtNum(rh?.offense)}</td></tr>
              <tr><td>AdjD</td><td className="n">{fmtNum(ra?.defense)}</td><td className="n">{fmtNum(rh?.defense)}</td></tr>
              <tr><td>Tempo</td><td className="n">{fmtNum(ra?.tempo)}</td><td className="n">{fmtNum(rh?.tempo)}</td></tr>
              {srcKeys.map((k) => (
                <tr key={k}><td className="muted">{k} net</td><td className="n muted">{fmtSigned(ra?.components?.[k])}</td><td className="n muted">{fmtSigned(rh?.components?.[k])}</td></tr>
              ))}
            </tbody>
          </table></div>
        </div>
        <div>
          <h2>Line history</h2>
          <div className="tablewrap"><table>
            <thead><tr><th>Captured</th><th className="n">Home spread</th><th className="n">Price</th><th className="n">Total</th><th className="n">O/U price</th></tr></thead>
            <tbody>
              {(linesRes.data ?? []).map((l) => (
                <tr key={l.id}><td className="muted">{fmtKick(l.captured_at)}</td><td className="n">{fmtSpread(l.home_spread)}</td>
                  <td className="n muted">{l.home_spread != null ? `${fmtPrice(l.home_price)} / ${fmtPrice(l.away_price)}` : ''}</td>
                  <td className="n">{fmtNum(l.total)}</td><td className="n muted">{l.total != null ? `${fmtPrice(l.over_price)} / ${fmtPrice(l.under_price)}` : ''}</td></tr>
              ))}
              {!linesRes.data?.length && <tr><td colSpan={5} className="muted">No DraftKings lines captured yet.</td></tr>}
            </tbody>
          </table></div>
        </div>
      </div>

      <h2>Log a spread bet</h2>
      <form action={addCbbBet} className="card formgrid">
        <input type="hidden" name="game_id" value={g.id} /><input type="hidden" name="market" value="spread" />
        <label>Team<select name="team_id" defaultValue={p?.pick_team_id ?? g.home_id}><option value={g.away_id}>{away?.school}</option><option value={g.home_id}>{home?.school}</option></select></label>
        <label>Spread (for that team)<input name="line" type="number" step="0.5" required defaultValue={p?.book_home_spread != null ? (pickHome || !p?.pick_team_id ? p.book_home_spread : -p.book_home_spread) : ''} /></label>
        <label>Price<input name="price" type="number" defaultValue={(pickHome ? p?.book_home_price : p?.book_away_price) ?? -110} /></label>
        <label>Stake (units)<input name="stake" type="number" step="0.1" defaultValue={1} /></label>
        <label>Book<input name="book" defaultValue="draftkings" /></label>
        <label>Notes<input name="notes" /></label>
        <button type="submit">Save bet</button>
      </form>
      <h2>Log a total bet</h2>
      <form action={addCbbBet} className="card formgrid">
        <input type="hidden" name="game_id" value={g.id} /><input type="hidden" name="market" value="total" />
        <label>Side<select name="side" defaultValue={p?.total_pick ?? 'over'}><option value="over">Over</option><option value="under">Under</option></select></label>
        <label>Total<input name="line" type="number" step="0.5" required defaultValue={p?.book_total ?? ''} /></label>
        <label>Price<input name="price" type="number" defaultValue={(p?.total_pick === 'under' ? p?.under_price : p?.over_price) ?? -110} /></label>
        <label>Stake (units)<input name="stake" type="number" step="0.1" defaultValue={1} /></label>
        <label>Book<input name="book" defaultValue="draftkings" /></label>
        <label>Notes<input name="notes" /></label>
        <button type="submit">Save bet</button>
      </form>
    </>
  );
}
