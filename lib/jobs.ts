import { db } from './supabase';

/** Run a job and record it in job_runs (visible on the Admin page). */
export async function runLogged<T extends object>(job: string, fn: () => Promise<T>): Promise<T & { ok: boolean; error?: string }> {
  const ins = await db().from('job_runs').insert({ job }).select('id').single();
  const id = ins.data?.id;
  try {
    const detail = await fn();
    if (id) await db().from('job_runs').update({ finished_at: new Date().toISOString(), status: 'ok', detail }).eq('id', id);
    return { ...detail, ok: true };
  } catch (e: any) {
    const error = e?.message ?? String(e);
    if (id) await db().from('job_runs').update({ finished_at: new Date().toISOString(), status: 'error', detail: { error } }).eq('id', id);
    return { ok: false, error } as any;
  }
}
