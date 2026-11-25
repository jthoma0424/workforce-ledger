// Supabase Edge Function: qbo
// Connects the Workforce Ledger to QuickBooks Online (one connection per company, all managed from the
// site's Settings tab), creates invoices, reads reports, and pulls bank balances.
// The QuickBooks logins (tokens) live only in public.qbo_companies (service role); the website never sees them.
//
// Deploy: Supabase Dashboard > Edge Functions > create a function named  qbo  and paste this file.
// IMPORTANT: turn OFF "Verify JWT with legacy secret" for this function (Settings tab). Intuit's redirect
// back to this function carries no Supabase login; every other action checks the caller itself below.
//
// Secrets (Dashboard > Edge Functions > Secrets):
//   QBO_CLIENT_ID        from your Intuit developer app (Keys & credentials)
//   QBO_CLIENT_SECRET    from the same page
//   QBO_ENV              "sandbox" or "production"  (must match the keys you copied)
//   QBO_REDIRECT_URI     https://uxnkwkqtoszespuymahy.supabase.co/functions/v1/qbo   (add the same URL in the Intuit app's Redirect URIs)
//   SITE_URL             optional, defaults to https://jthoma0424.github.io/workforce-ledger/
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.

import { createClient } from "jsr:@supabase/supabase-js@2";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const CLIENT_ID = Deno.env.get("QBO_CLIENT_ID") ?? "";
const CLIENT_SECRET = Deno.env.get("QBO_CLIENT_SECRET") ?? "";
const ENV = (Deno.env.get("QBO_ENV") ?? "sandbox").toLowerCase() === "production" ? "production" : "sandbox";
const REDIRECT_URI = Deno.env.get("QBO_REDIRECT_URI") ?? "";
const SITE_URL = Deno.env.get("SITE_URL") ?? "https://jthoma0424.github.io/workforce-ledger/";
const API_BASE = ENV === "production" ? "https://quickbooks.api.intuit.com" : "https://sandbox-quickbooks.api.intuit.com";
const MINOR = "75";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-api-version, x-region, accept, accept-profile, content-profile, prefer",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });
class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }

// ---------- who is calling: a signed-in admin, or the scheduled job (service key) for bank pulls only ----------
async function requireCaller(req: Request) {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) throw new HttpError(401, "Not signed in.");
  if (token === SERVICE_KEY) return { system: true, user: null as any };
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data?.user) throw new HttpError(401, "Not signed in.");
  const { data: role } = await admin.from("user_roles").select("role").eq("user_id", data.user.id).maybeSingle();
  if (role?.role !== "admin") throw new HttpError(403, "Admins only.");
  return { system: false, user: data.user };
}

// ---------- Intuit tokens ----------
const basic = () => "Basic " + btoa(CLIENT_ID + ":" + CLIENT_SECRET);
async function tokenCall(params: Record<string, string>) {
  const res = await fetch("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", {
    method: "POST",
    headers: { Authorization: basic(), "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(params),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(502, "Intuit sign-in failed: " + (body.error_description || body.error || res.status));
  return body as { access_token: string; refresh_token: string; expires_in: number; x_refresh_token_expires_in: number };
}
const KEY_RE = /^[a-z0-9_]{1,40}$/;
const cleanKey = (k: unknown) => {
  const s = String(k ?? "ws").trim().toLowerCase() || "ws";
  if (!KEY_RE.test(s)) throw new HttpError(400, "Unknown company.");
  return s;
};
async function getCompany(key: string) {
  const { data } = await admin.from("qbo_companies").select("*").eq("company_key", key).maybeSingle();
  if (!data) throw new HttpError(404, `There's no company "${key}" in the QuickBooks connections list.`);
  return data;
}
function saveTokens(key: string, t: { access_token: string; refresh_token: string; expires_in: number; x_refresh_token_expires_in: number }, extra: Record<string, unknown> = {}) {
  const now = Date.now();
  return admin.from("qbo_companies").update({
    env: ENV,
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    access_expires_at: new Date(now + (t.expires_in - 60) * 1000).toISOString(),
    refresh_expires_at: new Date(now + t.x_refresh_token_expires_in * 1000).toISOString(),
    updated_at: new Date(now).toISOString(),
    ...extra,
  }).eq("company_key", key);
}
async function getConnection(key: string) {
  const data = await getCompany(key);
  if (!data.realm_id || !data.refresh_token) throw new HttpError(409, `QuickBooks isn't connected for ${data.display_name}. Connect it in Settings.`);
  if (data.env !== ENV) throw new HttpError(409, `${data.display_name} is connected in ${data.env} mode but this function is set to ${ENV}. Reconnect it in Settings.`);
  return data;
}
async function accessToken(key: string) {
  const c = await getConnection(key);
  if (c.access_token && c.access_expires_at && new Date(c.access_expires_at).getTime() > Date.now()) return { token: c.access_token as string, realm: c.realm_id as string };
  // Intuit hands back a NEW refresh token each time; always store the newest one.
  let t;
  try {
    t = await tokenCall({ grant_type: "refresh_token", refresh_token: c.refresh_token });
  } catch (e) {
    // another request may have just refreshed (and rotated) the token: use that one if so
    const again = await getCompany(key);
    if (again.access_token && again.access_expires_at && new Date(again.access_expires_at).getTime() > Date.now()) return { token: again.access_token as string, realm: again.realm_id as string };
    if (again.refresh_token && again.refresh_token !== c.refresh_token) t = await tokenCall({ grant_type: "refresh_token", refresh_token: again.refresh_token });
    else throw new HttpError(409, `${c.display_name}'s QuickBooks login has expired or was revoked. Reconnect it in Settings. (${(e as Error).message})`);
  }
  const { error } = await saveTokens(key, t);
  if (error) throw new HttpError(500, "Couldn't save the refreshed QuickBooks login: " + error.message);
  return { token: t.access_token, realm: c.realm_id as string };
}

// ---------- QuickBooks API ----------
async function qbo(key: string, path: string, init: RequestInit = {}) {
  const { token, realm } = await accessToken(key);
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${API_BASE}/v3/company/${realm}/${path}${sep}minorversion=${MINOR}`, {
    ...init,
    headers: { Authorization: "Bearer " + token, Accept: "application/json", "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const fault = body?.Fault?.Error?.[0];
    const msg = fault ? `${fault.Message}${fault.Detail ? " — " + fault.Detail : ""}` : `QuickBooks returned ${res.status}`;
    throw new HttpError(res.status === 401 ? 409 : 502, msg);
  }
  return body;
}
const esc = (s: string) => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
async function query(key: string, q: string) {
  const body = await qbo(key, "query?query=" + encodeURIComponent(q));
  return body.QueryResponse ?? {};
}
async function listAll(key: string, entity: string, fields: string, where = "") {
  const out: any[] = [];
  for (let start = 1; start < 5000; start += 500) {
    const r = await query(key, `select ${fields} from ${entity} ${where} startposition ${start} maxresults 500`);
    const rows = r[entity] ?? [];
    out.push(...rows);
    if (rows.length < 500) break;
  }
  return out;
}

// ---------- connecting companies ----------
const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, " ")
  .replace(/\b(llc|inc|co|corp|company|ltd)\b/g, " ").replace(/\s+/g, " ").trim();

async function connectUrl(userId: string, key: string, returnTo: string) {
  if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI) throw new HttpError(500, "Set QBO_CLIENT_ID, QBO_CLIENT_SECRET and QBO_REDIRECT_URI in the function's secrets first.");
  await getCompany(key);
  const state = crypto.randomUUID();
  await admin.from("qbo_oauth_state").delete().lt("created_at", new Date(Date.now() - 3600_000).toISOString());
  const { error } = await admin.from("qbo_oauth_state").insert({ state, user_id: userId, company_key: key, return_to: returnTo === "qbinv" ? "qbinv" : "settings" });
  if (error) throw new HttpError(500, "Couldn't start the connection: " + error.message + " (run qbo_multi_setup.sql first)");
  const u = new URL("https://appcenter.intuit.com/connect/oauth2");
  u.searchParams.set("client_id", CLIENT_ID);
  u.searchParams.set("scope", "com.intuit.quickbooks.accounting");
  u.searchParams.set("redirect_uri", REDIRECT_URI);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("state", state);
  return u.toString();
}

async function callback(url: URL) {
  let to = "settings", key = "";
  // Supabase shows HTML from functions as plain text, so send the browser back to the site with the result instead.
  const back = (result: string, msg = "") => {
    const u = new URL(SITE_URL);
    u.searchParams.set("qbo", result);
    if (key) u.searchParams.set("qbokey", key);
    u.searchParams.set("qboto", to);
    if (msg) u.searchParams.set("qbomsg", msg.slice(0, 240));
    return new Response(null, { status: 302, headers: { Location: u.toString() } });
  };
  try {
    const code = url.searchParams.get("code"), state = url.searchParams.get("state"), realm = url.searchParams.get("realmId");
    if (state) {
      const { data: st0 } = await admin.from("qbo_oauth_state").select("company_key,return_to").eq("state", state).maybeSingle();
      if (st0) { key = st0.company_key || "ws"; to = st0.return_to || "settings"; }
    }
    if (url.searchParams.get("error")) return back("cancelled");
    if (!code || !state || !realm) return back("error", "Intuit didn't send everything back. Start the connection again.");
    const { data: st } = await admin.from("qbo_oauth_state").select("*").eq("state", state).maybeSingle();
    if (!st || Date.now() - new Date(st.created_at).getTime() > 15 * 60_000) return back("error", "That connection link expired. Start again.");
    await admin.from("qbo_oauth_state").delete().eq("state", state);
    key = st.company_key || "ws";
    const co = await getCompany(key);
    // the same QuickBooks company must not be attached to two different rows
    const { data: dup } = await admin.from("qbo_companies").select("company_key,display_name").eq("realm_id", realm).neq("company_key", key).maybeSingle();
    if (dup) return back("error", `That QuickBooks company is already connected as ${dup.display_name}. In Intuit's list, pick the company that matches ${co.display_name}.`);
    const t = await tokenCall({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI });
    const { error } = await saveTokens(key, t, { realm_id: realm, connected_by: st.user_id, connected_at: new Date().toISOString(), last_pull_error: null });
    if (error) return back("error", "Couldn't save the connection: " + error.message);
    // remember the name QuickBooks gives this company, so Settings can flag a wrong pick
    try {
      const r = await query(key, "select CompanyName from CompanyInfo");
      const nm = r.CompanyInfo?.[0]?.CompanyName ?? "";
      if (nm) await admin.from("qbo_companies").update({ qbo_company_name: nm }).eq("company_key", key);
    } catch (_e) { /* shown as unknown */ }
    return back("connected");
  } catch (e) {
    return back("error", (e as Error).message);
  }
}

function describe(c: any) {
  const connected = !!(c.realm_id && c.refresh_token);
  const left = c.refresh_expires_at ? Math.floor((new Date(c.refresh_expires_at).getTime() - Date.now()) / 86400_000) : null;
  const wrongEnv = connected && c.env !== ENV;
  return {
    company_key: c.company_key, display_name: c.display_name, qbo_name: c.qbo_name ?? "",
    connected, wrong_env: wrongEnv, env: c.env ?? null, realm_id: c.realm_id ?? null,
    qbo_company_name: c.qbo_company_name ?? "", connected_at: c.connected_at ?? null,
    refresh_expires_at: c.refresh_expires_at ?? null, days_left: left,
    last_pull_at: c.last_pull_at ?? null, last_pull_error: c.last_pull_error ?? null,
    name_warning: connected && !!c.qbo_name && !!c.qbo_company_name && norm(c.qbo_name) !== norm(c.qbo_company_name),
  };
}

// every company and its connection state (no QuickBooks calls, so it is instant)
async function companies() {
  const { data, error } = await admin.from("qbo_companies").select("*").order("sort_order").order("display_name");
  if (error) throw new HttpError(500, error.message + " (run qbo_multi_setup.sql first)");
  return { env: ENV, configured: !!(CLIENT_ID && CLIENT_SECRET && REDIRECT_URI), companies: (data ?? []).map(describe) };
}

// live check for one company: asks QuickBooks who it is
async function status(key: string) {
  const c = await getCompany(key);
  if (!c.realm_id) return { connected: false, env: ENV, configured: !!(CLIENT_ID && CLIENT_SECRET && REDIRECT_URI), company_key: key };
  let company = "";
  try {
    const r = await query(key, "select CompanyName from CompanyInfo");
    company = r.CompanyInfo?.[0]?.CompanyName ?? "";
    if (company && company !== c.qbo_company_name) await admin.from("qbo_companies").update({ qbo_company_name: company }).eq("company_key", key);
  } catch (_e) { /* shown as unknown */ }
  return { connected: c.env === ENV, env: ENV, connected_env: c.env, realm_id: c.realm_id, company, connected_at: c.connected_at, refresh_expires_at: c.refresh_expires_at, configured: true, company_key: key };
}

async function disconnect(key: string) {
  const c = await getCompany(key);
  if (c.refresh_token) {
    // tell Intuit too (best effort), so the app disappears from that company's connected-apps list
    try {
      await fetch("https://developer.api.intuit.com/v2/oauth2/tokens/revoke", {
        method: "POST",
        headers: { Authorization: basic(), "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ token: c.refresh_token }),
      });
    } catch (_e) { /* ignore */ }
  }
  const { error } = await admin.from("qbo_companies").update({
    realm_id: null, env: null, access_token: null, refresh_token: null, access_expires_at: null, refresh_expires_at: null,
    connected_by: null, connected_at: null, qbo_company_name: null, last_pull_error: null, updated_at: new Date().toISOString(),
  }).eq("company_key", key);
  if (error) throw new HttpError(500, error.message);
  await admin.from("bank_balances_latest").delete().eq("company_key", key);
  return { ok: true };
}

async function meta(key: string) {
  const [customers, classes, terms, items, depts] = await Promise.all([
    listAll(key, "Customer", "Id, FullyQualifiedName", "where Active = true"),
    listAll(key, "Class", "Id, FullyQualifiedName", "where Active = true"),
    listAll(key, "Term", "Id, Name", "where Active = true"),
    listAll(key, "Item", "Id, Name, FullyQualifiedName", "where Active = true"),
    listAll(key, "Department", "Id, Name", "where Active = true").catch(() => []),
  ]);
  return {
    customers: customers.map((c) => c.FullyQualifiedName),
    classes: classes.map((c) => c.FullyQualifiedName as string).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })),
    terms: terms.map((t) => t.Name),
    items: items.map((i) => i.FullyQualifiedName || i.Name),
    locations: depts.map((d) => d.Name),
  };
}

// ---------- bank balances ----------
// Bank-type accounts and their current (register) balance, saved to public.bank_balances_latest.
// Zero-balance accounts are kept so a low-balance alert still fires when an account hits $0.
async function pullBanks(key: string) {
  const c = await getCompany(key);
  try {
    const accts = await listAll(key, "Account", "Id, Name, AcctNum, AccountType, CurrentBalance, Active", "where AccountType = 'Bank' and Active = true");
    const now = new Date().toISOString();
    const rows = accts.map((a) => ({
      company_key: key,
      account_code: String(a.AcctNum || a.Name),
      account_name: String(a.Name),
      balance: Math.round((Number(a.CurrentBalance) || 0) * 100) / 100,
      fetched_at: now,
    }));
    const seen = new Set<string>();
    const unique = rows.filter((r) => (seen.has(r.account_code) ? false : (seen.add(r.account_code), true)));
    if (unique.length) {
      const { error } = await admin.from("bank_balances_latest").upsert(unique, { onConflict: "company_key,account_code" });
      if (error) throw new Error("Couldn't save balances: " + error.message);
    }
    // accounts that no longer exist in QuickBooks disappear from the table
    const { data: have } = await admin.from("bank_balances_latest").select("account_code").eq("company_key", key);
    const gone = (have ?? []).map((r) => r.account_code).filter((code) => !seen.has(code));
    if (gone.length) await admin.from("bank_balances_latest").delete().eq("company_key", key).in("account_code", gone);
    await admin.from("qbo_companies").update({ last_pull_at: now, last_pull_error: null }).eq("company_key", key);
    return { company_key: key, display_name: c.display_name, ok: true, accounts: unique.length };
  } catch (e) {
    const msg = (e as Error).message;
    await admin.from("qbo_companies").update({ last_pull_error: msg.slice(0, 300) }).eq("company_key", key);
    return { company_key: key, display_name: c.display_name, ok: false, error: msg };
  }
}
async function pullAllBanks(only?: string) {
  let keys: string[];
  if (only) keys = [only];
  else {
    const { data } = await admin.from("qbo_companies").select("company_key").not("refresh_token", "is", null).eq("env", ENV);
    keys = (data ?? []).map((r) => r.company_key);
  }
  const results = await Promise.all(keys.map((k) => pullBanks(k)));
  return { env: ENV, results };
}

// ---------- reading from QuickBooks (nothing here changes your books) ----------
const isDate = (d: unknown) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d);

// Invoices dated from..to, in the same shape as the "Invoice List by Date" report the weekly update reads.
async function invoiceList(key: string, from: string, to: string) {
  if (!isDate(from) || !isDate(to)) throw new HttpError(400, "Give a from and to date.");
  const custs = await listAll(key, "Customer", "Id, FullyQualifiedName", "where Active in (true, false)");
  const nameById = new Map<string, string>(custs.map((c) => [String(c.Id), String(c.FullyQualifiedName)]));
  const rows: any[] = [];
  for (let start = 1; start < 5000; start += 500) {
    const r = await query(key, `select * from Invoice where TxnDate >= '${from}' and TxnDate <= '${to}' order by TxnDate startposition ${start} maxresults 500`);
    const page = r.Invoice ?? [];
    for (const i of page) {
      rows.push({
        id: i.Id, date: i.TxnDate, due: i.DueDate ?? null, num: i.DocNumber ?? "",
        customer: nameById.get(String(i.CustomerRef?.value)) ?? i.CustomerRef?.name ?? "",
        amount: Number(i.TotalAmt) || 0, balance: Number(i.Balance) || 0,
        location: i.DepartmentRef?.name ?? null,
      });
    }
    if (page.length < 500) break;
  }
  return { from, to, count: rows.length, invoices: rows };
}

// Balance sheet as of a date (accrual), flattened into plain [label, amount] rows.
async function balanceSheet(key: string, asOf: string) {
  if (!isDate(asOf)) throw new HttpError(400, "Give an as-of date.");
  const rep = await qbo(key, `reports/BalanceSheet?start_date=${asOf}&end_date=${asOf}&accounting_method=Accrual`);
  const out: Array<[string, number | null]> = [];
  const val = (cd: any[] | undefined) => {
    const v = cd && cd.length > 1 ? cd[cd.length - 1]?.value : undefined;
    if (v === undefined || v === null || v === "") return null;
    const n = Number(String(v).replace(/,/g, ""));
    return isFinite(n) ? n : null;
  };
  const walk = (rows: any[] | undefined) => {
    for (const r of rows ?? []) {
      if (r.Header?.ColData?.[0]?.value) out.push([String(r.Header.ColData[0].value), val(r.Header.ColData)]);
      if (r.ColData) out.push([String(r.ColData[0]?.value ?? ""), val(r.ColData)]);
      if (r.Rows?.Row) walk(r.Rows.Row);
      if (r.Summary?.ColData?.[0]?.value) out.push([String(r.Summary.ColData[0].value), val(r.Summary.ColData)]);
    }
  };
  walk(rep.Rows?.Row);
  return { as_of: asOf, report_end: rep.Header?.EndPeriod ?? asOf, basis: rep.Header?.ReportBasis ?? "", rows: out };
}

type Inv = {
  doc_number: string; customer: string; txn_date: string; due_date?: string; terms?: string; class?: string;
  location?: string; item: string; description: string; amount: number; source_file?: string;
};

async function sendInvoices(key: string, invoices: Inv[], dryRun: boolean, userId: string) {
  if (!Array.isArray(invoices) || !invoices.length) throw new HttpError(400, "No invoices to send.");
  if (invoices.length > 60) throw new HttpError(400, "Send 60 invoices or fewer at a time.");
  const conn = await getConnection(key);
  const cache = new Map<string, string | null>();
  async function lookup(entity: string, field: string, value: string) {
    const k = entity + "|" + value;
    if (cache.has(k)) return cache.get(k)!;
    const r = await query(key, `select Id from ${entity} where ${field} = '${esc(value)}'`);
    const id = r[entity]?.[0]?.Id ?? null;
    cache.set(k, id);
    return id as string | null;
  }
  const results: any[] = [];
  const seen = new Set<string>();
  for (const inv of invoices) {
    const r: any = { doc_number: inv.doc_number, ok: false };
    try {
      const doc = String(inv.doc_number ?? "").trim();
      if (!doc) throw new Error("Invoice number is blank.");
      if (seen.has(doc)) throw new Error("Invoice number " + doc + " appears twice in this batch.");
      seen.add(doc);
      const amount = Math.round(Number(inv.amount) * 100) / 100;
      if (!(amount > 0)) throw new Error("Amount must be greater than zero.");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(inv.txn_date ?? "")) throw new Error("Invoice date is missing.");
      if (!inv.customer) throw new Error("Pick a QuickBooks customer.");
      if (!inv.item) throw new Error("Pick an item (product/service).");

      // already sent? (our log first, then QuickBooks itself)
      const { data: logged } = await admin.from("qbo_invoice_log").select("qbo_id,created_at").eq("realm_id", conn.realm_id).eq("doc_number", doc).maybeSingle();
      if (logged) { r.status = "exists"; r.qbo_id = logged.qbo_id; throw new Error("Invoice " + doc + " was already sent from this site on " + String(logged.created_at).slice(0, 10) + "."); }
      const existing = await query(key, `select Id from Invoice where DocNumber = '${esc(doc)}'`);
      if (existing.Invoice?.length) { r.status = "exists"; r.qbo_id = existing.Invoice[0].Id; throw new Error("Invoice " + doc + " is already in QuickBooks."); }

      const customerId = await lookup("Customer", "FullyQualifiedName", inv.customer);
      if (!customerId) throw new Error(`QuickBooks has no customer named "${inv.customer}".`);
      const itemName = inv.item;
      const itemId = await lookup("Item", itemName.includes(":") ? "FullyQualifiedName" : "Name", itemName);
      if (!itemId) throw new Error(`QuickBooks has no item named "${itemName}".`);
      const termId = inv.terms ? await lookup("Term", "Name", inv.terms) : null;
      if (inv.terms && !termId) throw new Error(`QuickBooks has no terms named "${inv.terms}".`);
      const classId = inv.class ? await lookup("Class", "FullyQualifiedName", inv.class) : null;
      if (inv.class && !classId) throw new Error(`QuickBooks has no class named "${inv.class}".`);
      const deptId = inv.location ? await lookup("Department", "Name", inv.location) : null;
      if (inv.location && !deptId) throw new Error(`QuickBooks has no location named "${inv.location}".`);

      const payload: any = {
        DocNumber: doc,
        TxnDate: inv.txn_date,
        CustomerRef: { value: customerId },
        Line: [{
          DetailType: "SalesItemLineDetail",
          Amount: amount,
          Description: inv.description || "",
          SalesItemLineDetail: {
            ItemRef: { value: itemId }, Qty: 1, UnitPrice: amount, ServiceDate: inv.txn_date,
            ...(classId ? { ClassRef: { value: classId } } : {}),
          },
        }],
      };
      if (termId) payload.SalesTermRef = { value: termId };
      if (inv.due_date && /^\d{4}-\d{2}-\d{2}$/.test(inv.due_date)) payload.DueDate = inv.due_date;
      if (deptId) payload.DepartmentRef = { value: deptId };

      if (dryRun) { r.ok = true; r.status = "ready"; }
      else {
        const created = await qbo(key, "invoice", { method: "POST", body: JSON.stringify(payload) });
        const made = created.Invoice;
        r.ok = true; r.status = "created"; r.qbo_id = made?.Id; r.total = made?.TotalAmt;
        const { error } = await admin.from("qbo_invoice_log").insert({
          realm_id: conn.realm_id, env: ENV, doc_number: doc, qbo_id: made?.Id, customer: inv.customer, amount,
          txn_date: inv.txn_date, source_file: inv.source_file ?? null, created_by: userId,
        });
        if (error) r.warning = "Created in QuickBooks, but the site's log didn't save: " + error.message;
      }
    } catch (e) {
      r.ok = false; r.error = (e as Error).message; r.status = r.status ?? "error";
    }
    results.push(r);
  }
  return { env: ENV, dry_run: dryRun, results };
}

// ---------- bills (Key Risk workers' comp, Frontier commission): vendor bills with one line per location ----------
type BillLine = { account: string; description?: string; amount: number; class?: string };
type Bill = { doc_number: string; vendor: string; txn_date: string; due_date?: string; terms?: string; memo?: string; lines: BillLine[] };

async function sendBills(key: string, bills: Bill[], dryRun: boolean, userId: string) {
  if (!Array.isArray(bills) || !bills.length) throw new HttpError(400, "No bills to send.");
  if (bills.length > 20) throw new HttpError(400, "Send 20 bills or fewer at a time.");
  const conn = await getConnection(key);
  const cache = new Map<string, string | null>();
  async function lookup(entity: string, field: string, value: string) {
    const k = entity + "|" + field + "|" + value;
    if (cache.has(k)) return cache.get(k)!;
    const r = await query(key, `select Id from ${entity} where ${field} = '${esc(value)}'`);
    const id = r[entity]?.[0]?.Id ?? null;
    cache.set(k, id);
    return id as string | null;
  }
  // "61200 Direct Staffing Labor:Worker Compensation" -> account number 61200, else match the name
  async function account(label: string) {
    const m = String(label).trim().match(/^(\d{3,8})\s+(.*)$/);
    if (m) {
      const byNum = await lookup("Account", "AcctNum", m[1]);
      if (byNum) return byNum;
      const byName = await lookup("Account", "FullyQualifiedName", m[2]);
      if (byName) return byName;
      return null;
    }
    return (await lookup("Account", "FullyQualifiedName", label)) ?? (await lookup("Account", "Name", label));
  }
  const results: any[] = [];
  const seen = new Set<string>();
  for (const b of bills) {
    const r: any = { doc_number: b.doc_number, vendor: b.vendor, ok: false };
    try {
      const doc = String(b.doc_number ?? "").trim();
      if (!doc) throw new Error("Bill number is blank.");
      if (seen.has(doc)) throw new Error("Bill number " + doc + " appears twice in this batch.");
      seen.add(doc);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(b.txn_date ?? "")) throw new Error("Bill date is missing.");
      if (!b.vendor) throw new Error("Vendor is blank.");
      if (!Array.isArray(b.lines) || !b.lines.length) throw new Error("The bill has no lines.");

      const { data: logged } = await admin.from("qbo_invoice_log").select("qbo_id,created_at").eq("realm_id", conn.realm_id).eq("doc_number", doc).maybeSingle();
      if (logged) { r.status = "exists"; throw new Error("Bill " + doc + " was already sent from this site on " + String(logged.created_at).slice(0, 10) + "."); }
      const existing = await query(key, `select Id from Bill where DocNumber = '${esc(doc)}'`);
      if (existing.Bill?.length) { r.status = "exists"; throw new Error("Bill " + doc + " is already in QuickBooks."); }

      const vendorId = await lookup("Vendor", "DisplayName", b.vendor);
      if (!vendorId) throw new Error(`QuickBooks has no vendor named "${b.vendor}".`);
      const termId = b.terms ? await lookup("Term", "Name", b.terms) : null;
      if (b.terms && !termId) throw new Error(`QuickBooks has no terms named "${b.terms}".`);

      const lines: any[] = [];
      let total = 0;
      for (const [i, l] of b.lines.entries()) {
        const amt = Math.round(Number(l.amount) * 100) / 100;
        if (!isFinite(amt) || amt === 0) throw new Error(`Line ${i + 1}: amount can't be zero.`);
        const acct = await account(l.account);
        if (!acct) throw new Error(`QuickBooks has no account "${l.account}".`);
        let classId: string | null = null;
        if (l.class) {
          classId = await lookup("Class", "FullyQualifiedName", l.class);
          if (!classId) throw new Error(`QuickBooks has no class "${l.class}" (line: ${l.description ?? i + 1}).`);
        }
        total += amt;
        lines.push({
          DetailType: "AccountBasedExpenseLineDetail", Amount: amt, Description: l.description || "",
          AccountBasedExpenseLineDetail: { AccountRef: { value: acct }, BillableStatus: "NotBillable", ...(classId ? { ClassRef: { value: classId } } : {}) },
        });
      }
      total = Math.round(total * 100) / 100;
      if (!(total > 0)) throw new Error("The bill total must be greater than zero.");
      const payload: any = { DocNumber: doc, TxnDate: b.txn_date, VendorRef: { value: vendorId }, Line: lines };
      if (termId) payload.SalesTermRef = { value: termId };
      if (b.due_date && /^\d{4}-\d{2}-\d{2}$/.test(b.due_date)) payload.DueDate = b.due_date;
      if (b.memo) payload.PrivateNote = b.memo;

      r.total = total; r.line_count = lines.length;
      if (dryRun) { r.ok = true; r.status = "ready"; }
      else {
        const created = await qbo(key, "bill", { method: "POST", body: JSON.stringify(payload) });
        const made = created.Bill;
        r.ok = true; r.status = "created"; r.qbo_id = made?.Id; r.total = made?.TotalAmt ?? total;
        const { error } = await admin.from("qbo_invoice_log").insert({
          realm_id: conn.realm_id, env: ENV, doc_number: doc, qbo_id: made?.Id, customer: b.vendor + " (bill)", amount: total,
          txn_date: b.txn_date, source_file: "vendor bill", created_by: userId,
        });
        if (error) r.warning = "Created in QuickBooks, but the site's log didn't save: " + error.message;
      }
    } catch (e) {
      r.ok = false; r.error = (e as Error).message; r.status = r.status ?? "error";
    }
    results.push(r);
  }
  return { env: ENV, dry_run: dryRun, results };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    // answer the browser's pre-check, allowing whatever headers it says it will send
    const asked = req.headers.get("Access-Control-Request-Headers");
    return new Response("ok", { headers: { ...CORS, ...(asked ? { "Access-Control-Allow-Headers": asked } : {}) } });
  }
  try {
    const url = new URL(req.url);
    // Intuit sends the browser back here (GET) after the person approves the connection.
    if (req.method === "GET" && (url.searchParams.has("code") || url.searchParams.has("error"))) return await callback(url);
    if (req.method !== "POST") return json({ ok: true, service: "qbo" });
    const who = await requireCaller(req);
    const body = await req.json().catch(() => ({}));
    // the scheduled job may only pull bank balances
    if (who.system && body.action !== "refresh_banks") throw new HttpError(403, "Not allowed.");
    const key = cleanKey(body.company_key);
    switch (body.action) {
      case "connect_url": return json({ url: await connectUrl(who.user.id, key, body.return_to) });
      case "companies": return json(await companies());
      case "status": return json(await status(key));
      case "disconnect": return json(await disconnect(key));
      case "refresh_banks": return json(await pullAllBanks(body.company_key ? key : undefined));
      case "meta": return json(await meta(key));
      case "invoice_list": return json(await invoiceList(key, body.from, body.to));
      case "balance_sheet": return json(await balanceSheet(key, body.as_of));
      case "validate_bills": return json(await sendBills(key, body.bills, true, who.user.id));
      case "send_bills": return json(await sendBills(key, body.bills, false, who.user.id));
      case "validate": return json(await sendInvoices(key, body.invoices, true, who.user.id));
      case "send": return json(await sendInvoices(key, body.invoices, false, who.user.id));
      default: return json({ error: "Unknown action." }, 400);
    }
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    return json({ error: (e as Error).message }, status);
  }
});
