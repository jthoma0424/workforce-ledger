export function fmtSpread(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return '—';
  const n = Number(v);
  if (n === 0) return 'PK';
  return (n > 0 ? '+' : '') + (Math.round(n * 10) / 10).toString();
}
export function fmtNum(v: number | null | undefined, d = 1): string {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return '—';
  return Number(v).toFixed(d);
}
export function fmtSigned(v: number | null | undefined, d = 1): string {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return '—';
  const n = Number(v);
  return (n > 0 ? '+' : '') + n.toFixed(d);
}
export function fmtPct(v: number | null | undefined, d = 1): string {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return '—';
  return (Number(v) * 100).toFixed(d) + '%';
}
export function fmtPrice(v: number | null | undefined): string {
  if (v === null || v === undefined) return '';
  return v > 0 ? `+${v}` : String(v);
}
export function fmtKick(iso: string | null): string {
  if (!iso) return 'TBD';
  return new Date(iso).toLocaleString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
}
export function signClass(v: number | null | undefined) {
  if (v === null || v === undefined) return '';
  return v > 0 ? 'pos' : v < 0 ? 'neg' : '';
}
