-- =====================================================================
-- Totals (over/under) support. Run once in the Supabase SQL Editor,
-- after 0001_schema.sql. Safe to run more than once.
-- =====================================================================

-- Book totals live on the same line snapshots as spreads
alter table odds_lines add column if not exists total       numeric;
alter table odds_lines add column if not exists over_price  integer;
alter table odds_lines add column if not exists under_price integer;

-- Views select * so they must be rebuilt to include the new columns
drop view if exists latest_lines;
drop view if exists opening_lines;
create view latest_lines as
select distinct on (game_id, book) * from odds_lines
where game_id is not null order by game_id, book, captured_at desc;
create view opening_lines as
select distinct on (game_id, book) * from odds_lines
where game_id is not null order by game_id, book, captured_at asc;
alter view latest_lines set (security_invoker = true);
alter view opening_lines set (security_invoker = true);

-- Offense / defense ratings (points vs. average FBS team; defense = points allowed above average, so lower is better)
alter table power_ratings add column if not exists offense numeric;
alter table power_ratings add column if not exists defense numeric;

-- Totals predictions
alter table predictions add column if not exists home_points_proj numeric;
alter table predictions add column if not exists away_points_proj numeric;
alter table predictions add column if not exists model_total      numeric;
alter table predictions add column if not exists total_book       text;
alter table predictions add column if not exists book_total       numeric;
alter table predictions add column if not exists over_price       integer;
alter table predictions add column if not exists under_price      integer;
alter table predictions add column if not exists total_pick       text;     -- 'over' | 'under'
alter table predictions add column if not exists total_edge       numeric;  -- points of value on the pick side
alter table predictions add column if not exists total_prob       numeric;
alter table predictions add column if not exists total_ev         numeric;
alter table predictions add column if not exists total_is_play    boolean default false;
alter table predictions add column if not exists actual_total     numeric;
alter table predictions add column if not exists total_result     text;     -- 'win' | 'loss' | 'push'

-- Bets can now be spreads or totals (for totals, `spread` holds the total line)
alter table bets add column if not exists market text not null default 'spread';  -- 'spread' | 'total'
alter table bets add column if not exists side   text;                            -- 'over' | 'under' for totals

-- Settings
alter table model_settings add column if not exists total_sigma          numeric not null default 13.5;
alter table model_settings add column if not exists total_edge_threshold numeric not null default 3.0;
alter table model_settings add column if not exists points_cap           numeric not null default 30;
