/**
 * The online jury vote on the music page, kept in Supabase (supabase/migrations/). The page
 * holds the project URL and the public anon key in its meta tags; when they are empty, there is
 * no online vote and the votes go out by email instead.
 *
 * Voters sign in anonymously, and only when they cast their first votes, so a visit alone makes
 * no user. The browser keeps the session, which is how a jury comes back to its own ballot.
 * The database checks every vote: nothing here is trusted.
 */

const SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.115.0/+esm';
const TURNSTILE_JS = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

const meta = (name) => document.querySelector(`meta[name="${name}"]`)?.content.trim() ?? '';
const url = meta('flaky-supabase-url');
const key = meta('flaky-supabase-key');
const captchaSiteKey = meta('flaky-captcha-sitekey');

/** Whether the page has a Supabase project to vote in. */
export const online = Boolean(url && key);

/** @type {Promise<import('@supabase/supabase-js').SupabaseClient> | undefined} */
let client;
function supabase() {
  client ??= import(SUPABASE_JS).then(({ createClient }) => createClient(url, key));
  return client;
}

/** The messages the database raises for voters (SQLSTATE P0001) are shown as they are. */
function failure(error) {
  if (error?.code === 'P0001' && error.message) return new Error(error.message);
  return new Error('The vote server did not answer. Try again in a moment.');
}

/** Loads Cloudflare Turnstile once, for the captcha Supabase asks for at sign in when set up. */
let turnstile;
function loadTurnstile() {
  turnstile ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = TURNSTILE_JS;
    script.async = true;
    script.onload = () => resolve(window.turnstile);
    script.onerror = () => {
      turnstile = undefined;
      reject(new Error('The check that you are human did not load. Try again in a moment.'));
    };
    document.head.append(script);
  });
  return turnstile;
}

/** A captcha token from Turnstile, shown in the given box until it is solved. */
async function captchaToken(box) {
  const widgets = await loadTurnstile();
  box.hidden = false;
  try {
    return await new Promise((resolve, reject) => {
      widgets.render(box, {
        sitekey: captchaSiteKey,
        callback: resolve,
        'error-callback': () => reject(new Error('The check that you are human failed. Try again.')),
        'expired-callback': () => reject(new Error('The check that you are human expired. Try again.')),
      });
    });
  } finally {
    box.hidden = true;
    box.replaceChildren();
  }
}

/** Signs in anonymously, unless this browser already has a session. */
async function signIn(captchaBox) {
  const db = await supabase();
  const { data } = await db.auth.getSession();
  if (data.session) return db;
  const options = captchaSiteKey ? { captchaToken: await captchaToken(captchaBox) } : undefined;
  const { error } = await db.auth.signInAnonymously({ options });
  if (error) {
    throw new Error(error.status === 429
      ? 'Too many new juries from here just now. Try again later.'
      : 'Could not sign you in to vote. Try again in a moment.');
  }
  return db;
}

/**
 * Casts the jury's votes, replacing any it cast before.
 * @param {string} jury
 * @param {Record<string, number>} votes song id to points
 * @param {HTMLElement} captchaBox where the captcha shows, when one is set up
 */
export async function castBallot(jury, votes, captchaBox) {
  const db = await signIn(captchaBox);
  const { error } = await db.rpc('cast_ballot', { jury, votes });
  if (error) throw failure(error);
}

/**
 * The votes this browser cast before, or null; it signs no one in.
 * @returns {Promise<{ jury: string, votes: Record<string, number> } | null>}
 */
export async function myBallot() {
  const db = await supabase();
  const { data: session } = await db.auth.getSession();
  if (!session.session) return null;
  const { data, error } = await db.rpc('my_ballot');
  if (error) throw failure(error);
  return data;
}

/**
 * The totals: how many juries voted, from how many countries, whether voting is open, and each
 * song's points, highest first.
 * @returns {Promise<{ juries: number, countries: number, open: boolean, songs: { song: string, points: number, juries: number, twelves: number }[] }>}
 */
export async function scoreboard() {
  const db = await supabase();
  const { data, error } = await db.rpc('scoreboard');
  if (error) throw failure(error);
  return data;
}
