import Link from 'next/link';
import { db, selectAll } from '@/lib/supabase';
import { resolveWeek, teamMap } from '@/lib/queries';
import { getSettings } from '@/lib/model/compute';
import { Empty, Stat, Team, WeekPicker } from './components';
import { fmtKick, fmtNum, fmtPct, fmtPrice, fmtSigned, fmtSpread, signClass } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function Slate({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const sp = await searchParams;
  const { season, week, weeks } = await resolveWeek(sp);
  const market = sp.market === 'totals' ? 'totals' : 'spreads';
  const isTot = market === 'totals';
  const playsOnly = sp.plays === '1';
  const sort = sp.sort ?? 'edge';
  const [teams, settings] = await Promise.all([teamMap(), getSettings()]);

  const games = await selectAll<any>((a, b) => db().from('games').select('*').eq('season', season).eq('week', week).range(a, b));
  const preds = await selectAll<any>((a, b) => db().from('predictions').select('*').eq('season', season).eq('week', week).range(a, b));
  const pmap = new Map(preds.map((p) => [p.game_id, p]));

  const edgeOf = (p: any) => (isTot ? p?.total_edge : p?.edge) ?? -99;
  const playOf = (p: any) => !!(isTot ? p?.total_is_play : p?.is_play);
  const resultOf = (p: any) => (isTot ? p?.total_result : p?.ats_result);

  let rows = games.map((g) => ({ g, p: pmap.get(g.id) }));
  if (playsOnly) rows = rows.filter((r) => playOf(r.p));
  rows.sort((a, b) => (sort === 'time' ? String(a.g.start_date).localeCompare(String(b.g.start_date)) : edgeOf(b.p) - edgeOf(a.p)));

  const withLine = preds.filter((p) => (isTot ? p.book_total : p.book_home_spread) !== null);
  const plays = preds.filter(playOf);
  const graded = plays.filter(resultOf);
  const wins = graded.filter((p) => resultOf(p) === 'win').length;
  const losses = graded.filter((p) => resultOf(p) === 'loss').length;
  const tab = (m: string, label: string) => (
    <Link href={`/?season=${season}&week=${week}&market=${m}`} className={`tab ${market === m ? 'active' : ''}`}>{label}</Link>
  );

  return (
    <>
      <h1>Week {week} slate</h1>
      <div className="tabs">{tab('spreads', 'Spreads')}{tab('totals', 'Totals')}</div>
      <p className="sub">
        {isTot
          ? <>Projected total vs. DraftKings. Plays are flagged at ≥ {settings.total_edge_threshold} pts of edge · σ {settings.total_sigma}</>
          : <>Model spread vs. DraftKings. Plays are flagged at ≥ {settings.edge_threshold} pts of edge · HFA {settings.hfa} · σ {settings.sigma}</>}
      </p>
      <div className="stats">
        <Stat k="Games" v={games.length} />
        <Stat k={isTot ? 'With DK total' : 'With DK line'} v={withLine.length} />
        <Stat k="Plays" v={plays.length} />
        <Stat k={isTot ? 'Plays O/U (this week)' : 'Plays ATS (this week)'} v={graded.length ? `${wins}-${losses}` : '—'} />
      </div>
      <WeekPicker
        season={season} week={week} weeks={weeks} path="/"
        extra={
          <>
            <input type="hidden" name="market" value={market} />
            <label>Show<select name="plays" defaultValue={playsOnly ? '1' : '0'}><option value="0">All games</option><option value="1">Plays only</option></select></label>
            <label>Sort<select name="sort" defaultValue={sort}><option value="edge">Edge</option><option value="time">Kickoff</option></select></label>
          </>
        }
      />
      {!games.length ? (
        <Empty>No games for this week yet. Go to <Link href="/admin">Admin</Link> and run <b>Setup</b> then <b>Daily</b>.</Empty>
      ) : isTot ? (
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Kickoff (ET)</th><th>Away</th><th>Home</th>
                <th className="n">Away proj</th><th className="n">Home proj</th>
                <th className="n" title="Pace multiplier applied to the projection">Pace</th><th className="n">Model total</th><th className="n">DK total</th>
                <th className="n">Edge</th><th>Pick</th><th className="n">Win %</th><th className="n">EV/u</th><th>Result</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ g, p }) => (
                <tr key={g.id} className={p?.total_is_play ? 'play' : ''}>
                  <td className="muted">{fmtKick(g.start_date)}{g.neutral_site ? ' · N' : ''}</td>
                  <td><Team t={teams.get(g.away_id)} /></td>
                  <td><Team t={teams.get(g.home_id)} /></td>
                  <td className="n">{fmtNum(p?.away_points_proj)}</td>
                  <td className="n">{fmtNum(p?.home_points_proj)}</td>
                  <td className={`n ${p?.pace_factor > 1.005 ? 'pos' : p?.pace_factor < 0.995 ? 'neg' : 'muted'}`}>{p?.pace_factor != null ? `×${Number(p.pace_factor).toFixed(2)}` : '—'}</td>
                  <td className="n"><b>{fmtNum(p?.model_total)}</b></td>
                  <td className="n">
                    {fmtNum(p?.book_total)}{' '}
                    <span className="muted">{p?.book_total != null ? `${fmtPrice(p.over_price)}/${fmtPrice(p.under_price)}` : ''}</span>
                    {p?.total_book && !p.total_book.startsWith('draftkings') ? <span className="warn" title={`Line source: ${p.total_book}`}> *</span> : null}
                  </td>
                  <td className={`n ${signClass(p?.total_edge)}`}>{fmtSigned(p?.total_edge)}</td>
                  <td>
                    {p?.total_pick
                      ? <Link href={`/game/${g.id}`}>{p.total_pick === 'over' ? 'Over' : 'Under'} {fmtNum(p.book_total)}</Link>
                      : <Link href={`/game/${g.id}`} className="muted">details</Link>}
                    {p?.total_is_play ? <> <span className="badge play">PLAY</span></> : null}
                  </td>
                  <td className="n">{fmtPct(p?.total_prob)}</td>
                  <td className={`n ${signClass(p?.total_ev)}`}>{fmtSigned(p?.total_ev, 3)}</td>
                  <td>
                    {g.completed ? <span className="muted">{g.away_points + g.home_points} pts</span> : null}{' '}
                    {p?.total_result ? <span className={`badge ${p.total_result}`}>{p.total_result.toUpperCase()}</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Kickoff (ET)</th><th>Away</th><th>Home</th>
                <th className="n">Away rtg</th><th className="n">Home rtg</th>
                <th className="n">Model (home)</th><th className="n">DK (home)</th>
                <th className="n">Edge</th><th>Pick</th><th className="n">Cover %</th><th className="n">EV/u</th><th>Result</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ g, p }) => {
                const pickTeam = p?.pick_team_id ? teams.get(p.pick_team_id) : null;
                return (
                  <tr key={g.id} className={p?.is_play ? 'play' : ''}>
                    <td className="muted">{fmtKick(g.start_date)}{g.neutral_site ? ' · N' : ''}</td>
                    <td><Team t={teams.get(g.away_id)} /></td>
                    <td><Team t={teams.get(g.home_id)} /></td>
                    <td className="n">{fmtNum(p?.away_rating)}</td>
                    <td className="n">{fmtNum(p?.home_rating)}</td>
                    <td className="n"><b>{fmtSpread(p?.model_spread)}</b></td>
                    <td className="n">
                      {fmtSpread(p?.book_home_spread)}{' '}
                      <span className="muted">{fmtPrice(p?.book_home_price)}</span>
                      {p?.book && !p.book.startsWith('draftkings') ? <span className="warn" title={`Line source: ${p.book}`}> *</span> : null}
                    </td>
                    <td className={`n ${signClass(p?.edge)}`}>{fmtSigned(p?.edge)}</td>
                    <td>
                      {pickTeam ? <Link href={`/game/${g.id}`}>{pickTeam.school} {fmtSpread(p.pick_spread)}</Link> : <Link href={`/game/${g.id}`} className="muted">details</Link>}
                      {p?.is_play ? <> <span className="badge play">PLAY</span></> : null}
                    </td>
                    <td className="n">{fmtPct(p?.cover_prob)}</td>
                    <td className={`n ${signClass(p?.ev)}`}>{fmtSigned(p?.ev, 3)}</td>
                    <td>
                      {g.completed ? <span className="muted">{g.away_points}-{g.home_points}</span> : null}{' '}
                      {p?.ats_result ? <span className={`badge ${p.ats_result}`}>{p.ats_result.toUpperCase()}</span> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="sub" style={{ marginTop: 10 }}>
        <span className="warn">*</span> = no live DraftKings line yet; using CFBD&apos;s line instead. Predictions lock at kickoff.
      </p>
    </>
  );
}
