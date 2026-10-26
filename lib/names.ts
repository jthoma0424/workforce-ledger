import { db, selectAll, upsertChunked } from './supabase';

/** Normalize a team name so different sites' spellings collide. */
export function normalizeName(raw: string): string {
  let s = raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip accents (San José -> San Jose)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\bu\.?s\.?c\.?\b/g, 'usc')
    .replace(/['’`]/g, '')
    .replace(/[().,]/g, ' ')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  s = s.replace(/\bst$/, 'state').replace(/\bst (?=\w)/, (m, off) => (off === 0 ? 'saint ' : 'state '));
  s = s.replace(/\buniv(ersity)?\b/g, '').replace(/\s+/g, ' ').trim();
  return s;
}

/** Cross-site spellings CFBD's alternate names often miss. Keys are raw; values are CFBD school names. */
export const KNOWN_VARIANTS: Record<string, string> = {
  'Miami-Ohio': 'Miami (OH)', 'Miami Ohio': 'Miami (OH)', 'Miami OH': 'Miami (OH)', 'Miami (Ohio)': 'Miami (OH)',
  'Miami-Florida': 'Miami', 'Miami Florida': 'Miami', 'Miami FL': 'Miami', 'Miami (FL)': 'Miami',
  'Louisiana-Monroe': 'UL Monroe', 'ULM': 'UL Monroe', 'Louisiana Monroe': 'UL Monroe',
  'Louisiana-Lafayette': 'Louisiana', 'UL Lafayette': 'Louisiana', 'Louisiana Lafayette': 'Louisiana', 'Louisiana Ragin Cajuns': 'Louisiana',
  'Southern Mississippi': 'Southern Miss', 'Appalachian State': 'App State', 'Appalachian St': 'App State',
  'Massachusetts': 'UMass', 'Connecticut': 'UConn', 'Texas-El Paso': 'UTEP', 'UTSA': 'UTSA', 'Texas-San Antonio': 'UTSA',
  'Central Florida': 'UCF', 'Brigham Young': 'BYU', 'Southern California': 'USC', 'Louisiana State': 'LSU',
  'Mississippi': 'Ole Miss', 'Florida International': 'Florida International', 'FIU': 'Florida International',
  'Nevada-Las Vegas': 'UNLV', 'Alabama-Birmingham': 'UAB', 'Southern Methodist': 'SMU', 'Texas Christian': 'TCU',
  'North Carolina State': 'NC State', 'N.C. State': 'NC State', 'Sam Houston State': 'Sam Houston', 'Hawaii': "Hawai'i",
  'San Jose State': 'San José State', 'Middle Tennessee State': 'Middle Tennessee', 'MTSU': 'Middle Tennessee',
  'Florida Atlantic': 'Florida Atlantic', 'FAU': 'Florida Atlantic', 'WKU': 'Western Kentucky', 'Army West Point': 'Army',
  'Pitt': 'Pittsburgh', 'UConn Huskies': 'UConn', 'Ga. Southern': 'Georgia Southern', 'Coastal Carolina': 'Coastal Carolina',
  'Kent': 'Kent State', 'Bowling Green State': 'Bowling Green', 'Northern Illinois': 'Northern Illinois', 'NIU': 'Northern Illinois',
  'Virginia Tech': 'Virginia Tech', 'Southern Methodist Mustangs': 'SMU', 'Texas A&M-Commerce': 'East Texas A&M',
};

type TeamRow = { id: number; school: string; mascot: string | null; alt_names: string[] | null; classification: string | null };

/** Generate the alias set we auto-register for a CFBD team. */
export function aliasesForTeam(t: TeamRow): string[] {
  const names = new Set<string>();
  names.add(t.school);
  if (t.mascot) names.add(`${t.school} ${t.mascot}`);
  for (const a of t.alt_names ?? []) {
    if (a && a.length > 3) names.add(a); // skip short abbreviations (too ambiguous)
    if (a && t.mascot && a.length > 3) names.add(`${a} ${t.mascot}`);
  }
  return [...names].map(normalizeName).filter(Boolean);
}

/** Loads all aliases once, then resolves names; records misses in unmatched_names. */
export class NameResolver {
  private map = new Map<string, number>();
  private misses = new Map<string, string>();
  private mascots = new Map<number, string>();

  constructor(
    private source: string,
    private tables = { aliases: 'team_aliases', teams: 'teams', unmatched: 'unmatched_names' },
  ) {}

  async load() {
    const rows = await selectAll<{ alias: string; team_id: number }>((a, b) =>
      db().from(this.tables.aliases).select('alias,team_id').range(a, b),
    );
    for (const r of rows) this.map.set(r.alias, r.team_id);
    const teams = await selectAll<{ id: number; mascot: string | null }>((a, b) => db().from(this.tables.teams).select('id,mascot').range(a, b));
    for (const t of teams) if (t.mascot) this.mascots.set(t.id, normalizeName(t.mascot));
    return this;
  }

  resolve(raw: string, opts: { logMiss?: boolean } = {}): number | null {
    const n = normalizeName(raw);
    const hit = this.map.get(n);
    if (hit) return hit;
    // Try dropping trailing mascot words ("Alabama Crimson Tide" -> "Alabama"), but only
    // when the dropped words really are that team's mascot (so "Mississippi Valley State"
    // never collapses to "Mississippi").
    const words = n.split(' ');
    for (let drop = 1; drop <= 3 && words.length - drop >= 1; drop++) {
      const id = this.map.get(words.slice(0, words.length - drop).join(' '));
      const dropped = words.slice(words.length - drop).join(' ');
      if (id && this.mascots.get(id) === dropped) return id;
    }
    if (opts.logMiss !== false) this.misses.set(raw, n);
    return null;
  }

  async flushMisses() {
    if (!this.misses.size) return;
    const now = new Date().toISOString();
    await upsertChunked(
      this.tables.unmatched,
      [...this.misses.keys()].map((raw_name) => ({ source: this.source, raw_name, last_seen: now, resolved: false })),
      'source,raw_name',
    );
  }

  get missCount() {
    return this.misses.size;
  }
}
