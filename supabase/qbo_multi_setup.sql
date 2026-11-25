-- QuickBooks: connect all 15 companies from the Settings tab + pull bank balances directly.
-- Run once in Supabase > SQL Editor (after qbo_setup.sql). Safe to run more than once.

-- 1) One row per company. RLS is on with NO policies: only the edge function (service role) can read
--    this table, so the QuickBooks logins (tokens) are never visible to the website.
create table if not exists public.qbo_companies (
  company_key        text primary key,          -- same keys as bank-balances.json / bank_thresholds
  display_name       text not null,
  qbo_name           text,                      -- the company's name in QuickBooks (used to catch a wrong pick in Intuit's list)
  sort_order         int  default 100,
  realm_id           text,
  env                text,
  access_token       text,
  refresh_token      text,
  access_expires_at  timestamptz,
  refresh_expires_at timestamptz,
  connected_by       uuid,
  connected_at       timestamptz,
  qbo_company_name   text,                      -- name QuickBooks reported when connected
  last_pull_at       timestamptz,
  last_pull_error    text,
  updated_at         timestamptz default now()
);
alter table public.qbo_companies enable row level security;

insert into public.qbo_companies (company_key, display_name, qbo_name, sort_order) values
  ('ws',              'Workforce Strategies',     'Workforce Strategies LLC',     1),
  ('alltruss',        'All Truss',                'All Truss LLC',                2),
  ('allbuilding',     'ALL Building Solutions',   'ALL Building Solutions LLC',   3),
  ('doublel',         'Double L Land',            'Double L Land Company LLC',    4),
  ('rollincoal',      'Rollin Coal Trucking',     'Rollin Coal Trucking LLC',     5),
  ('badinridge',      'Badin Ridge',              'Badin Ridge LLC',              6),
  ('ldchomes',        'LDC Homes',                'LDC Homes LLC',                7),
  ('sparetime',       'Spare Time Renovations',   'Spare Time Renovations LLC',   8),
  ('wickedwings',     'Wicked Wings',             'Wicked Wings LLC',             9),
  ('lbmministorage',  'LBM Mini Storage',         'LBM Mini Storage LLC',        10),
  ('premierhomes',    'Premier Homes NC',         'Premier Homes NC LLC',        11),
  ('carolinashelter', 'Carolina Shelter Systems', 'Carolina Shelter Systems LLC',12),
  ('premierrentals',  'Premier Rentals NC',       'Premier Rentals NC LLC',      13),
  ('allset',          'Allset Supply',            'Allset Supply LLC',           14),
  ('rileys',          'Riley''s Labor',           'Riley''s Labor LLC',          15)
on conflict (company_key) do nothing;

-- 2) Carry over the Workforce Strategies connection you already made (so you don't have to reconnect it).
update public.qbo_companies c
set realm_id = q.realm_id, env = q.env, access_token = q.access_token, refresh_token = q.refresh_token,
    access_expires_at = q.access_expires_at, refresh_expires_at = q.refresh_expires_at,
    connected_by = q.connected_by, connected_at = q.connected_at
from public.qbo_connection q
where c.company_key = 'ws' and q.id = 1 and q.realm_id is not null and c.realm_id is null;

-- 3) The connect flow now remembers which company it is connecting and where to return.
alter table public.qbo_oauth_state add column if not exists company_key text;
alter table public.qbo_oauth_state add column if not exists return_to text;

-- 4) Latest bank balances pulled straight from QuickBooks (one row per Bank-type account).
--    account_code = the account number when QuickBooks has one, otherwise the account name
--    (same rule bank-balances.json and the alert thresholds already use).
create table if not exists public.bank_balances_latest (
  company_key  text not null,
  account_code text not null,
  account_name text not null,
  balance      numeric(14,2) not null default 0,
  fetched_at   timestamptz not null default now(),
  primary key (company_key, account_code)
);
alter table public.bank_balances_latest enable row level security;
drop policy if exists bank_balances_latest_read on public.bank_balances_latest;
create policy bank_balances_latest_read on public.bank_balances_latest
  for select to authenticated using (true);
-- no insert/update/delete policies: only the edge function (service role) writes here.
