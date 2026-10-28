-- Workforce Ledger: low-balance alert thresholds for the bank balances table.
-- Run once in Supabase: Dashboard > SQL Editor > New query > paste > Run.

-- 1) Thresholds that admins set on the company chooser page.
create table if not exists public.bank_thresholds (
  company_key  text        not null,          -- e.g. "ws", "alltruss" (matches bank-balances.json)
  account_code text        not null,          -- e.g. "10020"
  threshold    numeric(14,2) not null check (threshold >= 0),
  updated_at   timestamptz not null default now(),
  updated_by   uuid        default auth.uid(),
  primary key (company_key, account_code)
);

alter table public.bank_thresholds enable row level security;

drop policy if exists "admins manage bank thresholds" on public.bank_thresholds;
create policy "admins manage bank thresholds" on public.bank_thresholds
  for all to authenticated
  using      (exists (select 1 from public.user_roles r where r.user_id = auth.uid() and r.role = 'admin'))
  with check (exists (select 1 from public.user_roles r where r.user_id = auth.uid() and r.role = 'admin'));

-- 2) Alert state, so each drop below a threshold is emailed once (not every hour).
--    Only the Edge Function (service role) reads/writes this; no policies = no access for site users.
create table if not exists public.bank_threshold_alerts (
  company_key  text        not null,
  account_code text        not null,
  is_below     boolean     not null default false,
  last_balance numeric(14,2),
  as_of        date,
  notified_at  timestamptz,
  primary key (company_key, account_code)
);

alter table public.bank_threshold_alerts enable row level security;
