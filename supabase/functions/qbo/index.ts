// Supabase Edge Function: qbo
// Connects the Workforce Ledger to QuickBooks Online and creates invoices there.
// The QuickBooks login (tokens) lives only in public.qbo_connection (service role); the website never sees it.
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

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });
class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }

// ---------- who is calling: must be a signed-in admin ----------
async function requireAdmin(req: Request) {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) throw new HttpError(401, "Not signed in.");
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data?.user) throw new HttpError(401, "Not signed in.");
  const { data: role } = await admin.from("user_roles").select("role").eq("user_id", data.user.id).maybeSingle();
  if (role?.role !== "admin") throw new HttpError(403, "Admins only.");
  return data.user;
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
function saveTokens(t: { access_token: string; refresh_token: string; expires_in: number; x_refresh_token_expires_in: number }, extra: Record<string, unknown>) {
  const now = Date.now();
  return admin.from("qbo_connection").upsert({
    id: 1,
    env: ENV,
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    access_expires_at: new Date(now + (t.expires_in - 60) * 1000).toISOString(),
    refresh_expires_at: new Date(now + t.x_refresh_token_expires_in * 1000).toISOString(),
    updated_at: new Date(now).toISOString(),
    ...extra,
  });
}
async function getConnection() {
  const { data } = await admin.from("qbo_connection").select("*").eq("id", 1).maybeSingle();
  if (!data || !data.realm_id || !data.refresh_token) throw new HttpError(409, "QuickBooks isn't connected yet. Use Connect to QuickBooks first.");
  if (data.env !== ENV) throw new HttpError(409, `QuickBooks is connected in ${data.env} mode but this function is set to ${ENV}. Reconnect.`);
  return data;
}
async function accessToken() {
  const c = await getConnection();
  if (c.access_token && c.access_expires_at && new Date(c.access_expires_at).getTime() > Date.now()) return { token: c.access_token as string, realm: c.realm_id as string };
  // Intuit hands back a NEW refresh token each time; always store the newest one.
  const t = await tokenCall({ grant_type: "refresh_token", refresh_token: c.refresh_token });
  const { error } = await saveTokens(t, { realm_id: c.realm_id, connected_by: c.connected_by, connected_at: c.connected_at });
  if (error) throw new HttpError(500, "Couldn't save the refreshed QuickBooks login: " + error.message);
  return { token: t.access_token, realm: c.realm_id as string };
}

// ---------- QuickBooks API ----------
async function qbo(path: string, init: RequestInit = {}) {
  const { token, realm } = await accessToken();
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
async function query(q: string) {
  const body = await qbo("query?query=" + encodeURIComponent(q));
  return body.QueryResponse ?? {};
}
async function listAll(entity: string, fields: string, where = "") {
  const out: any[] = [];
  for (let start = 1; start < 5000; start += 500) {
    const r = await query(`select ${fields} from ${entity} ${where} startposition ${start} maxresults 500`);
    const rows = r[entity] ?? [];
    out.push(...rows);
    if (rows.length < 500) break;
  }
  return out;
}

// ---------- actions ----------
async function connectUrl(userId: string) {
  if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI) throw new HttpError(500, "Set QBO_CLIENT_ID, QBO_CLIENT_SECRET and QBO_REDIRECT_URI in the function's secrets first.");
  const state = crypto.randomUUID();
  await admin.from("qbo_oauth_state").delete().lt("created_at", new Date(Date.now() - 3600_000).toISOString());
  await admin.from("qbo_oauth_state").insert({ state, user_id: userId });
  const u = new URL("https://appcenter.intuit.com/connect/oauth2");
  u.searchParams.set("client_id", CLIENT_ID);
  u.searchParams.set("scope", "com.intuit.quickbooks.accounting");
  u.searchParams.set("redirect_uri", REDIRECT_URI);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("state", state);
  return u.toString();
}

async function callback(url: URL) {
  // Supabase shows HTML from functions as plain text, so send the browser back to the site with the result instead.
  const back = (result: string, msg = "") => {
    const u = new URL(SITE_URL);
    u.searchParams.set("qbo", result);
    if (msg) u.searchParams.set("qbomsg", msg.slice(0, 200));
    return new Response(null, { status: 302, headers: { Location: u.toString() } });
  };
  try {
    if (url.searchParams.get("error")) return back("cancelled");
    const code = url.searchParams.get("code"), state = url.searchParams.get("state"), realm = url.searchParams.get("realmId");
    if (!code || !state || !realm) return back("error", "Intuit didn't send everything back. Start the connection again.");
    const { data: st } = await admin.from("qbo_oauth_state").select("*").eq("state", state).maybeSingle();
    if (!st || Date.now() - new Date(st.created_at).getTime() > 15 * 60_000) return back("error", "That connection link expired. Start again.");
    await admin.from("qbo_oauth_state").delete().eq("state", state);
    const t = await tokenCall({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI });
    const { error } = await saveTokens(t, { realm_id: realm, connected_by: st.user_id, connected_at: new Date().toISOString() });
    if (error) return back("error", "Couldn't save the connection: " + error.message);
    return back("connected");
  } catch (e) {
    return back("error", (e as Error).message);
  }
}

async function status() {
  const { data } = await admin.from("qbo_connection").select("realm_id,env,connected_at,refresh_expires_at").eq("id", 1).maybeSingle();
  if (!data?.realm_id) return { connected: false, env: ENV, configured: !!(CLIENT_ID && CLIENT_SECRET && REDIRECT_URI) };
  let company = "";
  try { const r = await query("select CompanyName from CompanyInfo"); company = r.CompanyInfo?.[0]?.CompanyName ?? ""; } catch (_e) { /* shown as unknown */ }
  return { connected: data.env === ENV, env: ENV, connected_env: data.env, realm_id: data.realm_id, company, connected_at: data.connected_at, refresh_expires_at: data.refresh_expires_at, configured: true };
}

async function meta() {
  const [customers, classes, terms, items, depts] = await Promise.all([
    listAll("Customer", "Id, FullyQualifiedName", "where Active = true"),
    listAll("Class", "Id, FullyQualifiedName", "where Active = true"),
    listAll("Term", "Id, Name", "where Active = true"),
    listAll("Item", "Id, Name, FullyQualifiedName", "where Active = true"),
    listAll("Department", "Id, Name", "where Active = true").catch(() => []),
  ]);
  return {
    customers: customers.map((c) => c.FullyQualifiedName),
    classes: classes.map((c) => c.FullyQualifiedName),
    terms: terms.map((t) => t.Name),
    items: items.map((i) => i.FullyQualifiedName || i.Name),
    locations: depts.map((d) => d.Name),
  };
}

type Inv = {
  doc_number: string; customer: string; txn_date: string; due_date?: string; terms?: string; class?: string;
  location?: string; item: string; description: string; amount: number; source_file?: string;
};

async function sendInvoices(invoices: Inv[], dryRun: boolean, userId: string) {
  if (!Array.isArray(invoices) || !invoices.length) throw new HttpError(400, "No invoices to send.");
  if (invoices.length > 60) throw new HttpError(400, "Send 60 invoices or fewer at a time.");
  const conn = await getConnection();
  const cache = new Map<string, string | null>();
  async function lookup(entity: string, field: string, value: string) {
    const k = entity + "|" + value;
    if (cache.has(k)) return cache.get(k)!;
    const r = await query(`select Id from ${entity} where ${field} = '${esc(value)}'`);
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
      const existing = await query(`select Id from Invoice where DocNumber = '${esc(doc)}'`);
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
        const created = await qbo("invoice", { method: "POST", body: JSON.stringify(payload) });
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const url = new URL(req.url);
    // Intuit sends the browser back here (GET) after the person approves the connection.
    if (req.method === "GET" && (url.searchParams.has("code") || url.searchParams.has("error"))) return await callback(url);
    if (req.method !== "POST") return json({ ok: true, service: "qbo" });
    const user = await requireAdmin(req);
    const body = await req.json().catch(() => ({}));
    switch (body.action) {
      case "connect_url": return json({ url: await connectUrl(user.id) });
      case "status": return json(await status());
      case "meta": return json(await meta());
      case "validate": return json(await sendInvoices(body.invoices, true, user.id));
      case "send": return json(await sendInvoices(body.invoices, false, user.id));
      default: return json({ error: "Unknown action." }, 400);
    }
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    return json({ error: (e as Error).message }, status);
  }
});
