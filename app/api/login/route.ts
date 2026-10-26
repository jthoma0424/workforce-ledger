import { NextRequest, NextResponse } from 'next/server';
import { AUTH_COOKIE, authToken } from '@/lib/auth';

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const next = String(form.get('next') || '/');
  const safeNext = next.startsWith('/') && !next.startsWith('//') ? next : '/';
  if (String(form.get('password') ?? '') !== process.env.SITE_PASSWORD) {
    return NextResponse.redirect(new URL(`/login?error=1&next=${encodeURIComponent(safeNext)}`, req.url), 303);
  }
  const res = NextResponse.redirect(new URL(safeNext, req.url), 303);
  res.cookies.set(AUTH_COOKIE, await authToken(), {
    httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: 60 * 60 * 24 * 60,
  });
  return res;
}
