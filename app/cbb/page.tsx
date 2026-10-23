import Link from 'next/link';
import { db, selectAll } from '@/lib/supabase';
import { addDays, etDate } from '@/lib/cbb/ingest';
import { getCbbSettings } from '@/lib/cbb/model';
import { cbbTeamMap } from '@/lib/cbb/queries';
import { Empty, Stat, Team } from '../components';
import { fmtKick, fmtNum, fmtPct, fmtPrice, fmtSigned, fmtSpread, signClass } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function CbbSlate({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const sp = await searchParams;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(sp.date ?? '') ? sp.date : etDate();
  const market = sp.market === 'totals' ? 'totals' : 'spreads';
  const isTot = market === 'totals';
  const playsOnly = sp.plays === '1';
  const sort = sp.sort ?? 'edge';
  const [teams, s] = await Promise.all([cbbTeamMap(), getCbbSettings()]);

  const games = await selectAll<any>((a, b) => db().from('cbb_games').select('*').eq('game_date', date).order('start_date').range(a, b));
  const preds = await selectAll<any>((a, b) => db().from('cbb_predictions').select('*').eq('game_date', date).range(a, b));
  const pmap = new Map(preds.map((p) => [p.game_id, p]));
  const edgeOf = (p: any) => (isTot ? p?.total_edge : p?.edge) ?? -99;
  const playOf = (p: any) => !!(isTot ? p?.total_is_play : p?.is_play);
  const resOf = (p: any) => (isTot ? p?.total_result : p?.ats_result);

  let rows = games.map((g) => ({ g, p: pmap.get(g.id) }));
  if (playsOnly) rows = rows.filter((r) => playOf(r.p));
  rows.sort((a, b) => (sort === 'time' ? String(a.g.start_date).localeCompare(String(b.g.start_date)) : edgeOf(b.p) - edgeOf(a.p)));
  const plays = preds.filter(playOf), graded = plays.filter(resOf);
  const w = graded.filter((p) => resOf(p) === 'win').length, l = graded.filter((p) => resOf(p) === 'loss').length;
  const q = (o: Record<string, string>) => `/cbb?${new URLSearchParams({ date, market, ...(playsOnly ? { plays: '1' } : {}), sort, ...o })}`;
  const dayLabel = new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });

  return (
    <>
      <h1>{dayLabel}</h1>
      <div className="toolbar" style={{ marginTop: 6 }}>
        <Link href={q({ date: addDays(date, -1) })} className="badge">← Prev day</Link>
        <Link href={q({ date: etDate() })} className="badge">Today</Link>
        <Link href={q({ date: addDays(date, 1) })} className="badge">Next day →</Link>
      </div>
      <div className="tabs">
        <Link href={q({ market: 'spreads' })} className={`tab ${!isTot ? 'active' : ''}`}>Spreads</Link>
        <Link href={q({ market: 'totals' })} className={`tab ${isTot ? 'active' : ''}`}>Totals</Link>
      </div>
      <p className="sub">
        {isTot ? <>Projected total vs. DraftKings · plays at ≥ {s.total_edge_threshold} pts · σ {s.total_sigma}</>
          : <>Model spread vs. DraftKings · plays at ≥ {s.edge_threshold} pts · home court {s.hca} · σ {s.sigma}</>}
      </p>
      <div className="stats">
        <Stat k="Games" v={games.length} />
        <Stat k={isTot ? 'With DK total' : 'With DK line'} v={preds.filter((p) => (isTot ? p.book_total : p.book_home_spread) !== null).length} />
        <Stat k="Plays" v={plays.length} />
        <Stat k={isTot ? 'Plays O/U' : 'Plays ATS'} v={graded.length ? `${w}-${l}` : '—'} />
      </div>
      <form className="toolbar" method="get" action="/cbb">
        <input type="hidden" name="market" value={market} />
        <label>Date<input type="date" name="date" defaultValue={date} /></label>
        <label>Show<select name="plays" defaultValue={playsOnly ? '1' : '0'}><option value="0">All games</option><option value="1">Plays only</option></select></label>
        <label>Sort<select name="sort" defaultValue={sort}><option value="edge">Edge</option><option value="time">Tip-off</option></select></label>
        <button type="submit" className="secondary" style={{ alignSelf: 'flex-end' }}>Go</button>
      </form>
      {!games.length ? (
        <Empty>No games on this date. If the season has started, go to <Link href="/cbb/admin">Basketball Admin</Link> and run <b>Setup</b>, then <b>Daily</b>.</Empty>
      ) : (
        <div className="tablewrap">
          <table>
            <thead>
              {isTot ? (
                <tr><th>Tip (ET)</th><th>Away</th><th>Home</th><th className="n">Poss.</th><th className="n">Away proj</th><th className="n">Home proj</th>
                  <th className="n">Model total</th><th className="n">DK total</th><th className="n">Edge</th><th>Pick</th><th className="n">Win %</th><th className="n">EV/u</th><th>Result</th></tr>
              ) : (
                <tr><th>Tip (ET)</th><th>Away</th><th>Home</th><th className="n">Away net</th><th className="n">Home net</th>
                  <th className="n">Model (home)</th><th className="n">DK (home)</th><th className="n">Edge</th><th>Pick</th><th className="n">Cover %</th><th className="n">EV/u</th><th>Result</th></tr>
              )}
            </thead>
            <tbody>
              {rows.map(({ g, p }) => {
                const away = <Team t={teams.get(g.away_id)} base="/cbb/team" />, home = <Team t={teams.get(g.home_id)} base="/cbb/team" />;
                const tip = <td className="muted">{fmtKick(g.start_date)}{g.neutral_site ? ' · N' : ''}</td>;
                const score = g.completed ? <span className="muted">{isTot ? `${g.away_points + g.home_points} pts` : `${g.away_points}-${g.home_points}`}</span> : null;
                const res = resOf(p) ? <span className={`badge ${resOf(p)}`}>{String(resOf(p)).toUpperCase()}</span> : null;
                if (isTot) return (
                  <tr key={g.id} className={p?.total_is_play ? 'play' : ''}>
                    {tip}<td>{away}</td><td>{home}</td>
                    <td className="n muted">{fmtNum(p?.possessions_proj, 0)}</td>
                    <td className="n">{fmtNum(p?.away_points_proj)}</td><td className="n">{fmtNum(p?.home_points_proj)}</td>
                    <td className="n"><b>{fmtNum(p?.model_total)}</b></td>
                    <td className="n">{fmtNum(p?.book_total)} <span className="muted">{p?.book_total != null ? `${fmtPrice(p.over_price)}/${fmtPrice(p.under_price)}` : ''}</span></td>
                    <td className={`n ${signClass(p?.total_edge)}`}>{fmtSigned(p?.total_edge)}</td>
                    <td>{p?.total_pick ? <Link href={`/cbb/game/${g.id}`}>{p.total_pick === 'over' ? 'Over' : 'Under'} {fmtNum(p.book_total)}</Link> : <Link href={`/cbb/game/${g.id}`} className="muted">details</Link>}
                      {p?.total_is_play ? <> <span className="badge play">PLAY</span></> : null}</td>
                    <td className="n">{fmtPct(p?.total_prob)}</td>
                    <td className={`n ${signClass(p?.total_ev)}`}>{fmtSigned(p?.total_ev, 3)}</td>
                    <td>{score} {res}</td>
                  </tr>
                );
                const pickTeam = p?.pick_team_id ? teams.get(p.pick_team_id) : null;
                return (
                  <tr key={g.id} className={p?.is_play ? 'play' : ''}>
                    {tip}<td>{away}</td><td>{home}</td>
                    <td className="n">{fmtSigned(p?.away_net)}</td><td className="n">{fmtSigned(p?.home_net)}</td>
                    <td className="n"><b>{fmtSpread(p?.model_spread)}</b></td>
                    <td className="n">{fmtSpread(p?.book_home_spread)} <span className="muted">{fmtPrice(p?.book_home_price)}</span></td>
                    <td className={`n ${signClass(p?.edge)}`}>{fmtSigned(p?.edge)}</td>
                    <td>{pickTeam ? <Link href={`/cbb/game/${g.id}`}>{pickTeam.school} {fmtSpread(p.pick_spread)}</Link> : <Link href={`/cbb/game/${g.id}`} className="muted">details</Link>}
                      {p?.is_play ? <> <span className="badge play">PLAY</span></> : null}</td>
                    <td className="n">{fmtPct(p?.cover_prob)}</td>
                    <td className={`n ${signClass(p?.ev)}`}>{fmtSigned(p?.ev, 3)}</td>
                    <td>{score} {res}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="sub" style={{ marginTop: 10 }}>Net = points per 100 possessions better than an average D1 team. Predictions are made for today and the next two days and lock at tip-off.</p>
    </>
  );
}
