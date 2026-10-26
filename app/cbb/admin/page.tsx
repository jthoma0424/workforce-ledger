import { db } from '@/lib/supabase';
import { cbbCurrentSeason } from '@/lib/cbb/ingest';
import { getCbbSettings, getCbbSources } from '@/lib/cbb/model';
import { cbbTeamMap } from '@/lib/cbb/queries';
import { ignoreCbbAlias, importCbbRatings, mapCbbAlias, runCbbJob, saveCbbSettings, saveCbbSources } from '../actions';
import { RunButton } from '../../admin/run-button';
import { fmtKick } from '@/lib/format';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const JOBS: [string, string, string][] = [
  ['cbb_setup', 'Setup', 'Teams, the season schedule and box scores so far, last season’s ratings. Run once per season.'],
  ['cbb_daily', 'Daily', 'Recent/upcoming games, CBBD + Torvik ratings, DraftKings lines, model.'],
  ['cbb_lines', 'Lines', 'DraftKings spreads + totals (2 Odds API credits) and rebuild predictions.'],
  ['cbb_model', 'Model', 'Grade results, rebuild ratings, update predictions (no outside calls).'],
];

export default async function CbbAdmin({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const sp = await searchParams;
  let season: number | null = null, err: string | null = null;
  try { season = await cbbCurrentSeason(); } catch (e: any) { err = e.message; }
  const [s, sources, teams, runs, unmatched] = await Promise.all([
    getCbbSettings(), getCbbSources(), cbbTeamMap(),
    db().from('job_runs').select('*').like('job', 'cbb%').order('started_at', { ascending: false }).limit(12),
    db().from('cbb_unmatched').select('*').eq('resolved', false).order('last_seen', { ascending: false }).limit(50),
  ]);
  const d1 = [...teams.values()].filter((t) => t.d1).sort((a, b) => a.school.localeCompare(b.school));

  return (
    <>
      <h1>Basketball admin</h1>
      <p className="sub">Season {season ? `${season - 1}–${String(season).slice(2)}` : '—'}{sp.ran ? ` · ran ${sp.ran}: ${sp.ok === '1' ? 'ok' : 'error (see log)'}` : ''}{sp.saved ? ` · saved ${sp.saved}` : ''}</p>
      {(sp.error || err) && <div className="card neg" style={{ marginBottom: 12 }}>{sp.error || err}</div>}

      <h2>Run jobs</h2>
      <div className="card" style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        {JOBS.map(([job, label, help]) => (
          <form key={job} action={runCbbJob} title={help}><input type="hidden" name="job" value={job} /><RunButton label={label} primary={job === 'cbb_daily'} /></form>
        ))}
      </div>
      <p className="sub" style={{ marginTop: 6 }}>{JOBS.map(([, l, h]) => `${l}: ${h}`).join('  ·  ')}</p>

      <h2>Recent basketball job runs</h2>
      <div className="tablewrap"><table>
        <thead><tr><th>Job</th><th>Started</th><th>Status</th><th>Detail</th></tr></thead>
        <tbody>
          {(runs.data ?? []).map((r) => (
            <tr key={r.id}><td>{r.job}</td><td className="muted">{fmtKick(r.started_at)}</td>
              <td className={r.status === 'ok' ? 'pos' : r.status === 'error' ? 'neg' : 'muted'}>{r.status ?? 'running'}</td>
              <td><pre className="small">{JSON.stringify(r.detail)?.slice(0, 600)}</pre></td></tr>
          ))}
          {!runs.data?.length && <tr><td colSpan={4} className="muted">No basketball jobs yet. Click Setup, then Daily.</td></tr>}
        </tbody>
      </table></div>

      <div className="grid">
        <div>
          <h2>Model settings</h2>
          <form action={saveCbbSettings} className="card formgrid">
            <label>Home court (pts)<input name="hca" type="number" step="0.1" defaultValue={s.hca} /></label>
            <label>Spread σ (pts)<input name="sigma" type="number" step="0.1" defaultValue={s.sigma} /></label>
            <label>Spread play threshold<input name="edge_threshold" type="number" step="0.5" defaultValue={s.edge_threshold} /></label>
            <label>Totals σ (pts)<input name="total_sigma" type="number" step="0.1" defaultValue={s.total_sigma} /></label>
            <label>Totals play threshold<input name="total_edge_threshold" type="number" step="0.5" defaultValue={s.total_edge_threshold} /></label>
            <label>Prior weight (games)<input name="prior_weight" type="number" step="0.5" defaultValue={s.prior_weight} /></label>
            <label>Efficiency cap (per 100)<input name="eff_cap" type="number" step="1" defaultValue={s.eff_cap} /></label>
            <label>Tempo prior (games)<input name="tempo_prior_games" type="number" step="0.5" defaultValue={s.tempo_prior_games} /></label>
            <label>Default price<input name="default_price" type="number" defaultValue={s.default_price} /></label>
            <button type="submit">Save</button>
          </form>
        </div>
        <div>
          <h2>Rating sources</h2>
          <form action={saveCbbSources}>
            <div className="tablewrap"><table>
              <thead><tr><th>Source</th><th className="n">Weight</th><th>On</th><th>Notes</th></tr></thead>
              <tbody>
                {sources.map((x) => (
                  <tr key={x.key}><td><input type="hidden" name="key" value={x.key} />{x.name}</td>
                    <td className="n"><input name={`weight_${x.key}`} type="number" step="0.05" defaultValue={x.weight} style={{ width: 80 }} /></td>
                    <td><input name={`enabled_${x.key}`} type="checkbox" defaultChecked={x.enabled} /></td>
                    <td className="muted" style={{ whiteSpace: 'normal' }}>{x.notes}</td></tr>
                ))}
              </tbody>
            </table></div>
            <button type="submit" style={{ marginTop: 10 }}>Save sources</button>
          </form>
        </div>
      </div>

      <div className="grid">
        <div>
          <h2>Unmatched team names ({unmatched.data?.length ?? 0})</h2>
          <div className="tablewrap"><table>
            <thead><tr><th>Source</th><th>Name</th><th>Map to</th><th></th></tr></thead>
            <tbody>
              {(unmatched.data ?? []).map((u) => (
                <tr key={u.source + u.raw_name}>
                  <td className="muted">{u.source}</td><td>{u.raw_name}</td>
                  <td><form action={mapCbbAlias} className="inline">
                    <input type="hidden" name="raw_name" value={u.raw_name} /><input type="hidden" name="source" value={u.source} />
                    <select name="team_id" defaultValue=""><option value="">Choose team…</option>{d1.map((t) => <option key={t.id} value={t.id}>{t.school}</option>)}</select>
                    <button type="submit" className="secondary">Map</button>
                  </form></td>
                  <td><form action={ignoreCbbAlias}><input type="hidden" name="raw_name" value={u.raw_name} /><input type="hidden" name="source" value={u.source} /><button type="submit" className="danger">ignore</button></form></td>
                </tr>
              ))}
              {!unmatched.data?.length && <tr><td colSpan={4} className="muted">All names matched.</td></tr>}
            </tbody>
          </table></div>
        </div>
        <div>
          <h2>Import ratings (e.g. KenPom)</h2>
          <form action={importCbbRatings} className="card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <textarea name="csv" placeholder={'Paste rows: Team, AdjO, AdjD, AdjT\nDuke, 124.1, 89.0, 66.2\nHouston, 118.7, 87.4, 62.9'} />
            <button type="submit">Import into “manual”</button>
            <span className="muted">Then give the Manual source a weight above 0 and click Model.</span>
          </form>
        </div>
      </div>
    </>
  );
}
