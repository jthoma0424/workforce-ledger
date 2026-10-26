import { db, selectAll } from '@/lib/supabase';
import { resolveWeek, teamMap } from '@/lib/queries';
import { getSources } from '@/lib/model/compute';
import { Empty, Team, WeekPicker } from '../components';
import { fmtNum, fmtSigned, signClass } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function Rankings({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const sp = await searchParams;
  const { season, week, weeks } = await resolveWeek(sp);
  const conf = sp.conf ?? '';
  const [teams, sources] = await Promise.all([teamMap(), getSources()]);
  const active = sources.filter((s) => s.enabled && s.weight > 0);

  const cur = await selectAll<any>((a, b) => db().from('power_ratings').select('*').eq('season', season).eq('week', week).not('rank', 'is', null).order('rank').range(a, b));
  const prevWeek = weeks.filter((w) => w < week).pop();
  const prev = prevWeek
    ? await selectAll<any>((a, b) => db().from('power_ratings').select('team_id,rank,rating').eq('season', season).eq('week', prevWeek).range(a, b))
    : [];
  const prevMap = new Map(prev.map((p) => [p.team_id, p]));
  const confs = [...new Set(cur.map((r) => teams.get(r.team_id)?.conference).filter(Boolean))].sort() as string[];
  const rows = conf ? cur.filter((r) => teams.get(r.team_id)?.conference === conf) : cur;
  const max = Math.max(...cur.map((r) => Math.abs(Number(r.rating))), 1);

  return (
    <>
      <h1>Power rankings</h1>
      <p className="sub">Points better than an average FBS team on a neutral field. Rating A − Rating B (+ HFA) = projected margin. Off/Def drive the totals: Off = points scored above average, Def = points allowed above average (negative is good). Pace = plays per game, both teams combined.</p>
      <WeekPicker
        season={season} week={week} weeks={weeks} path="/rankings"
        extra={
          <label>Conference
            <select name="conf" defaultValue={conf}>
              <option value="">All FBS</option>
              {confs.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
        }
      />
      {!rows.length ? (
        <Empty>No ratings for week {week}. Run the <b>Model</b> job on the Admin page.</Empty>
      ) : (
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th className="n">#</th><th className="n">Δ</th><th>Team</th><th>Conf</th>
                <th className="n">Rating</th><th></th><th className="n" title="Points scored vs. avg defense, above FBS average">Off</th><th className="n" title="Points allowed vs. avg offense, relative to FBS average (negative = better)">Def</th><th className="n" title="Plays per game, both teams combined">Pace</th>
                {active.map((s) => <th key={s.key} className="n" title={s.name}>{s.key.toUpperCase()}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const t = teams.get(r.team_id);
                const p = prevMap.get(r.team_id);
                const move = p?.rank ? p.rank - r.rank : null;
                return (
                  <tr key={r.team_id}>
                    <td className="n">{r.rank}</td>
                    <td className={`n ${signClass(move)}`}>{move ? (move > 0 ? `▲${move}` : `▼${-move}`) : ''}</td>
                    <td><Team t={t} /></td>
                    <td className="muted">{t?.conference}</td>
                    <td className="n"><b>{fmtSigned(r.rating)}</b></td>
                    <td style={{ width: 120 }}>
                      <div className="bar"><span style={{ width: `${Math.max(0, (Number(r.rating) + max) / (2 * max)) * 100}%` }} /></div>
                    </td>
                    <td className={`n ${signClass(r.offense)}`}>{fmtSigned(r.offense)}</td>
                    <td className={`n ${signClass(r.defense === null ? null : -r.defense)}`}>{fmtSigned(r.defense)}</td>
                    <td className="n muted">{fmtNum(r.pace, 0)}</td>
                    {active.map((s) => <td key={s.key} className="n muted">{fmtNum(r.components?.[s.key])}</td>)}
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
