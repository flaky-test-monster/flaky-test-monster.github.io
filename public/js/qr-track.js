/**
 * Counts a scan of a QR code made on the admin page. The codes link to a page with
 * ?qr=<slug>; this tells the Supabase project (see supabase/migrations/) once, then takes the
 * parameter out of the address bar, so a reload, a bookmark or a shared link does not count
 * again. It needs no sign-in and no library: one call of the public track_qr_scan function,
 * with the page's anon key. Without a project, or when the call fails, the page is not
 * affected.
 */

const PARAM = 'qr';
// The slug rule of qr_links in supabase/migrations/20261020000000_qr_links.sql, which decides.
// This module imports nothing, so every page can load it on its own, and keeps a copy.
const SLUG = /^[a-z0-9-]{1,40}$/;

const meta = (name) => document.querySelector(`meta[name="${name}"]`)?.content.trim() ?? '';

const address = new URL(location.href);
const slug = address.searchParams.get(PARAM);

if (slug !== null) {
  address.searchParams.delete(PARAM);
  history.replaceState(history.state, '', address);
  const url = meta('flaky-supabase-url');
  const key = meta('flaky-supabase-key');
  if (url && key && SLUG.test(slug)) {
    // No keepalive: with the headers and body this call needs a preflight, and older browsers
    // refuse a keepalive call that needs one. The call is small and the visitor has only just
    // arrived, so it finishes long before they go on.
    fetch(`${url.replace(/\/$/, '')}/rest/v1/rpc/track_qr_scan`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug }),
    }).catch(() => {});
  }
}
