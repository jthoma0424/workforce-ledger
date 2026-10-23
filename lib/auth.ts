export const AUTH_COOKIE = 'cfb_auth';

/** Cookie token = SHA-256 of the site password (Edge- and Node-compatible). */
export async function authToken(): Promise<string> {
  const pw = process.env.SITE_PASSWORD ?? '';
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`cfb-model:${pw}`));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
