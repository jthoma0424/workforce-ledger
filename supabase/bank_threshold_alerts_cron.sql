-- Run AFTER the bank-threshold-alerts Edge Function is deployed (with "Verify JWT" turned OFF).
-- Checks for new low-balance alerts every hour, 8 AM - 6 PM Eastern, Monday - Friday.
-- Dashboard > SQL Editor > New query > paste > Run.
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('bank-threshold-alerts')
where exists (select 1 from cron.job where jobname = 'bank-threshold-alerts');

select cron.schedule(
  'bank-threshold-alerts',
  '5 12-23 * * 1-5',   -- UTC; covers 8 AM-6 PM Eastern year-round
  $$ select net.http_post(
       url := 'https://uxnkwkqtoszespuymahy.supabase.co/functions/v1/bank-threshold-alerts',
       headers := '{"Content-Type":"application/json"}'::jsonb,
       body := '{}'::jsonb
     ); $$
);
