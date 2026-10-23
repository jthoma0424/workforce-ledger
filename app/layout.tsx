import './globals.css';
import Link from 'next/link';
import type { Metadata } from 'next';
import { Nav } from './nav';

export const metadata: Metadata = { title: 'CFB/CBB Model', description: 'College football and basketball power ratings vs. DraftKings' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="top">
          <Link href="/" className="brand">CFB/CBB Model</Link>
          <Nav />
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
