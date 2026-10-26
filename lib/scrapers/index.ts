import { db, upsertChunked } from '../supabase';
import { NameResolver } from '../names';
import { parseRatingTable, parseSagarin, ScrapedRating } from './parsers';

const UA = 'Mozilla/5.0 (compatible; cfb-model/1.0; personal research)';

async function get(url: string) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, cache: 'no-store' });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.text();
}

/**
 * Scraper registry. To add a site: add an entry here and a row in
 * rating_sources with the same key (origin = 'scrape', set scale & weight).
 */
export const SCRAPERS: Record<string, { fetch: (season: number) => Promise<ScrapedRating[]> }> = {
  sagarin: {
    fetch: async () => parseSagarin(await get('http://sagarin.com/sports/cfsend.htm')),
  },
  fei: {
    fetch: async (season) => parseRatingTable(await get(`https://www.bcftoys.com/${season}-fei/`), /^FEI$/i),
  },
};

/** Save a list of (team, rating) to source_ratings, resolving names to team ids. */
export async function saveScraped(source: string, season: number, week: number, items: ScrapedRating[]) {
  const resolver = await new NameResolver(source).load();
  const now = new Date().toISOString();
  const rows = new Map<number, any>();
  for (const it of items) {
    // FCS rows on Sagarin are useful when resolvable, but don't spam the unmatched list with them.
    const id = resolver.resolve(it.team, { logMiss: it.division !== 'AA' });
    if (!id || rows.has(id)) continue;
    rows.set(id, { season, week, source, team_id: id, rating: it.rating, raw: it.raw ?? null, fetched_at: now });
  }
  await upsertChunked('source_ratings', [...rows.values()], 'season,week,source,team_id');
  await resolver.flushMisses();
  return { parsed: items.length, saved: rows.size, unmatched: resolver.missCount };
}

export async function runScrapers(season: number, week: number) {
  const { data: sources } = await db().from('rating_sources').select('key,enabled').eq('origin', 'scrape');
  const enabled = new Set((sources ?? []).filter((s) => s.enabled).map((s) => s.key));
  const out: Record<string, unknown> = {};
  for (const [key, s] of Object.entries(SCRAPERS)) {
    if (!enabled.has(key)) { out[key] = 'disabled'; continue; }
    try {
      const items = await s.fetch(season);
      if (!items.length) throw new Error('parsed 0 rows — page layout may have changed');
      out[key] = await saveScraped(key, season, week, items);
    } catch (e: any) {
      out[key] = { error: e.message };
    }
  }
  return out;
}
