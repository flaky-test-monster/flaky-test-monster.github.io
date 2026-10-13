/**
 * The admin page of the jury vote (music-admin.html): an admin signs in with an email and
 * password, then lists, adds and deletes ballots, and opens or closes voting. Only the database
 * decides who is an admin (public.admins, see supabase/migrations/): this page just asks it, and
 * every admin_* function checks again. Everything shown comes in as data and goes on the page
 * as text only.
 */

import { connect, online } from './music-online.js';

const $ = (id) => document.getElementById(id);
const POINTS = [12, 10, 8, 7, 6, 5, 4, 3, 2, 1];
// Kept apart from the voter's anonymous session in the same browser.
const STORAGE_KEY = 'flaky-admin-auth';

/** @type {import('@supabase/supabase-js').SupabaseClient} */
let db;
/** The songs of the contest, in their order: [{ id, title }]. */
let songs = [];

const pointsLabel = (points) => (points === 12 ? 'Douze points' : `${points} ${points === 1 ? 'point' : 'points'}`);

/** Shows one of the three states of the page. */
function show(state) {
  $('admin-off').hidden = state !== 'off';
  $('admin-signin').hidden = state !== 'signin';
  $('admin-panel').hidden = state !== 'panel';
}

/**
 * The message for a failed call: the database's own message for what an admin did wrong
 * (P0001), and plain words for the rest. Losing admin rights, or the session, ends the panel.
 */
function failure(error) {
  if (error?.code === '42501' || /JWT|token/i.test(error?.message ?? '')) {
    signedOut('Your session ended, or this account is no longer an admin. Sign in again.');
    return 'Signed out.';
  }
  if (error?.code === 'P0001' && error.message) return error.message;
  return 'The vote server did not answer. Try again in a moment.';
}

/** Calls an admin function; throws the message to show when it fails. */
async function call(name, args) {
  const { data, error } = await db.rpc(name, args);
  if (error) throw new Error(failure(error));
  return data;
}

/** Back to the sign-in, with a message. */
function signedOut(message = '') {
  show('signin');
  $('signin-status').textContent = message;
  $('signin-password').value = '';
}

/** Opens the panel for the signed-in user, if the database says they are an admin. */
async function enter(email) {
  const { data: admin, error } = await db.rpc('is_admin');
  if (error || !admin) {
    await db.auth.signOut();
    return signedOut(error ? failure(error) : 'This account is not an admin of the jury vote.');
  }
  $('admin-who').textContent = `Signed in as ${email}.`;
  show('panel');
  await load();
}

/** Loads whether voting is open, the songs and the ballots, and shows them. */
async function load() {
  $('ballots-status').textContent = 'Loading…';
  try {
    const overview = await call('admin_overview');
    if (!overview) return;
    $('ballots-status').textContent = '';
    if (songs.length === 0) {
      songs = overview.songs;
      buildPoints();
    }
    renderContest(overview.open);
    renderBallots(overview.ballots);
  } catch (error) {
    $('ballots-status').textContent = error.message;
  }
}

function renderContest(open) {
  $('contest-state').textContent = open ? 'Voting is open.' : 'Voting is closed: only admins can add ballots.';
  $('contest-toggle').textContent = open ? 'Close voting' : 'Open voting';
  $('contest-toggle').dataset.open = String(open);
}

/** The ballots, newest first, each with its points, where it came from, and a delete button. */
function renderBallots(ballots) {
  const cast = ballots.filter((ballot) => ballot.source === 'online').length;
  $('ballots-count').textContent = ballots.length === 0
    ? 'No ballots yet.'
    : `${ballots.length} ${ballots.length === 1 ? 'ballot' : 'ballots'}: ${cast} cast online, ${ballots.length - cast} added here.`;
  const titles = new Map(songs.map((song) => [song.id, song.title]));
  $('ballots-list').replaceChildren(...ballots.map((ballot) => {
    const item = document.createElement('li');
    item.className = 'admin-ballot';
    const head = document.createElement('div');
    head.className = 'admin-ballot-head';
    const jury = document.createElement('strong');
    jury.textContent = ballot.jury || '(no name)';
    const meta = document.createElement('span');
    meta.className = 'helper';
    const when = new Date(ballot.created_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    meta.textContent = [ballot.source === 'admin' ? 'added here' : 'cast online', ballot.country, when].filter(Boolean).join(' · ');
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'admin-button admin-delete';
    remove.textContent = 'Delete';
    remove.setAttribute('aria-label', `Delete the ballot of ${ballot.jury || 'a jury with no name'}`);
    remove.addEventListener('click', () => deleteBallot(ballot, remove));
    head.append(jury, meta, remove);
    const points = document.createElement('p');
    points.className = 'admin-ballot-points';
    points.textContent = Object.entries(ballot.votes)
      .sort(([, a], [, b]) => b - a)
      .map(([song, value]) => `${pointsLabel(value)}: ${titles.get(song) ?? song}`)
      .join(' · ');
    item.append(head, points);
    return item;
  }));
}

async function deleteBallot(ballot, button) {
  const who = ballot.jury || 'a jury with no name';
  const again = ballot.source === 'online' ? ' The voter will be able to vote again.' : '';
  if (!confirm(`Delete the ballot of ${who}? Its points come off the scoreboard.${again}`)) return;
  button.disabled = true;
  let message;
  try {
    await call('admin_delete_ballot', { ballot: ballot.id });
    message = `Deleted the ballot of ${who}.`;
  } catch (error) {
    message = error.message;
  }
  // The list first, as loading it clears the line the message goes on.
  await load();
  $('ballots-status').textContent = message;
}

/** A choice of points for each song in the add form; a score given to one song is taken. */
function buildPoints() {
  $('add-songs').replaceChildren(...songs.map((song) => {
    const label = document.createElement('label');
    label.className = 'admin-song';
    const title = document.createElement('span');
    title.textContent = song.title;
    const select = document.createElement('select');
    select.dataset.song = song.id;
    select.add(new Option('No points', ''));
    for (const points of POINTS) select.add(new Option(pointsLabel(points), String(points)));
    select.addEventListener('change', renderPoints);
    label.append(title, select);
    return label;
  }));
}

const pointSelects = () => [...$('add-songs').querySelectorAll('select')];

function renderPoints() {
  const given = new Set(pointSelects().map((select) => select.value).filter(Boolean));
  for (const select of pointSelects()) {
    for (const option of select.options) option.disabled = option.value !== '' && option.value !== select.value && given.has(option.value);
  }
}

$('add-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const votes = Object.fromEntries(pointSelects().filter((select) => select.value).map((select) => [select.dataset.song, Number(select.value)]));
  const jury = $('add-jury').value.trim();
  if (!jury) return ($('add-status').textContent = 'Give the jury a name.');
  if (Object.keys(votes).length === 0) return ($('add-status').textContent = 'Give at least one song some points.');
  const button = event.submitter;
  button.disabled = true;
  try {
    await call('admin_add_ballot', { jury, votes });
    $('add-status').textContent = `Added the ballot of ${jury}.`;
    $('add-form').reset();
    renderPoints();
    await load();
  } catch (error) {
    $('add-status').textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

$('contest-toggle').addEventListener('click', async () => {
  const open = $('contest-toggle').dataset.open !== 'true';
  if (!open && !confirm('Close voting? Nobody can cast a ballot online until it is open again.')) return;
  $('contest-toggle').disabled = true;
  let message = '';
  try {
    await call('admin_set_open', { open });
  } catch (error) {
    message = error.message;
  }
  $('contest-toggle').disabled = false;
  await load();
  if (message) $('ballots-status').textContent = message;
});

$('ballots-refresh').addEventListener('click', load);

$('signout').addEventListener('click', async () => {
  await db.auth.signOut();
  signedOut('Signed out.');
});

$('signin-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const email = $('signin-email').value.trim();
  const password = $('signin-password').value;
  if (!email || !password) return ($('signin-status').textContent = 'Fill in the email and the password.');
  const button = event.submitter;
  button.disabled = true;
  $('signin-status').textContent = 'Signing in…';
  const { data, error } = await db.auth.signInWithPassword({ email, password });
  button.disabled = false;
  if (error) {
    // The same words whether the email or the password is wrong, as Supabase says too.
    $('signin-status').textContent = error.status === 429
      ? 'Too many tries. Wait a while, then try again.'
      : 'That email and password do not match an account.';
    return;
  }
  $('signin-status').textContent = '';
  await enter(data.user.email);
});

if (!online) {
  show('off');
} else {
  db = await connect(STORAGE_KEY);
  const { data } = await db.auth.getSession();
  const user = data.session?.user;
  if (user && !user.is_anonymous) await enter(user.email);
  else signedOut();
}
