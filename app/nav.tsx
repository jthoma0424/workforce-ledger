'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const FOOTBALL = [
  ['/', 'Slate'], ['/rankings', 'Power Rankings'], ['/performance', 'Performance'], ['/bets', 'Bets'], ['/admin', 'Admin'],
];
const BASKETBALL = [
  ['/cbb', 'Slate'], ['/cbb/rankings', 'Power Rankings'], ['/cbb/performance', 'Performance'], ['/cbb/bets', 'Bets'], ['/cbb/admin', 'Admin'],
];

export function Nav() {
  const path = usePathname() ?? '/';
  const cbb = path === '/cbb' || path.startsWith('/cbb/');
  const links = cbb ? BASKETBALL : FOOTBALL;
  const active = (href: string) => (href === '/' || href === '/cbb' ? path === href : path.startsWith(href));
  return (
    <>
      <div className="sport">
        <Link href="/" className={!cbb ? 'on' : ''}>🏈 Football</Link>
        <Link href="/cbb" className={cbb ? 'on' : ''}>🏀 Basketball</Link>
      </div>
      <nav>
        {links.map(([href, label]) => (
          <Link key={href} href={href} className={active(href) ? 'here' : ''}>{label}</Link>
        ))}
      </nav>
    </>
  );
}
