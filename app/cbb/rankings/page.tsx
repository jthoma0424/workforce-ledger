import { cbbCurrentSeason } from '@/lib/cbb/ingest';
import { getCbbSources } from '@/lib/cbb/model';
import { cbbTeamMap, latestCbbRatings } from '@/lib/cbb/queries';
import { Empty, Team } from '../../components';
import { fmtNum, fmtSigned, signClass } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function CbbRankings({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const sp = await searchParams;
  const season = sp.season ? Number(sp.season) : await cbbCurrentSeason();
  const conf = sp.conf ?? '';
  const [teams, sources, { asOf, rows: all }] = await Promise.all([cbbTeamMap(), getCbbSources(), latestCbbRatings(season)]);
  const active = sources.filter((s) => s.enabled && s.weight > 0);
  const ranked = all.filter((r) => r.rank !== null).sort((a, b) => a.rank - b.rank);
  const confs = [...new Set(ranked.map((r) => teams.get(r.team_id)?.conference).filter(Boolean))].sort() as string[];
  const rows = conf ? ranked.filter((r) => teams.get(r.team_id)?.conference === conf) : ranked;

  return (
    <>
      <h1>Basketball power rankings</h1>
      <p className="sub">
        Season {season - 1}–{String(season).slice(2)}{asOf ? ` · as of ${asOf}` : ''}. Net = points per 100 possessions better than an average D1 team.
        AdjO / AdjD = points scored / allowed per 100 possessions vs. an average opponent (lower AdjD is better). Tempo = possessions per game.
      </p>
      <form className="toolbar" method="get" action="/cbb/rankings">
        <label>Conference
          <select name="conf" defaultValue={conf}>
            <option value="">All D1</option>
            {confs.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <button type="submit" className="secondary" style={{ alignSelf: 'flex-end' }}>Go</button>
      </form>
      {!rows.length ? <Empty>No ratings yet. Run <b>Setup</b> and <b>Daily</b> on the Basketball Admin page.</Empty> : (
        <div className="tablewrap">
          <table>
            <thead><tr><th className="n">#</th><th>Team</th><th>Conf</th><th className="n">Net</th><th className="n">AdjO</th><th className="n">AdjD</th><th className="n">Tempo</th>
              {active.map((s) => <th key={s.key} className="n" title={s.name}>{s.key.toUpperCase()}</th>)}</tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.team_id}>
                  <td className="n">{r.rank}</td>
                  <td><Team t={teams.get(r.team_id)} base="/cbb/team" /></td>
                  <td className="muted">{teams.get(r.team_id)?.conference}</td>
                  <td className={`n ${signClass(r.net)}`}><b>{fmtSigned(r.net)}</b></td>
                  <td className="n">{fmtNum(r.offense)}</td>
                  <td className="n">{fmtNum(r.defense)}</td>
                  <td className="n muted">{fmtNum(r.tempo)}</td>
                  {active.map((s) => <td key={s.key} className="n muted">{fmtSigned(r.components?.[s.key])}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
