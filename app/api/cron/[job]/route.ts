import { NextRequest, NextResponse } from 'next/server';
import { JOBS, JobName, runJob } from '@/lib/pipeline';

export const dynamic = 'force-dynamic';
export const maxDuration = 300; // seconds; Vercel caps this by plan

/** Vercel Cron calls these with `Authorization: Bearer $CRON_SECRET`. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ job: string }> }) {
  const { job } = await params;
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!JOBS.includes(job as JobName)) return NextResponse.json({ error: `unknown job; use one of ${JOBS.join(', ')}` }, { status: 404 });
  const result = await runJob(job as JobName);
  return NextResponse.json(result);
}
