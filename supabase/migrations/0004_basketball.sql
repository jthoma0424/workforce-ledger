-- =====================================================================
-- College basketball. Run once in the Supabase SQL Editor (after 0003).
-- Separate cbb_* tables so football data is never touched. Safe to re-run.
-- =====================================================================

create table if not exists cbb_teams (
  id            integer primary key,          -- CollegeBasketballData team id
  school        text not null,
  mascot        text,
  abbreviation  text,
  display_name  text,
  conference    text,
  logo          text,
  d1            boolean default false,
  updated_at    timestamptz default now()
);

create table if not exists cbb_aliases (
  alias    text primary key,
  team_id  integer not null references cbb_teams(id) on delete cascade,
  source   text default 'auto'
);

create table if not exists cbb_unmatched (
  source      text not null,
  raw_name    text not null,
  first_seen  timestamptz default now(),
  last_seen   timestamptz default now(),
  resolved    boolean default false,
  primary key (source, raw_name)
);

create table if not exists cbb_games (
  id               bigint primary key,
  season           integer not null,
  season_type      text,
  start_date       timestamptz,
  game_date        date,                      -- Eastern-time calendar date
  neutral_site     boolean default false,
  conference_game  boolean default false,
  tournament       text,
  home_id          integer,
  away_id          integer,
  home_points      integer,
  away_points      integer,
  status           text,
  completed        boolean default false,
  updated_at       timestamptz default now()
);
create index if not exists cbb_games_date on cbb_games(game_date);
create index if not exists cbb_games_season on cbb_games(season, completed);

-- Possessions per game from the box score
create table if not exists cbb_game_stats (
  game_id      bigint primary key,
  possessions  numeric,
  home_poss    numeric,
  away_poss    numeric
);

-- Ratings sources (offense/defense in points per 100 possessions, tempo in possessions)
create table if not exists cbb_sources (
  key      text primary key,
  name     text not null,
  weight   numeric not null default 1,
  enabled  boolean not null default true,
  notes    text
);

create table if not exists cbb_source_ratings (
  season      integer not null,
  as_of       date not null,
  source      text not null,
  team_id     integer not null,
  offense     numeric,          -- adjusted points scored per 100 possessions
  defense     numeric,          -- adjusted points allowed per 100 possessions
  tempo       numeric,          -- possessions per game
  raw         jsonb,
  fetched_at  timestamptz default now(),
  primary key (season, as_of, source, team_id)
);
create index if not exists cbb_source_ratings_lookup on cbb_source_ratings(season, source, as_of);

create table if not exists cbb_ratings (
  season      integer not null,
  as_of       date not null,
  team_id     integer not null,
  net         numeric,          -- offense - defense, per 100 possessions (vs. average D1)
  offense     numeric,          -- adjusted offensive efficiency (absolute)
  defense     numeric,          -- adjusted defensive efficiency (absolute, lower is better)
  tempo       numeric,
  rank        integer,
  components  jsonb,
  computed_at timestamptz default now(),
  primary key (season, as_of, team_id)
);

create table if not exists cbb_odds_lines (
  id           bigserial primary key,
  game_id      bigint,
  book         text not null,
  home_spread  numeric,
  home_price   integer,
  away_spread  numeric,
  away_price   integer,
  total        numeric,
  over_price   integer,
  under_price  integer,
  captured_at  timestamptz not null default now()
);
create index if not exists cbb_odds_lines_game on cbb_odds_lines(game_id, book, captured_at desc);

create table if not exists cbb_predictions (
  game_id            bigint primary key,
  season             integer,
  game_date          date,
  home_net           numeric,
  away_net           numeric,
  possessions_proj   numeric,
  home_points_proj   numeric,
  away_points_proj   numeric,
  model_margin       numeric,
  model_spread       numeric,
  model_total        numeric,
  book               text,
  book_home_spread   numeric,
  book_home_price    integer,
  book_away_price    integer,
  edge               numeric,
  pick_team_id       integer,
  pick_spread        numeric,
  cover_prob         numeric,
  ev                 numeric,
  is_play            boolean default false,
  total_book         text,
  book_total         numeric,
  over_price         integer,
  under_price        integer,
  total_pick         text,
  total_edge         numeric,
  total_prob         numeric,
  total_ev           numeric,
  total_is_play      boolean default false,
  frozen             boolean default false,
  actual_margin      numeric,
  ats_result         text,
  actual_total       numeric,
  total_result       text,
  updated_at         timestamptz default now()
);
create index if not exists cbb_predictions_date on cbb_predictions(game_date);

create table if not exists cbb_settings (
  id                    integer primary key default 1 check (id = 1),
  hca                   numeric not null default 3.0,   -- home-court advantage, points
  sigma                 numeric not null default 11.0,  -- SD of actual minus predicted margin
  edge_threshold        numeric not null default 3.0,
  total_sigma           numeric not null default 12.0,
  total_edge_threshold  numeric not null default 4.0,
  prior_weight          numeric not null default 4.0,   -- games' worth of preseason prior
  eff_cap               numeric not null default 35,    -- cap on single-game efficiency deviation
  tempo_prior_games     numeric not null default 3,
  default_price         integer not null default -110,
  updated_at            timestamptz default now()
);

create table if not exists cbb_bets (
  id         bigserial primary key,
  game_id    bigint references cbb_games(id) on delete set null,
  market     text not null default 'spread',   -- 'spread' | 'total'
  side       text,                             -- 'over' | 'under' for totals
  team_id    integer,
  line       numeric not null,                 -- team spread, or the total
  price      integer not null default -110,
  stake      numeric not null default 1,
  book       text default 'draftkings',
  placed_at  timestamptz default now(),
  result     text,
  profit     numeric,
  notes      text
);

do $$
declare t text;
begin
  foreach t in array array['cbb_teams','cbb_aliases','cbb_unmatched','cbb_games','cbb_game_stats','cbb_sources',
    'cbb_source_ratings','cbb_ratings','cbb_odds_lines','cbb_predictions','cbb_settings','cbb_bets']
  loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;

insert into cbb_settings (id) values (1) on conflict do nothing;
insert into cbb_sources (key, name, weight, notes) values
  ('inhouse', 'In-house efficiency model', 1.0, 'Opponent-adjusted points per 100 possessions from this season''s games'),
  ('cbbd',    'CBBD adjusted efficiency',  1.0, 'CollegeBasketballData /ratings/adjusted'),
  ('torvik',  'Bart Torvik T-Rank',        1.0, 'barttorvik.com team results CSV (scraped)'),
  ('manual',  'Manual / CSV import',       0.0, 'Paste Team, AdjO, AdjD, AdjT on the basketball Admin page')
on conflict (key) do nothing;
