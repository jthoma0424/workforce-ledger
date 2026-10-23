'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { db } from '@/lib/supabase';
import { JOBS, JobName, runJob } from '@/lib/pipeline';
import { buildPredictions, calibrate } from '@/lib/model/compute';
import { currentSeason, currentWeek } from '@/lib/season';
import { normalizeName } from '@/lib/names';
import { parseManualCsv } from '@/lib/scrapers/parsers';
import { saveScraped } from '@/lib/scrapers';

// Pages are behind the password middleware, and server actions POST to those
// pages, so these are only reachable when signed in.

export async function runJobAction(form: FormData) {
  const job = String(form.get('job')) as JobName;
  if (!JOBS.includes(job)) throw new Error('bad job');
  const result = await runJob(job);
  revalidatePath('/', 'layout');
  redirect(`/admin?ran=${job}&ok=${result?.ok ? 1 : 0}`);
}

export async function saveSettings(form: FormData) {
  const n = (k: string) => Number(form.get(k));
  const res = await db().from('model_settings').update({
    hfa: n('hfa'), sigma: n('sigma'), edge_threshold: n('edge_threshold'),
    margin_cap: n('margin_cap'), prior_weight: n('prior_weight'), default_price: n('default_price'),
    total_sigma: n('total_sigma'), total_edge_threshold: n('total_edge_threshold'), points_cap: n('points_cap'),
    pace_weight: n('pace_weight'),
    updated_at: new Date().toISOString(),
  }).eq('id', 1);
  if (res.error) redirect(`/admin?error=${encodeURIComponent('Settings not saved: ' + res.error.message + ' (open /check to see which database update is missing)')}`);
  // Re-flag this week's games right away with the new thresholds (no outside API calls).
  const season = currentSeason();
  const { week } = await currentWeek(season);
  await buildPredictions(season, week);
  revalidatePath('/', 'layout');
  redirect('/admin?saved=settings and re-flagged this week');
}

export async function saveSources(form: FormData) {
  const keys = form.getAll('key').map(String);
  for (const key of keys) {
    const res = await db().from('rating_sources').update({
      weight: Number(form.get(`weight_${key}`)),
      scale: Number(form.get(`scale_${key}`)),
      enabled: form.get(`enabled_${key}`) === 'on',
    }).eq('key', key);
    if (res.error) redirect(`/admin?error=${encodeURIComponent('Sources not saved: ' + res.error.message)}`);
  }
  redirect('/admin?saved=sources');
}

export async function calibrateAction() {
  const r = await calibrate(currentSeason());
  await db().from('job_runs').insert({ job: 'calibrate', status: r.ok ? 'ok' : 'error', finished_at: new Date().toISOString(), detail: r });
  redirect('/admin?calibrated=1');
}

export async function applyCalibration(form: FormData) {
  const detail = JSON.parse(String(form.get('detail')));
  for (const [key, w] of Object.entries(detail.weights as Record<string, number>)) {
    await db().from('rating_sources').update({ weight: w }).eq('key', key);
  }
  await db().from('model_settings').update({ hfa: detail.hfa, sigma: detail.sigma }).eq('id', 1);
  redirect('/admin?saved=calibration');
}

export async function mapAlias(form: FormData) {
  const raw = String(form.get('raw_name'));
  const source = String(form.get('source'));
  const teamId = Number(form.get('team_id'));
  if (!teamId) redirect('/admin');
  await db().from('team_aliases').upsert({ alias: normalizeName(raw), team_id: teamId, source: 'manual' }, { onConflict: 'alias' });
  await db().from('unmatched_names').update({ resolved: true }).eq('source', source).eq('raw_name', raw);
  redirect('/admin?saved=alias');
}

export async function ignoreAlias(form: FormData) {
  await db().from('unmatched_names').update({ resolved: true }).eq('source', String(form.get('source'))).eq('raw_name', String(form.get('raw_name')));
  redirect('/admin');
}

export async function importManual(form: FormData) {
  const source = String(form.get('source') || 'manual');
  const items = parseManualCsv(String(form.get('csv') ?? ''));
  const season = currentSeason();
  const { week } = await currentWeek(season);
  const r = await saveScraped(source, season, week, items);
  await db().from('job_runs').insert({ job: `import:${source}`, status: 'ok', finished_at: new Date().toISOString(), detail: r });
  redirect('/admin?saved=import');
}

export async function addBet(form: FormData) {
  const gameId = Number(form.get('game_id'));
  const market = form.get('market') === 'total' ? 'total' : 'spread';
  await db().from('bets').insert({
    game_id: gameId,
    market,
    side: market === 'total' ? (form.get('side') === 'under' ? 'under' : 'over') : null,
    team_id: market === 'total' ? null : Number(form.get('team_id')),
    spread: Number(form.get('spread')),
    price: Number(form.get('price') || -110),
    stake: Number(form.get('stake') || 1),
    book: String(form.get('book') || 'draftkings'),
    notes: String(form.get('notes') || '') || null,
  });
  redirect('/bets');
}

export async function deleteBet(form: FormData) {
  await db().from('bets').delete().eq('id', Number(form.get('id')));
  revalidatePath('/bets');
}
