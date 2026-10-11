/**
 * The jury vote on the music page: points for the songs as at the Eurovision Song Contest
 * (12, 10, 8 and down to 1, each score to one song only). With a Supabase project set up in the
 * page's meta tags the votes are cast online (music-online.js), and the scoreboard shows the
 * totals; without one, they go out as a mailto: link, or are copied for pasting into webmail.
 */

import { castBallot, myBallot, online } from './music-online.js';

const $ = (id) => document.getElementById(id);
const form = $('vote-form');
const status = $('vote-status');
const POINTS = [12, 10, 8, 7, 6, 5, 4, 3, 2, 1];
const SUBJECT = 'From Flaky With Love: my votes';

/** The songs, in the order of the song list, and their ids in the database. */
const songItems = [...document.querySelectorAll('.song')];
const songs = songItems.map((song) => song.querySelector('h3').textContent.trim());
const songIds = songItems.map((song) => song.dataset.song);

/** Puts a choice of points right next to each song's player. The choices sit outside the form,
 * so they join it with the form attribute: then reset clears them too. */
function buildVotes() {
  songItems.forEach((song, index) => {
    const vote = document.createElement('div');
    vote.className = 'song-vote';
    const label = document.createElement('label');
    label.htmlFor = `vote-song-${index}`;
    const hidden = document.createElement('span');
    hidden.className = 'visually-hidden';
    hidden.textContent = ` for ${songs[index]}`;
    label.append('Points', hidden);
    const select = document.createElement('select');
    select.id = `vote-song-${index}`;
    select.name = `song-${index}`;
    select.setAttribute('form', form.id);
    select.add(new Option('No points', ''));
    for (const points of POINTS) select.add(new Option(points === 1 ? '1 point' : `${points} points`, String(points)));
    select.addEventListener('change', () => {
      render();
      hideCopy();
    });
    vote.append(label, select);
    song.querySelector('.player').after(vote);
  });
}

/** @returns {HTMLSelectElement[]} */
const selects = () => songItems.map((song) => song.querySelector('.song-vote select'));

/** Each score goes to one song only: a score given to one song cannot be picked for another. */
function render() {
  const given = new Set(selects().map((select) => select.value).filter(Boolean));
  for (const select of selects()) {
    for (const option of select.options) option.disabled = option.value !== '' && option.value !== select.value && given.has(option.value);
    const song = select.closest('.song');
    song.classList.toggle('song-voted', select.value !== '');
    song.classList.toggle('song-top', select.value === '12');
  }
}

/** The votes for the database: song id to points. */
function votes() {
  return Object.fromEntries(selects()
    .map((select, index) => [songIds[index], Number(select.value)])
    .filter(([, points]) => points > 0));
}

/** The votes, highest score first, as the lines of the email. */
function ballot() {
  const votes = selects()
    .map((select, index) => ({ points: Number(select.value), title: songs[index] }))
    .filter((vote) => vote.points > 0)
    .sort((a, b) => b.points - a.points);
  if (votes.length === 0) return null;
  const jury = $('vote-jury').value.replace(/\s+/g, ' ').trim();
  const lines = votes.map(({ points, title }) => `${points === 12 ? 'Douze points' : `${points} ${points === 1 ? 'point' : 'points'}`}: ${title}`);
  return [`Good evening Flaky Test Monster, this is the jury of ${jury || 'an undisclosed country'}.`, '', ...lines, ''].join('\n');
}

/** Hides the votes shown for copying by hand, and the message that goes with them. */
function hideCopy() {
  if ($('vote-copy-field').hidden) return;
  $('vote-copy-field').hidden = true;
  say('');
}

/** Shows a message under the votes. */
function say(message) {
  status.textContent = message;
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const body = ballot();
  if (!body) {
    say('Give at least one song some points first: the choice is next to each song.');
    selects()[0]?.focus();
    return;
  }
  if (online) cast();
  else email(body);
});

/** Casts the votes online; the scoreboard hears about it and updates. */
async function cast() {
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  say('Casting your votes…');
  try {
    await castBallot($('vote-jury').value, votes(), $('vote-captcha'));
    say('Your votes are in, thank you! Changed your mind? Change the points and cast them again.');
    document.dispatchEvent(new CustomEvent('flaky:voted'));
  } catch (error) {
    say(error.message);
  } finally {
    submit.disabled = false;
  }
}

/** Opens the email app with the votes. */
function email(body) {
  // mailto: wants CRLF line breaks (RFC 6068) and %20, not +, for spaces.
  const params = new URLSearchParams({ subject: SUBJECT, body: body.replace(/\n/g, '\r\n') }).toString().replace(/\+/g, '%20');
  // @ and + stay as they are: some email apps do not decode %40 or %2B in the address.
  const to = encodeURIComponent(form.dataset.email ?? '').replace(/%40/g, '@').replace(/%2B/g, '+');
  location.href = `mailto:${to}?${params}`;
  say('Your email app should open with your votes. No email app? Copy your votes and send them from your webmail.');
}

$('vote-copy').addEventListener('click', async () => {
  const body = ballot();
  if (!body) return say('Give at least one song some points first.');
  try {
    await navigator.clipboard.writeText(`${SUBJECT}\n\n${body}`);
    say(form.dataset.email ? `Copied. Paste your votes into an email to ${form.dataset.email}.` : 'Copied. Paste your votes into an email.');
  } catch {
    // No clipboard here (an old browser, or a page not served over HTTPS): show the votes to copy by hand.
    $('vote-text').value = `${SUBJECT}\n\n${body}`;
    $('vote-copy-field').hidden = false;
    $('vote-text').focus();
    $('vote-text').select();
    say('Copying did not work in this browser. Your votes are selected below: copy them with Ctrl+C or ⌘C.');
  }
});

// Reset puts the values back only after this event, so render once it is done.
form.addEventListener('reset', () => setTimeout(() => {
  render();
  say('');
  hideCopy();
}));

// The votes to copy by hand are a snapshot: once the points or the jury change, they are out of date.
$('vote-jury').addEventListener('input', hideCopy);

/** Online, the form says so, and a jury that voted before from this browser gets its votes back. */
async function goOnline() {
  $('vote-intro').textContent = 'Given your points next to the songs? Tell us who is voting and cast your votes. You can change them until voting closes.';
  form.querySelector('[type="submit"]').textContent = 'Cast my votes';
  try {
    const mine = await myBallot();
    if (!mine) return;
    // Only if nothing was picked while the ballot loaded.
    if (selects().some((select) => select.value) || $('vote-jury').value) return;
    $('vote-jury').value = mine.jury;
    selects().forEach((select, index) => { select.value = String(mine.votes[songIds[index]] ?? ''); });
    render();
    say('Welcome back, jury. These are the votes you cast: change them and cast them again, if you like.');
  } catch {
    // Not knowing the earlier votes is fine: casting again replaces them.
  }
}

buildVotes();
render();
if (online) goOnline();
