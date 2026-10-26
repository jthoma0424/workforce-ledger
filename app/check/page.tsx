import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

// Setup checker: open /check on your site to see exactly what's misconfigured.
// It never shows the values of your keys, only whether they look right.

type Row = { name: string; ok: boolean; detail: string };

function keyKind(key: string): string {
  if (key.startsWith('sb_secret_')) return 'secret';
  if (key.startsWith('sb_publishable_')) return 'publishable';
  try {
    const payload = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString());
    return payload.role ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export default async function Check() {
  const rows: Row[] = [];
  const env = (k: string) => (process.env[k] ?? '').trim();

  for (const k of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'CFBD_API_KEY', 'ODDS_API_KEY', 'SITE_PASSWORD', 'CRON_SECRET']) {
    const v = env(k);
    const raw = process.env[k] ?? '';
    rows.push({
      name: `Variable ${k}`,
      ok: !!v && raw === v && !/^["']|["']$/.test(v),
      detail: !v ? 'MISSING. Add it in Vercel, then redeploy.'
        : raw !== v ? 'Has a space before or after it. Remove it, then redeploy.'
        : /^["']|["']$/.test(v) ? 'Has quote marks around it. Remove them, then redeploy.'
        : `Set (${v.length} characters)`,
    });
  }

  const url = env('SUPABASE_URL');
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  const urlOk = /^https:\/\/[a-z0-9]+\.supabase\.co\/?$/.test(url);
  rows.push({
    name: 'Supabase URL format',
    ok: urlOk,
    detail: urlOk ? url : `Looks wrong: "${url.slice(0, 60)}". It should look like https://abcdefghijkl.supabase.co (Supabase → Project Settings → API).`,
  });

  const kind = key ? keyKind(key) : 'missing';
  const keyOk = kind === 'service_role' || kind === 'secret';
  rows.push({
    name: 'Supabase key type',
    ok: keyOk,
    detail: keyOk ? `${kind} key, correct`
      : `This is a "${kind}" key. You need the service_role key (or the sb_secret_ key), not the anon/publishable one.`,
  });

  if (url && key) {
    try {
      const db = createClient(url.replace(/\/$/, ''), key, { auth: { persistSession: false } });
      for (const table of ['teams', 'games', 'rating_sources', 'model_settings', 'predictions']) {
        const { count, error } = await db.from(table).select('*', { count: 'exact', head: true });
        rows.push({
          name: `Table ${table}`,
          ok: !error,
          detail: error
            ? `${error.message || 'error'}${/schema cache|does not exist|relation/i.test(error.message) ? ' → Run supabase/migrations/0001_schema.sql in the Supabase SQL Editor.' : ''}`
            : `${count ?? 0} rows`,
        });
        if (error) break;
      }
      const { error: colErr } = await db.from('predictions').select('total_pick').limit(1);
      rows.push({
        name: 'Totals update (0002_totals.sql)',
        ok: !colErr,
        detail: colErr ? 'Not run yet → paste supabase/migrations/0002_totals.sql into the Supabase SQL Editor and click Run.' : 'Installed',
      });
      const { error: paceErr } = await db.from('predictions').select('pace_factor').limit(1);
      rows.push({
        name: 'Pace update (0003_pace.sql)',
        ok: !paceErr,
        detail: paceErr ? 'Not run yet → paste supabase/migrations/0003_pace.sql into the Supabase SQL Editor and click Run.' : 'Installed',
      });
      const { error: cbbErr } = await db.from('cbb_settings').select('id').limit(1);
      rows.push({
        name: 'Basketball update (0004_basketball.sql)',
        ok: !cbbErr,
        detail: cbbErr ? 'Not run yet → paste supabase/migrations/0004_basketball.sql into the Supabase SQL Editor and click Run.' : 'Installed',
      });
    } catch (e: any) {
      rows.push({ name: 'Connect to Supabase', ok: false, detail: e?.message ?? String(e) });
    }
  }

  const allOk = rows.every((r) => r.ok);
  return (
    <>
      <h1>Setup check</h1>
      <p className="sub">{allOk ? 'Everything looks right. Go to Admin and click Setup, then Daily.' : 'Fix the red items below. After changing anything in Vercel, redeploy and reload this page.'}</p>
      <div className="tablewrap">
        <table>
          <thead><tr><th>Check</th><th>Status</th><th>Detail</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name}>
                <td>{r.name}</td>
                <td className={r.ok ? 'pos' : 'neg'}>{r.ok ? 'OK' : 'FIX'}</td>
                <td style={{ whiteSpace: 'normal' }}>{r.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
