// Supabase Edge Function: bank-threshold-alerts
// Reads bank-balances.json from GitHub, compares each account to its threshold in
// public.bank_thresholds, and emails every admin (public.user_roles role = 'admin')
// when an account newly drops below its threshold. Each drop is emailed once;
// the alert re-arms after the account is back at or above the threshold.
//
// Secrets to set (Dashboard > Edge Functions > Secrets):
//   RESEND_API_KEY      API key from resend.com
//   ALERT_FROM_EMAIL    verified sender, e.g. "Workforce Ledger <alerts@yourdomain.com>"
// Optional:
//   BALANCES_URL        defaults to the raw GitHub URL below
//   SITE_URL            link included in the email
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.

import { createClient } from "jsr:@supabase/supabase-js@2";

const BALANCES_URL = Deno.env.get("BALANCES_URL") ??
  "https://raw.githubusercontent.com/jthoma0424/workforce-ledger/main/bank-balances.json";
const SITE_URL = Deno.env.get("SITE_URL") ?? "https://jthoma0424.github.io/workforce-ledger/";

type Account = { code?: string; name?: string; balance?: number };
type Company = { key?: string; name?: string; accounts?: Account[] };

const usd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });
const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

Deno.serve(async () => {
  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // 1) Current balances
  const res = await fetch(BALANCES_URL + "?ts=" + Date.now(), { cache: "no-store" });
  if (!res.ok) return json({ ok: false, error: "balances fetch " + res.status }, 502);
  const data = await res.json();
  const companies: Company[] = Array.isArray(data.companies)
    ? data.companies
    : [{ key: "ws", name: "Workforce Strategies", accounts: data.accounts ?? [] }];
  const balances = new Map<string, { company: string; account: string; code: string; balance: number }>();
  for (const c of companies) {
    for (const a of c.accounts ?? []) {
      const key = `${c.key ?? c.name}|${a.code ?? a.name}`;
      balances.set(key, {
        company: c.name ?? c.key ?? "",
        account: a.name ?? "",
        code: a.code ?? "",
        balance: Number(a.balance) || 0,
      });
    }
  }

  // 2) Thresholds and previous alert state
  const { data: thresholds, error: tErr } = await sb.from("bank_thresholds")
    .select("company_key,account_code,threshold");
  if (tErr) return json({ ok: false, error: tErr.message }, 500);
  const { data: states, error: sErr } = await sb.from("bank_threshold_alerts").select("*");
  if (sErr) return json({ ok: false, error: sErr.message }, 500);
  const stateBy = new Map((states ?? []).map((s) => [`${s.company_key}|${s.account_code}`, s]));

  const newlyBelow: { company: string; account: string; code: string; balance: number; threshold: number }[] = [];
  const updates: Record<string, unknown>[] = [];
  for (const t of thresholds ?? []) {
    const key = `${t.company_key}|${t.account_code}`;
    const b = balances.get(key);
    if (!b) continue; // account not in today's file (e.g. zero balance) — leave state alone
    const thr = Number(t.threshold);
    const isBelow = b.balance < thr;
    const prev = stateBy.get(key);
    const row: Record<string, unknown> = {
      company_key: t.company_key,
      account_code: t.account_code,
      is_below: isBelow,
      last_balance: b.balance,
      as_of: data.as_of ?? null,
      notified_at: prev?.notified_at ?? null,
    };
    if (isBelow && !prev?.is_below) {
      newlyBelow.push({ ...b, threshold: thr });
      row.notified_at = new Date().toISOString();
    }
    updates.push(row);
  }

  // 3) Email admins about new drops
  let emailed: string[] = [];
  if (newlyBelow.length) {
    const { data: roles, error: rErr } = await sb.from("user_roles").select("user_id").eq("role", "admin");
    if (rErr) return json({ ok: false, error: rErr.message }, 500);
    for (const r of roles ?? []) {
      const { data: u } = await sb.auth.admin.getUserById(r.user_id);
      if (u?.user?.email) emailed.push(u.user.email);
    }
    emailed = [...new Set(emailed)];
    if (emailed.length) {
      const rows = newlyBelow.map((x) =>
        `<tr><td>${esc(x.company)}</td><td>${esc(x.account)} (${esc(x.code)})</td>` +
        `<td style="text-align:right">${usd(x.balance)}</td><td style="text-align:right">${usd(x.threshold)}</td></tr>`
      ).join("");
      const html =
        `<p>${newlyBelow.length === 1 ? "This account has" : "These accounts have"} dropped below the alert threshold ` +
        `(QuickBooks register balances as of ${esc(String(data.as_of ?? ""))}):</p>` +
        `<table cellpadding="6" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px">` +
        `<tr><th align="left">Company</th><th align="left">Account</th><th align="right">Balance</th><th align="right">Threshold</th></tr>${rows}</table>` +
        `<p><a href="${SITE_URL}">Open Workforce Ledger</a></p>`;
      const send = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${Deno.env.get("RESEND_API_KEY")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: Deno.env.get("ALERT_FROM_EMAIL"),
          to: emailed,
          subject: `Low bank balance alert: ${newlyBelow.map((x) => `${x.company} ${x.account}`).join(", ")}`,
          html,
        }),
      });
      if (!send.ok) {
        // Don't record the alert as sent, so the next run retries.
        return json({ ok: false, error: "email send " + send.status + " " + (await send.text()) }, 502);
      }
    }
  }

  if (updates.length) {
    const { error: uErr } = await sb.from("bank_threshold_alerts")
      .upsert(updates, { onConflict: "company_key,account_code" });
    if (uErr) return json({ ok: false, error: uErr.message }, 500);
  }

  return json({ ok: true, as_of: data.as_of, checked: updates.length, newly_below: newlyBelow, emailed });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
