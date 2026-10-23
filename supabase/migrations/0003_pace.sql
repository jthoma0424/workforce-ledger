-- =====================================================================
-- Pace for totals. Run once in the Supabase SQL Editor (after 0002).
-- Safe to run more than once.
-- =====================================================================
alter table power_ratings  add column if not exists pace        numeric;  -- plays per game (both teams), shrunk toward FBS average
alter table predictions    add column if not exists pace_factor numeric;  -- multiplier applied to projected points
alter table model_settings add column if not exists pace_weight numeric not null default 1.0;  -- 0 = pace off, 1 = full
