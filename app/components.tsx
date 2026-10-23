/* eslint-disable @next/next/no-img-element */
import Link from 'next/link';

export type TeamLite = { id: number; school: string; logo?: string | null; conference?: string | null };

export function Team({ t, link = true, base = '/team' }: { t?: TeamLite | null; link?: boolean; base?: string }) {
  if (!t) return <span className="muted">—</span>;
  const inner = (
    <span className="team">
      {t.logo ? <img src={t.logo} alt="" loading="lazy" /> : null}
      {t.school}
    </span>
  );
  return link ? <Link href={`${base}/${t.id}`}>{inner}</Link> : inner;
}

/** GET form so week selection lives in the URL. */
export function WeekPicker({ season, week, weeks, path, extra }: { season: number; week: number; weeks: number[]; path: string; extra?: React.ReactNode }) {
  return (
    <form className="toolbar" method="get" action={path}>
      <label>
        Season
        <input name="season" type="number" defaultValue={season} style={{ width: 90 }} />
      </label>
      <label>
        Week
        <select name="week" defaultValue={week}>
          {(weeks.length ? weeks : [week]).map((w) => (
            <option key={w} value={w}>Week {w}</option>
          ))}
        </select>
      </label>
      {extra}
      <button type="submit" className="secondary" style={{ alignSelf: 'flex-end' }}>Go</button>
    </form>
  );
}

export function Stat({ k, v, cls }: { k: string; v: React.ReactNode; cls?: string }) {
  return (
    <div className="stat">
      <div className="k">{k}</div>
      <div className={`v ${cls ?? ''}`}>{v}</div>
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="card muted">{children}</div>;
}
