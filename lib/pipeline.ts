import { runLogged } from './jobs';
import { currentSeason, currentWeek } from './season';
import { syncCalendar, syncCfbdLines, syncGames, syncRatingsAndStats, syncTeams } from './cfbd';
import { syncOdds } from './odds';
import { runScrapers } from './scrapers';
import { buildPredictions, computePowerRatings, gradeAll } from './model/compute';
import { db } from './supabase';
import { addDays, cbbCurrentSeason, cbbSeasonGuess, etDate, syncCbbdRatings, syncCbbGames, syncCbbOdds, syncCbbPrior, syncCbbTeams, syncTorvik } from './cbb/ingest';
import { buildCbbPredictions, computeCbbRatings, gradeCbb } from './cbb/model';

export const JOBS = ['setup', 'cfbd', 'scrape', 'odds', 'model', 'daily', 'cbb_setup', 'cbb_daily', 'cbb_lines', 'cbb_model'] as const;
export type JobName = (typeof JOBS)[number];

async function ctx() {
  const season = currentSeason();
  const { week } = await currentWeek(season);
  return { season, week };
}

/**
 * setup  – teams, aliases, calendar (run once per season, or when teams look wrong)
 * cfbd   – games/scores, CFBD ratings + advanced stats, CFBD lines
 * scrape – Sagarin, FEI and any other registered scrapers
 * odds   – DraftKings spreads from The Odds API
 * model  – power ratings -> predictions -> grading
 * daily  – everything except setup (setup runs automatically if teams are empty)
 *
 * Basketball:
 * cbb_setup – teams, season schedule + box scores so far, last season's ratings (prior)
 * cbb_daily – recent/upcoming games, CBBD + Torvik ratings, DraftKings lines, model
 * cbb_lines – DraftKings lines + model only (afternoon refresh before evening tips)
 * cbb_model – grade, rebuild ratings, update predictions
 */
export async function runJob(job: JobName) {
  switch (job) {
    case 'setup':
      return runLogged('setup', async () => {
        const season = currentSeason();
        const teams = await syncTeams(season);
        const cal = await syncCalendar(season);
        const games = await syncGames(season);
        return { season, ...teams, ...cal, ...games };
      });
    case 'cfbd':
      return runLogged('cfbd', async () => {
        const { season, week } = await ctx();
        const games = await syncGames(season);
        const ratings = await syncRatingsAndStats(season, week);
        const lines = await syncCfbdLines(season).catch((e) => ({ cfbdLinesError: e.message }));
        return { season, week, ...games, ratings, ...lines };
      });
    case 'scrape':
      return runLogged('scrape', async () => {
        const { season, week } = await ctx();
        return { season, week, ...(await runScrapers(season, week)) };
      });
    case 'odds':
      return runLogged('odds', async () => {
        const { season } = await ctx();
        return { season, ...(await syncOdds(season)) };
      });
    case 'model':
      return runLogged('model', async () => {
        const { season, week } = await ctx();
        const graded = await gradeAll(season);
        const ratings = await computePowerRatings(season, week);
        const preds = await buildPredictions(season, week);
        return { season, week, ...graded, ...ratings, ...preds };
      });
    case 'cbb_setup':
      return runLogged('cbb_setup', async () => {
        const guess = cbbSeasonGuess();
        const teams = await syncCbbTeams(guess);
        const games = await syncCbbGames(`${guess - 1}-10-25`, addDays(etDate(), 7));
        // Use the season number CBBD attached to the games (guards against label conventions)
        const season = await cbbCurrentSeason();
        const prior = await syncCbbPrior(season).catch((e) => ({ priorError: e.message }));
        return { season, ...teams, ...games, ...prior };
      });
    case 'cbb_daily': {
      const { count } = await db().from('cbb_teams').select('id', { count: 'exact', head: true });
      const out: Record<string, unknown> = {};
      if (!count) out.cbb_setup = await runJob('cbb_setup');
      out.cbb_data = await runLogged('cbb_data', async () => {
        const season = await cbbCurrentSeason();
        const today = etDate();
        const games = await syncCbbGames(addDays(today, -3), addDays(today, 3));
        const cbbd = await syncCbbdRatings(season).catch((e) => ({ cbbdError: e.message }));
        const torvik = await syncTorvik(season).catch((e) => ({ torvikError: e.message }));
        return { season, ...games, ...cbbd, ...torvik };
      });
      out.cbb_lines = await runJob('cbb_lines');
      return { ok: true, ...out };
    }
    case 'cbb_lines':
      return runLogged('cbb_lines', async () => {
        const odds = await syncCbbOdds().catch((e) => ({ oddsError: e.message }));
        const model = await runCbbModel();
        return { ...odds, ...model };
      });
    case 'cbb_model':
      return runLogged('cbb_model', runCbbModel);
    case 'daily': {
      const { count } = await db().from('teams').select('id', { count: 'exact', head: true });
      const out: Record<string, unknown> = {};
      if (!count) out.setup = await runJob('setup');
      for (const j of ['cfbd', 'scrape', 'odds', 'model'] as const) out[j] = await runJob(j);
      return { ok: true, ...out };
    }
  }
}

async function runCbbModel() {
  const season = await cbbCurrentSeason();
  const graded = await gradeCbb();
  const ratings = await computeCbbRatings(season);
  const preds = await buildCbbPredictions(season);
  return { season, ...graded, ...ratings, ...preds };
}
