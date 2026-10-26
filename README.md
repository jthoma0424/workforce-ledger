# CFB Model

A private college football betting model. It pulls advanced stats and computer ratings, blends them into one power rating, turns that into a projected spread, and compares it to DraftKings.

**Stack:** Next.js 15 (deployed on Vercel), Supabase Postgres, Vercel Cron.
**Data:** CollegeFootballData.com (CFBD), The Odds API (DraftKings lines), and scraped Sagarin and FEI ratings. You can also paste ratings from any site.

---

## How the model works

1. **Collect.** Every source's rating for every team is saved weekly in `source_ratings`, so backtests never use future information.
   - **From CFBD:** SP+, FPI, SRS, Elo, opponent-adjusted EPA, and advanced stats (success rate, explosiveness, havoc, and more).
   - **Scraped:** Sagarin Predictor and FEI.
   - **In-house MOV rating:** ridge regression on capped game margins, pulled toward the external composite. This keeps early-season numbers stable.
2. **Normalize.** Each source is centered on the average FBS team and multiplied by its `scale`. Everything ends up in points: "X points better than an average FBS team on a neutral field."
3. **Blend.** The power rating is a weighted mean of whichever sources a team has. You set the weights on the Admin page, or fit them with **Calibrate**.
4. **Project.** Home margin = home rating − away rating + HFA (no HFA at neutral sites). The model's home spread is the negative of that margin.
5. **Compare to DraftKings.**
   - Edge = model margin + DK home spread. Example: the model has the home team by 10 and DK lists them at −7, so there are +3 points of edge on the home team.
   - Cover probability = Φ(edge / σ).
   - EV uses the actual DK price.
   - A game is flagged as a **PLAY** when edge ≥ your threshold.
6. **Totals.** Every team also gets an offense and defense rating in points, blended from SP+ offense/defense, opponent-adjusted EPA, and an in-house regression on points scored and allowed.
   - Projected points = league average + your offense rating + their defense rating (points allowed above average) ± half the home-field edge.
   - Pace: each team's plays per game (both sides) sets a matchup multiplier. Two fast teams push the projection up, two slow teams pull it down. Set **Pace weight** on Admin (0 = off).
   - The projected total is compared to the DraftKings total. P(over) = Φ((model total − DK total) / σ_total), and a game is flagged when the edge ≥ the totals threshold.
7. **Lock and grade.** Predictions freeze at kickoff. They are graded ATS when the game goes final. Bets you log are graded the same way.

The **Performance** page shows ATS record by edge bucket. It also shows the model's error against final margins next to the line's error. If the model's error isn't close to the line's, trust the plays less.

---

## Setup (about 20 minutes)

### 1. Get API keys (free)
- CFBD: https://collegefootballdata.com/key. The free tier is about 1,000 calls a month, and the daily job uses about 15.
- The Odds API: https://the-odds-api.com. The free tier is 500 credits a month, and each odds pull costs 1.

### 2. Create the Supabase project
1. Go to https://supabase.com and create a **New project**. Save the database password.
2. Open **SQL Editor**, paste in all of `supabase/migrations/0001_schema.sql`, and click **Run**.
3. Also run `supabase/migrations/0002_totals.sql` the same way (adds totals), then `0003_pace.sql` (adds pace).
4. Under **Project Settings → API**, copy the **Project URL** and the **service_role** key. Keep the service_role key secret: it bypasses row-level security.

Every table has RLS turned on with no public policies. The browser never talks to Supabase directly; all reads happen on the server.

### 3. Run it locally
```bash
cp .env.example .env.local     # fill in the values
npm install
npm run dev                    # http://localhost:3000
```
Sign in with `SITE_PASSWORD`. Then go to **Admin**, click **Setup** (teams, schedule), and then click **Daily** (stats, scrapes, odds, model).

### 4. Deploy to Vercel
1. Push this folder to a private GitHub repo.
2. In Vercel, click **Add New → Project**, import the repo, and add every variable from `.env.example`.
3. Deploy. `vercel.json` sets up these daily jobs (times in UTC):
   - `11:00`: `daily` (everything)
   - `17:00`: `odds` (refresh DraftKings spreads and totals, 2 Odds API credits)
   - `17:15`: `model` (rebuild predictions)

   On the Pro plan you can add more `odds` runs, for example every 2 hours on Saturdays. Each run costs 1 Odds API credit.

If the deploy complains about `maxDuration`, lower it to 60 in `app/api/cron/[job]/route.ts` and `app/admin/page.tsx`.

You can also start any job by hand: `curl -H "Authorization: Bearer $CRON_SECRET" https://your-site.vercel.app/api/cron/odds`

---

## Pages
| Page | What it shows |
|---|---|
| **Slate** | Every game this week: ratings, model spread, DK spread and price, edge, pick, cover %, EV, and results |
| **Power Rankings** | FBS ranks with week-over-week movement and every source's rating side by side, filterable by conference |
| **Team** | Schedule with the model's numbers, rating history by week, and offense/defense advanced stats |
| **Game** | Source-by-source breakdown, line movement across books, and a bet logging form |
| **Performance** | ATS by edge bucket and by week, units, and model vs. line accuracy |
| **Bets** | Your logged bets, auto-graded, with record, units, and ROI |
| **Admin** | Run jobs, job log, model settings, source weights and scales, calibration, team-name fixes, and CSV import |

## Ongoing care
- **Unmatched team names.** Different sites spell teams differently. Any name that couldn't be matched shows up on Admin; map it once and it's remembered. Common variants are pre-seeded in `lib/names.ts`.
- **Scrapers break when a site's layout changes.** The job log will say "parsed 0 rows". To fix it or add a site, edit `lib/scrapers/index.ts` and add a matching row to `rating_sources`. For sites that load their data with JavaScript (such as Massey), copy the table and paste it into **Import ratings** on Admin.
- **Calibrate** once about 50 or more games have stored pregame ratings (roughly week 4 or later). It fits blend weights, HFA, and σ using only pregame data.
- **Early season** leans on preseason SP+/FPI, which include returning production and recruiting. Use a higher play threshold in weeks 1–3.

## Tests
```bash
npm test        # model math, ATS grading, rating regression, weight fitting, parsers
```

## Files
```
supabase/migrations/0001_schema.sql   tables, views, RLS, seed config
lib/cfbd.ts                           CFBD client: teams, calendar, games, ratings, stats, lines
lib/odds.ts                           The Odds API (DraftKings) to games matching
lib/scrapers/                         Sagarin, FEI, generic table and CSV parsers
lib/names.ts                          team-name normalization and alias resolution
lib/model/math.ts                     pure math (cover prob, EV, MOV ridge, weight fit)
lib/model/compute.ts                  power ratings, predictions, grading, calibration
lib/pipeline.ts                       job orchestration (setup/cfbd/scrape/odds/model/daily)
app/                                  Next.js pages and server actions
```

*For research and entertainment. Bet responsibly.*

---

## College basketball

Use the **Football / Basketball** switch in the header. Basketball has its own Slate (by date), Power Rankings, Performance, Bets and Admin pages, stored in separate `cbb_*` tables.

- **Setup:** run `supabase/migrations/0004_basketball.sql` once, then open Basketball → Admin and click **Setup**, then **Daily**. Basketball uses the same CollegeFootballData key (shared quota), or a separate key in `CBBD_API_KEY`.
- **Ratings (tempo-free):** adjusted offense and defense in points per 100 possessions, plus tempo in possessions per game. The model blends:
  - an in-house opponent-adjusted efficiency model fit to this season's box scores (non-D1 opponents are pooled into one team)
  - CollegeBasketballData's adjusted efficiency
  - Bart Torvik's T-Rank (scraped CSV)
  - optional pasted ratings, such as KenPom
- **Preseason starting point:** last season's final ratings, regressed 40% toward average.
- **Projection:** possessions = tempoA × tempoB / league tempo. Points = possessions × (league efficiency + offense + opponent's defense) / 100, ± half the home-court edge.
- **Schedule (UTC):**
  - `15:00` `cbb_daily`: games, ratings, lines, model
  - `21:00` `cbb_lines`: DraftKings lines refresh and predictions rebuild before evening tips
- **Predictions:** made for today and the next two days, and lock at tip-off.
