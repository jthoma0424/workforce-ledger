import * as cheerio from 'cheerio';

export type ScrapedRating = { team: string; rating: number; division?: string; raw?: Record<string, unknown> };

/**
 * Sagarin's college football page is a <pre> text block. Each team line looks like:
 *   1  Alabama   A  =  95.26   5  0   76.44(  9)   0  0 |  2  0 |  91.30  7 |  96.12  4 |  99.58  1 | 103.50  1  SEC  (A)
 * Columns after the pipes: PREDICTOR | GOLDEN_MEAN | RECENT | STRONG_RECENT (value, rank).
 * We use PREDICTOR (purely score-based, built for forecasting).
 */
export function parseSagarin(html: string): ScrapedRating[] {
  const text = html.includes('<') ? cheerio.load(html).root().text() : html;
  const re = /^\s*(\d+)\s+(.+?)\s+(A|AA)\s+=\s*(-?\d+\.\d+)\s+(\d+)\s+(\d+)\s+(-?\d+\.\d+)\(\s*(\d+)\)(.*)$/;
  const out: ScrapedRating[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(re);
    if (!m) continue;
    const team = m[2].trim();
    if (seen.has(team)) continue; // page repeats teams in conference sections
    const parts = m[9].split('|').map((s) => s.trim());
    const val = (i: number) => {
      const v = parseFloat((parts[i] ?? '').split(/\s+/)[0]);
      return Number.isFinite(v) ? v : null;
    };
    const predictor = val(2);
    const rating = parseFloat(m[4]);
    seen.add(team);
    out.push({
      team,
      division: m[3],
      rating: predictor ?? rating,
      raw: { rating, wins: +m[5], losses: +m[6], sos: +m[7], predictor, golden_mean: val(3), recent: val(4), strong_recent: val(5) },
    });
  }
  return out;
}

/**
 * Generic HTML-table parser: finds the first table with a "Team" column and a
 * column whose header matches `valueHeader`, returns (team, value) pairs.
 * Works for FEI (bcftoys) and most stat sites that render plain tables.
 */
export function parseRatingTable(html: string, valueHeader: RegExp, teamHeader = /^team$/i): ScrapedRating[] {
  const $ = cheerio.load(html);
  for (const table of $('table').toArray()) {
    const rows = $(table).find('tr').toArray();
    for (let h = 0; h < Math.min(rows.length, 5); h++) {
      const headers = $(rows[h]).find('th,td').toArray().map((c) => $(c).text().trim());
      const ti = headers.findIndex((x) => teamHeader.test(x));
      const vi = headers.findIndex((x) => valueHeader.test(x));
      if (ti < 0 || vi < 0) continue;
      const out: ScrapedRating[] = [];
      for (const r of rows.slice(h + 1)) {
        const cells = $(r).find('td,th').toArray().map((c) => $(c).text().trim());
        if (cells.length !== headers.length) continue;
        const team = cells[ti].replace(/\s*\(\d+-\d+\)\s*$/, '').trim(); // strip "(5-0)" records
        const v = parseFloat(cells[vi].replace(/[^\d.+-]/g, ''));
        if (team && Number.isFinite(v)) out.push({ team, rating: v });
      }
      if (out.length) return out;
    }
  }
  return [];
}

/** Parse pasted CSV/TSV ("Team,Rating" with optional header) from the Admin page. */
export function parseManualCsv(text: string): ScrapedRating[] {
  const out: ScrapedRating[] = [];
  for (const line of text.split(/\r?\n/)) {
    const cells = line.split(/\t|,/).map((c) => c.trim().replace(/^"|"$/g, ''));
    if (cells.length < 2) continue;
    // Accept "rank, team, rating" too: take the last numeric cell as rating, first non-numeric as team.
    const team = cells.find((c) => c && isNaN(Number(c)));
    const nums = cells.filter((c) => c !== '' && !isNaN(Number(c))).map(Number);
    if (!team || !nums.length) continue;
    out.push({ team, rating: nums[nums.length - 1] });
  }
  return out;
}
