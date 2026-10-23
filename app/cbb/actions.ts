'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { db } from '@/lib/supabase';
import { normalizeName } from '@/lib/names';
import { JOBS, JobName, runJob } from '@/lib/pipeline';
import { cbbCurrentSeason, importCbbManual } from '@/lib/cbb/ingest';
import { buildCbbPredictions } from '@/lib/cbb/model';

export async function runCbbJob(form: FormData) {
  const job = String(form.get('job')) as JobName;
  if (!JOBS.includes(job) || !job.startsWith('cbb_')) throw new Error('bad job');
  const r: any = await runJob(job);
  revalidatePath('/cbb', 'layout');
  redirect(`/cbb/admin?ran=${job}&ok=${r?.ok ? 1 : 0}`);
}

export async function saveCbbSettings(form: FormData) {
  const n = (k: string) => Number(form.get(k));
  const res = await db().from('cbb_settings').update({
    hca: n('hca'), sigma: n('sigma'), edge_threshold: n('edge_threshold'), total_sigma: n('total_sigma'),
    total_edge_threshold: n('total_edge_threshold'), prior_weight: n('prior_weight'), eff_cap: n('eff_cap'),
    tempo_prior_games: n('tempo_prior_games'), default_price: n('default_price'), updated_at: new Date().toISOString(),
  }).eq('id', 1);
  if (res.error) redirect(`/cbb/admin?error=${encodeURIComponent('Settings not saved: ' + res.error.message)}`);
  await buildCbbPredictions(await cbbCurrentSeason());
  revalidatePath('/cbb', 'layout');
  redirect('/cbb/admin?saved=settings and re-flagged upcoming games');
}

export async function saveCbbSources(form: FormData) {
  for (const key of form.getAll('key').map(String)) {
    const res = await db().from('cbb_sources').update({ weight: Number(form.get(`weight_${key}`)), enabled: form.get(`enabled_${key}`) === 'on' }).eq('key', key);
    if (res.error) redirect(`/cbb/admin?error=${encodeURIComponent('Sources not saved: ' + res.error.message)}`);
  }
  redirect('/cbb/admin?saved=sources (click Model to apply)');
}

export async function mapCbbAlias(form: FormData) {
  const raw = String(form.get('raw_name')), source = String(form.get('source')), teamId = Number(form.get('team_id'));
  if (!teamId) redirect('/cbb/admin');
  await db().from('cbb_aliases').upsert({ alias: normalizeName(raw), team_id: teamId, source: 'manual' }, { onConflict: 'alias' });
  await db().from('cbb_unmatched').update({ resolved: true }).eq('source', source).eq('raw_name', raw);
  redirect('/cbb/admin?saved=name');
}

export async function ignoreCbbAlias(form: FormData) {
  await db().from('cbb_unmatched').update({ resolved: true }).eq('source', String(form.get('source'))).eq('raw_name', String(form.get('raw_name')));
  redirect('/cbb/admin');
}

export async function importCbbRatings(form: FormData) {
  const r = await importCbbManual(await cbbCurrentSeason(), String(form.get('csv') ?? ''));
  await db().from('job_runs').insert({ job: 'cbb_import', status: 'ok', finished_at: new Date().toISOString(), detail: r });
  redirect(`/cbb/admin?saved=import (${r.imported} teams)`);
}

export async function addCbbBet(form: FormData) {
  const market = form.get('market') === 'total' ? 'total' : 'spread';
  await db().from('cbb_bets').insert({
    game_id: Number(form.get('game_id')), market,
    side: market === 'total' ? (form.get('side') === 'under' ? 'under' : 'over') : null,
    team_id: market === 'total' ? null : Number(form.get('team_id')),
    line: Number(form.get('line')), price: Number(form.get('price') || -110), stake: Number(form.get('stake') || 1),
    book: String(form.get('book') || 'draftkings'), notes: String(form.get('notes') || '') || null,
  });
  redirect('/cbb/bets');
}

export async function deleteCbbBet(form: FormData) {
  await db().from('cbb_bets').delete().eq('id', Number(form.get('id')));
  revalidatePath('/cbb/bets');
}
