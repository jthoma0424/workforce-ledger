-- =====================================================================
-- CFB Betting Model — core schema
-- Run in Supabase SQL Editor (or `supabase db push`).
-- All tables have RLS enabled with NO public policies: the site reads and
-- writes only from the server using the service-role key, so nothing is
-- exposed through the public anon key.
-- =====================================================================

-- ---------- Teams & name matching ----------
create table if not exists teams (
  id              integer primary key,          -- CFBD team id
  school          text not null unique,
  mascot          text,
  abbreviation    text,
  conference      text,
  classification  text,                          -- 'fbs' | 'fcs' | ...
  color           text,
  logo            text,
  alt_names       text[] default '{}',
  updated_at      timestamptz default now()
);

-- Every name any source uses for a team, normalized (see lib/names.ts).
create table if not exists team_aliases (
  alias     text primary key,
  team_id   integer not null references teams(id) on delete cascade,
  source    text default 'auto'
);

-- Names a scraper / odds feed produced that we could not match. Map them
-- on the Admin page and they get added to team_aliases.
create table if not exists unmatched_names (
  source      text not null,
  raw_name    text not null,
  first_seen  timestamptz default now(),
  last_seen   timestamptz default now(),
  resolved    boolean default false,
  primary key (source, raw_name)
);

-- ---------- Schedule ----------
create table if not exists calendar (
  season       integer not null,
  week         integer not null,
  season_type  text not null default 'regular',
  start_date   timestamptz,
  end_date     timestamptz,
  primary key (season, week, season_type)
);

create table if not exists games (
  id              bigint primary key,           -- CFBD game id
  season          integer not null,
  week            integer not null,
  season_type     text not null default 'regular',
  start_date      timestamptz,
  neutral_site    boolean default false,
  conference_game boolean default false,
  home_id         integer references teams(id),
  away_id         integer references teams(id),
  home_points     integer,
  away_points     integer,
  completed       boolean default false,
  odds_event_id   text,
  updated_at      timestamptz default now()
);
create index if not exists games_season_week on games(season, week);
create index if not exists games_start on games(start_date);

-- ---------- Raw advanced stats (kept as JSON for flexibility) ----------
create table if not exists team_stats (
  season     integer not null,
  week       integer not null,                  -- week the snapshot was taken
  source     text not null,                     -- 'cfbd_advanced' | 'cfbd_wepa' | 'cfbd_ppa' ...
  team_id    integer not null references teams(id) on delete cascade,
  metrics    jsonb not null,
  fetched_at timestamptz default now(),
  primary key (season, week, source, team_id)
);

-- ---------- Rating sources & per-source ratings ----------
create table if not exists rating_sources (
  key          text primary key,                -- 'sp','fpi','srs','elo','wepa','sagarin','fei','tcc_mov'
  name         text not null,
  origin       text not null,                   -- 'cfbd' | 'scrape' | 'internal' | 'manual'
  scale        numeric not null default 1,      -- multiplier to convert raw -> points
  weight       numeric not null default 1,      -- blend weight
  enabled      boolean not null default true,
  url          text,
  notes        text
);

-- Raw rating from each source, snapshotted by week so the model never
-- uses information from after a game was played.
create table if not exists source_ratings (
  season      integer not null,
  week        integer not null,
  source      text not null references rating_sources(key) on delete cascade,
  team_id     integer not null references teams(id) on delete cascade,
  rating      numeric not null,                 -- raw value as published
  offense     numeric,
  defense     numeric,
  raw         jsonb,
  fetched_at  timestamptz default now(),
  primary key (season, week, source, team_id)
);
create index if not exists source_ratings_lookup on source_ratings(season, source, week);

-- ---------- Model output ----------
create table if not exists model_settings (
  id              integer primary key default 1 check (id = 1),
  hfa             numeric not null default 2.5,   -- home-field advantage, points
  sigma           numeric not null default 14.0,  -- SD of (actual margin - predicted margin)
  edge_threshold  numeric not null default 3.0,   -- min points of edge to flag a play
  margin_cap      numeric not null default 28,    -- MOV cap for the in-house rating
  prior_weight    numeric not null default 3.0,   -- games worth of preseason prior
  default_price   integer not null default -110,
  updated_at      timestamptz default now()
);

create table if not exists power_ratings (
  season       integer not null,
  week         integer not null,
  team_id      integer not null references teams(id) on delete cascade,
  rating       numeric not null,                -- points vs. average FBS team, neutral field
  rank         integer,
  components   jsonb,                           -- {source: centered points}
  computed_at  timestamptz default now(),
  primary key (season, week, team_id)
);

-- ---------- Odds ----------
create table if not exists odds_lines (
  id             bigserial primary key,
  game_id        bigint references games(id) on delete cascade,
  odds_event_id  text,
  book           text not null,                 -- 'draftkings' | 'consensus' ...
  home_spread    numeric,
  home_price     integer,
  away_spread    numeric,
  away_price     integer,
  captured_at    timestamptz not null default now()
);
create index if not exists odds_lines_game on odds_lines(game_id, book, captured_at desc);

create or replace view latest_lines as
select distinct on (game_id, book) *
from odds_lines
where game_id is not null
order by game_id, book, captured_at desc;

create or replace view opening_lines as
select distinct on (game_id, book) *
from odds_lines
where game_id is not null
order by game_id, book, captured_at asc;

-- One row per game; refreshed until kickoff, then frozen and graded.
create table if not exists predictions (
  game_id            bigint primary key references games(id) on delete cascade,
  season             integer not null,
  week               integer not null,
  home_rating        numeric,
  away_rating        numeric,
  model_margin       numeric,                   -- predicted home margin (home - away)
  model_spread       numeric,                   -- = -model_margin (home spread, betting convention)
  book               text,
  book_home_spread   numeric,
  book_home_price    integer,
  book_away_price    integer,
  edge               numeric,                   -- points of value on the pick side
  pick_team_id       integer references teams(id),
  pick_spread        numeric,
  cover_prob         numeric,
  ev                 numeric,                   -- expected return per 1 unit risked
  is_play            boolean default false,
  frozen             boolean default false,
  actual_margin      numeric,
  ats_result         text,                      -- 'win' | 'loss' | 'push'
  updated_at         timestamptz default now()
);
create index if not exists predictions_week on predictions(season, week);

-- ---------- Bet tracker ----------
create table if not exists bets (
  id          bigserial primary key,
  game_id     bigint references games(id) on delete set null,
  team_id     integer references teams(id),
  spread      numeric not null,
  price       integer not null default -110,
  stake       numeric not null default 1,
  book        text default 'draftkings',
  placed_at   timestamptz default now(),
  result      text,                             -- 'win' | 'loss' | 'push' | null (pending)
  profit      numeric,
  notes       text
);

-- ---------- Job log ----------
create table if not exists job_runs (
  id           bigserial primary key,
  job          text not null,
  started_at   timestamptz default now(),
  finished_at  timestamptz,
  status       text,                            -- 'ok' | 'error'
  detail       jsonb
);

-- ---------- RLS: lock everything down ----------
do $$
declare t text;
begin
  foreach t in array array['teams','team_aliases','unmatched_names','calendar','games',
    'team_stats','rating_sources','source_ratings','model_settings','power_ratings',
    'odds_lines','predictions','bets','job_runs']
  loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;

-- Views run with the privileges of the caller, not the owner.
alter view latest_lines set (security_invoker = true);
alter view opening_lines set (security_invoker = true);

-- ---------- Seed config ----------
insert into model_settings (id) values (1) on conflict do nothing;

insert into rating_sources (key, name, origin, scale, weight, url, notes) values
  ('sp',       'SP+ (Connelly)',            'cfbd',     1.0,  1.0, 'https://collegefootballdata.com', 'Points above average'),
  ('fpi',      'ESPN FPI',                  'cfbd',     1.0,  1.0, 'https://collegefootballdata.com', 'Points above average'),
  ('srs',      'SRS',                       'cfbd',     1.0,  0.5, 'https://collegefootballdata.com', 'Simple rating system, points'),
  ('elo',      'Elo',                       'cfbd',     0.04, 0.5, 'https://collegefootballdata.com', '~25 Elo pts = 1 point'),
  ('wepa',     'Opp-adjusted EPA (net/play)', 'cfbd',   60.0, 1.0, 'https://collegefootballdata.com', 'Net adj. EPA per play x plays/game'),
  ('sagarin',  'Sagarin Predictor',         'scrape',   1.0,  1.0, 'http://sagarin.com/sports/cfsend.htm', 'Points; scraped text page'),
  ('fei',      'FEI (bcftoys)',             'scrape',  12.0,  0.75, 'https://www.bcftoys.com', 'Per-possession; x ~12 possessions'),
  ('tcc_mov',  'In-house MOV rating',       'internal', 1.0,  1.0, null, 'Ridge regression on capped game margins'),
  ('manual',   'Manual / CSV import',       'manual',   1.0,  0.0, null, 'Paste any site''s ratings on the Admin page')
on conflict (key) do nothing;
