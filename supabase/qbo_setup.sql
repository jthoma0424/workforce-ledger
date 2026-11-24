-- QuickBooks direct invoice import: tables.  Run once in Supabase > SQL Editor.
-- Safe to run more than once.

-- 1) The QuickBooks connection (tokens). RLS is on with NO policies, so only the
--    edge function (service role) can read it. The website never sees these tokens.
create table if not exists public.qbo_connection (
  id int primary key default 1 check (id = 1),
  realm_id text,
  env text,
  access_token text,
  refresh_token text,
  access_expires_at timestamptz,
  refresh_expires_at timestamptz,
  connected_by uuid,
  connected_at timestamptz default now(),
  updated_at timestamptz default now()
);
alter table public.qbo_connection enable row level security;

-- 2) One-time sign-in tokens used while connecting (service role only).
create table if not exists public.qbo_oauth_state (
  state text primary key,
  user_id uuid,
  created_at timestamptz default now()
);
alter table public.qbo_oauth_state enable row level security;

-- 3) PDF name -> QuickBooks customer / terms / class. Admins can read and edit.
create table if not exists public.qbo_invoice_map (
  match_key text primary key,           -- from the file name, e.g. "bonnell ga"
  qbo_customer text not null,           -- QuickBooks customer name, e.g. "Bonnell Aluminum:Bonnell Georgia"
  terms text default 'Net 10',
  class text,                           -- e.g. "GA:10026"
  location text default 'Solutions 4 Labor LLC',
  item text default 'Staffing Labor',
  description_name text,                -- wording used in the line description
  updated_at timestamptz default now()
);
alter table public.qbo_invoice_map enable row level security;
drop policy if exists qbo_invoice_map_admin on public.qbo_invoice_map;
create policy qbo_invoice_map_admin on public.qbo_invoice_map
  for all to authenticated
  using (exists (select 1 from public.user_roles r where r.user_id = auth.uid() and r.role = 'admin'))
  with check (exists (select 1 from public.user_roles r where r.user_id = auth.uid() and r.role = 'admin'));

-- 4) Every invoice sent to QuickBooks. The unique key stops the same invoice number going in twice.
create table if not exists public.qbo_invoice_log (
  id bigserial primary key,
  realm_id text not null,
  env text,
  doc_number text not null,
  qbo_id text,
  customer text,
  amount numeric,
  txn_date date,
  source_file text,
  created_by uuid,
  created_at timestamptz default now(),
  unique (realm_id, doc_number)
);
alter table public.qbo_invoice_log enable row level security;
drop policy if exists qbo_invoice_log_admin_read on public.qbo_invoice_log;
create policy qbo_invoice_log_admin_read on public.qbo_invoice_log
  for select to authenticated
  using (exists (select 1 from public.user_roles r where r.user_id = auth.uid() and r.role = 'admin'));

-- 5) Starting mappings for the customers we already know (taken from the invoices already imported).
--    Everything else is filled in on the website the first time a PDF for it is read.
insert into public.qbo_invoice_map (match_key, qbo_customer, terms, class, description_name) values
  ('azbs tucson',        '4ward Design & Labor:Arizona Building Supply Tucson', 'Net 7',  'AZ:10044', 'Arizona Building Supply Tucson'),
  ('azbs tucson lumber', '4ward Design & Labor:Arizona Building Supply Tucson', 'Net 7',  'AZ:10044', 'Arizona Building Supply Tucson Lumber'),
  ('key',                'Key Manufacturing',                                   'Net 10', 'IN:10035', 'Key Manufacturing'),
  ('mueller',            'Mueller Refrigeration',                               'Net 10', 'TN:10032', 'Mueller Refrigeration'),
  ('bonnell ga',         'Bonnell Aluminum:Bonnell Georgia',                    'Net 10', 'GA:10026', 'Bonnell GA')
on conflict (match_key) do nothing;
