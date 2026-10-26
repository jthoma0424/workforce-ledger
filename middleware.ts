import { NextRequest, NextResponse } from 'next/server';
import { AUTH_COOKIE, authToken } from './lib/auth';

/** Password-gate every page. Cron routes authenticate with CRON_SECRET instead. */
export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (pathname.startsWith('/login') || pathname.startsWith('/api/login') || pathname.startsWith('/api/cron')) {
    return NextResponse.next();
  }
  if (!process.env.SITE_PASSWORD) {
    return new NextResponse('Set SITE_PASSWORD in your environment variables.', { status: 500 });
  }
  if (req.cookies.get(AUTH_COOKIE)?.value === (await authToken())) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.searchParams.set('next', pathname);
  return NextResponse.redirect(url);
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
