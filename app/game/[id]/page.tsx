import { notFound } from 'next/navigation';
import { db } from '@/lib/supabase';
import { teamMap } from '@/lib/queries';
import { getSettings, getSources } from '@/lib/model/compute';
import { normCdf } from '@/lib/model/math';
import { addBet } from '../../actions';
import { Stat, Team } from '../../components';
import { fmtKick, fmtNum, fmtPct, fmtPrice, fmtSigned, fmtSpread, signClass } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function GamePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { data: g } = await db().from('games').select('*').eq('id', id).single();
  if (!g) notFound();
  const [teams, sources, settings, predRes, linesRes, prRes] = await Promise.all([
    teamMap(), getSources(), getSettings(),
    db().from('predictions').select('*').eq('game_id', id).maybeSingle(),
    db().from('odds_lines').select('*').eq('game_id', id).order('captured_at', { ascending: true }),
    db().from('power_ratings').select('*').eq('season', g.season).eq('week', g.week).in('team_id', [g.home_id, g.away_id]),
  ]);
  const p = predRes.data;
  const home = teams.get(g.home_id), away = teams.get(g.away_id);
  const pr = new Map((prRes.data ?? []).map((r) => [r.team_id, r]));
  const hr = pr.get(g.home_id), ar = pr.get(g.away_id);
  const active = sources.filter((s) => s.enabled);
  const hfa = g.neutral_site ? 0 : settings.hfa;
  const winProb = p?.model_margin != null ? normCdf(Number(p.model_margin) / settings.sigma) : null;
  const pickHome = p?.pick_team_id === g.home_id;

  return (
    <>
      <h1><Team t={away} /> @ <Team t={home} /></h1>
      <p className="sub">{fmtKick(g.start_date)} · Week {g.week}{g.neutral_site ? ' · Neutral site' : ''}{g.completed ? ` · Final ${g.away_points}-${g.home_points}` : ''}</p>

      <div className="stats">
        <Stat k="Model spread (home)" v={fmtSpread(p?.model_spread)} />
        <Stat k={`Line (${p?.book ?? 'none'})`} v={fmtSpread(p?.book_home_spread)} />
        <Stat k="Edge" v={fmtSigned(p?.edge)} cls={signClass(p?.edge)} />
        <Stat k="Pick" v={p?.pick_team_id ? `${teams.get(p.pick_team_id)?.school} ${fmtSpread(p.pick_spread)}` : '—'} />
        <Stat k="Cover prob." v={fmtPct(p?.cover_prob)} />
        <Stat k={`${home?.school} win prob.`} v={fmtPct(winProb)} />
      </div>
      <div className="stats">
        <Stat k="Projected score" v={p?.model_total != null ? `${fmtNum(p.away_points_proj)} – ${fmtNum(p.home_points_proj)}` : '—'} />
        <Stat k="Model total" v={fmtNum(p?.model_total)} />
        <Stat k={`Total (${p?.total_book ?? 'none'})`} v={fmtNum(p?.book_total)} />
        <Stat k="Total edge" v={fmtSigned(p?.total_edge)} cls={signClass(p?.total_edge)} />
        <Stat k="Total pick" v={p?.total_pick ? `${p.total_pick === 'over' ? 'Over' : 'Under'} ${fmtNum(p.book_total)}` : '—'} />
        <Stat k="Total win prob." v={fmtPct(p?.total_prob)} />
        <Stat k="Pace (plays/game)" v={`${fmtNum(ar?.pace, 0)} / ${fmtNum(hr?.pace, 0)}`} />
        <Stat k="Pace factor" v={p?.pace_factor != null ? `×${Number(p.pace_factor).toFixed(3)}` : '—'} />
      </div>

      <div className="grid">
        <div>
          <h2>Rating breakdown</h2>
          <div className="tablewrap">
            <table>
              <thead><tr><th>Source</th><th className="n">{away?.school}</th><th className="n">{home?.school}</th><th className="n">Home margin</th></tr></thead>
              <tbody>
                {active.map((s) => {
                  const a = ar?.components?.[s.key], h = hr?.components?.[s.key];
                  const m = a != null && h != null ? h - a + hfa : null;
                  return (
                    <tr key={s.key}>
                      <td>{s.name} <span className="muted">w={s.weight}</span></td>
                      <td className="n">{fmtNum(a)}</td><td className="n">{fmtNum(h)}</td>
                      <td className={`n ${signClass(m)}`}>{fmtSigned(m)}</td>
                    </tr>
                  );
                })}
                <tr>
                  <td><b>Composite</b> <span className="muted">(HFA {hfa})</span></td>
                  <td className="n"><b>{fmtNum(ar?.rating)}</b></td><td className="n"><b>{fmtNum(hr?.rating)}</b></td>
                  <td className="n"><b>{fmtSigned(p?.model_margin)}</b></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <div>
          <h2>Line history</h2>
          <div className="tablewrap">
            <table>
              <thead><tr><th>Captured</th><th>Book</th><th className="n">Home spread</th><th className="n">Price</th><th className="n">Total</th><th className="n">O/U price</th></tr></thead>
              <tbody>
                {(linesRes.data ?? []).map((l) => (
                  <tr key={l.id}>
                    <td className="muted">{fmtKick(l.captured_at)}</td><td>{l.book}</td>
                    <td className="n">{fmtSpread(l.home_spread)}</td><td className="n muted">{l.home_spread != null ? `${fmtPrice(l.home_price)} / ${fmtPrice(l.away_price)}` : ''}</td>
                    <td className="n">{fmtNum(l.total)}</td><td className="n muted">{l.total != null ? `${fmtPrice(l.over_price)} / ${fmtPrice(l.under_price)}` : ''}</td>
                  </tr>
                ))}
                {!linesRes.data?.length && <tr><td colSpan={6} className="muted">No lines captured yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <h2>Log a spread bet</h2>
      <form action={addBet} className="card formgrid">
        <input type="hidden" name="game_id" value={g.id} />
        <input type="hidden" name="market" value="spread" />
        <label>Team
          <select name="team_id" defaultValue={p?.pick_team_id ?? g.home_id}>
            <option value={g.away_id}>{away?.school}</option>
            <option value={g.home_id}>{home?.school}</option>
          </select>
        </label>
        <label>Spread (for that team)
          <input name="spread" type="number" step="0.5" required
            defaultValue={p?.book_home_spread != null ? (pickHome || !p?.pick_team_id ? p.book_home_spread : -p.book_home_spread) : ''} />
        </label>
        <label>Price<input name="price" type="number" defaultValue={(pickHome ? p?.book_home_price : p?.book_away_price) ?? -110} /></label>
        <label>Stake (units)<input name="stake" type="number" step="0.1" defaultValue={1} /></label>
        <label>Book<input name="book" defaultValue="draftkings" /></label>
        <label>Notes<input name="notes" /></label>
        <button type="submit">Save bet</button>
      </form>

      <h2>Log a total bet</h2>
      <form action={addBet} className="card formgrid">
        <input type="hidden" name="game_id" value={g.id} />
        <input type="hidden" name="market" value="total" />
        <label>Side
          <select name="side" defaultValue={p?.total_pick ?? 'over'}>
            <option value="over">Over</option>
            <option value="under">Under</option>
          </select>
        </label>
        <label>Total<input name="spread" type="number" step="0.5" required defaultValue={p?.book_total ?? ''} /></label>
        <label>Price<input name="price" type="number" defaultValue={(p?.total_pick === 'under' ? p?.under_price : p?.over_price) ?? -110} /></label>
        <label>Stake (units)<input name="stake" type="number" step="0.1" defaultValue={1} /></label>
        <label>Book<input name="book" defaultValue="draftkings" /></label>
        <label>Notes<input name="notes" /></label>
        <button type="submit">Save bet</button>
      </form>
    </>
  );
}
