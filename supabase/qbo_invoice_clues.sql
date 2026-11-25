-- Invoice recognition clues: text printed on a customer's PDF (site name, job #, address) that
-- lets the site match a PDF to its QuickBooks customer, class and location even if the file name changes.
-- Run once in Supabase > SQL Editor. Safe to run more than once.
alter table public.qbo_invoice_map add column if not exists match_text text;
