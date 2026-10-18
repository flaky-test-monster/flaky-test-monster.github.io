/**
 * The jury vote on the music page: points for the songs as at the Eurovision Song Contest
 * (12, 10, 8 and down to 1, each score to one song only). With a Supabase project set up in the
 * page's meta tags the votes are cast online (music-online.js) and the scoreboard shows the
 * totals; without one, they go out as a mailto: link. Either way they can also go by email or be
 * copied, for pasting into webmail. The jury photo and the votes can also be shared, through the
 * share sheet of browsers that can share images.
 */

import { castBallot, myBallot, online } from './music-online.js';
import { juryName, juryPhoto, nameError, nameMessage, sayPhoto } from './music-photo.js';

const $ = (id) => document.getElementById(id);
const form = $('vote-form');
const status = $('vote-status');
const submit = form.querySelector('[type="submit"]');
const POINTS = [12, 10, 8, 7, 6, 5, 4, 3, 2, 1];
const SUBJECT = 'From Flaky With Love: my votes';

/** The songs, in the order of the song list, and their ids in the database. */
const songItems = [...document.querySelectorAll('.song')];
const songs = songItems.map((song) => song.querySelector('h3').textContent.trim());
const songIds = songItems.map((song) => song.dataset.song);

/** Puts a choice of points right next to each song's player. */
function buildVotes() {
  songItems.forEach((song, index) => {
    const vote = document.createElement('div');
    vote.className = 'song-vote';
    const label = document.createElement('label');
    label.htmlFor = `vote-song-${index}`;
    label.className = 'visually-hidden';
    label.textContent = `Points for ${songs[index]}`;
    const select = document.createElement('select');
    select.id = `vote-song-${index}`;
    select.name = `song-${index}`;
    select.add(new Option('No points', ''));
    for (const points of POINTS) select.add(new Option(points === 1 ? '1 point' : `${points} points`, String(points)));
    select.addEventListener('change', () => {
      render();
      say('');
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

/** The votes, highest score first, one line each: "Douze points: The Greek version". */
function voteLines() {
  return selects()
    .map((select, index) => ({ points: Number(select.value), title: songs[index] }))
    .filter((vote) => vote.points > 0)
    .sort((a, b) => b.points - a.points)
    .map(({ points, title }) => `${points === 12 ? 'Douze points' : `${points} ${points === 1 ? 'point' : 'points'}`}: ${title}`);
}

/** The votes as the email, or null when no song has points yet. */
function ballot() {
  const lines = voteLines();
  if (lines.length === 0) return null;
  return [`Good evening Flaky Test Monster, this is ${juryName()} from the jury.`, '', ...lines, ''].join('\n');
}

/** Shows a message under the votes. */
function say(message) {
  status.textContent = message;
}

/** The email for the votes, once the name and the points are ready; otherwise null, and why. */
function readyBallot() {
  if (nameError()) {
    // The name field is right above the button, and its error says what to do.
    $('vote-name').focus();
    say('The votes were not sent: the jury name needs fixing.');
    return null;
  }
  const body = ballot();
  if (!body) say('Give at least one song some points first: the choice is next to each song.');
  return body;
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const body = readyBallot();
  if (!body) return;
  if (online) cast();
  else email(body);
});

// Online, the menu offers the direct vote too, the default: the same as the main button.
// Not while a vote is on its way, which disables the main button.
$('vote-cast').addEventListener('click', () => {
  if (!submit.disabled) form.requestSubmit();
});

// Online, email stays a choice next to the online vote; offline, it is the main button.
$('vote-email').addEventListener('click', () => {
  const body = readyBallot();
  if (body) email(body);
});

/** The menu of the split button: the other ways to send the votes, opened by its arrow. */
const more = $('vote-more');
const menu = $('vote-menu');
const menuItems = () => [...menu.querySelectorAll('[role="menuitem"]')].filter((item) => !item.hidden);

function openMenu() {
  menu.hidden = false;
  more.setAttribute('aria-expanded', 'true');
  menuItems()[0]?.focus();
}

/** Closes the menu; focus goes back to the arrow unless it has moved on, say to a picked item's result. */
function closeMenu(refocus = true) {
  if (menu.hidden) return;
  menu.hidden = true;
  more.setAttribute('aria-expanded', 'false');
  if (refocus) more.focus();
}

more.addEventListener('click', () => (menu.hidden ? openMenu() : closeMenu()));
more.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    openMenu();
  }
});
menu.addEventListener('keydown', (event) => {
  const items = menuItems();
  const at = items.indexOf(document.activeElement);
  if (event.key === 'Escape') {
    event.preventDefault();
    closeMenu();
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    items[(at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
  } else if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault();
    items[event.key === 'Home' ? 0 : items.length - 1].focus();
  } else if (event.key === 'Tab') {
    closeMenu(false);
  }
});
// A pick closes the menu before it runs, so the pick can move focus where it needs to.
menu.addEventListener('click', (event) => {
  if (event.target.closest('[role="menuitem"]')) closeMenu();
}, true);
// A click anywhere else closes it too.
document.addEventListener('pointerdown', (event) => {
  if (!event.target.closest('.vote-split')) closeMenu(false);
});

$('vote-copy').addEventListener('click', async () => {
  const body = readyBallot();
  if (!body) return;
  const text = `${SUBJECT}\n\n${body}`;
  const to = form.dataset.email;
  try {
    await navigator.clipboard.writeText(text);
    hideCopy();
    say(to ? `Copied. Paste your votes into an email to ${to}.` : 'Copied. Paste your votes into an email.');
  } catch {
    // No clipboard here (an older browser, or a page not served over HTTPS): show the votes to copy by hand.
    $('vote-text').value = text;
    $('vote-copy-field').hidden = false;
    $('vote-text').focus();
    $('vote-text').select();
    say('Copying did not work in this browser. Your votes are selected below: copy them with Ctrl+C or ⌘C.');
  }
});

/** Hides the votes shown for copying by hand: once the points change, they are out of date. */
function hideCopy() {
  $('vote-copy-field').hidden = true;
}

/** Casts the votes online, once; the scoreboard hears about it and updates. */
async function cast() {
  // Read before sending: the points could still be changed while the vote is on its way.
  const ballot = { jury: juryName(), votes: votes() };
  submit.disabled = true;
  say('Casting your votes…');
  try {
    await castBallot(ballot.jury, ballot.votes, $('vote-captcha'));
    lock(ballot);
    say('Your votes are in, thank you! Votes are final, so these are the ones that count.');
    document.dispatchEvent(new CustomEvent('flaky:voted'));
  } catch (error) {
    submit.disabled = false;
    say(error.message);
    // Voted already, say in another tab: show the votes that count instead of these.
    if (error.alreadyVoted) showCast().catch(() => {});
  }
}

/**
 * Shows a ballot already cast, which is final: its points and name, which can no longer be
 * changed, and a button that says the votes are in. Email and copy still work, with these votes.
 * @param {{ jury: string, votes: Record<string, number> }} ballot
 */
function lock(ballot) {
  selects().forEach((select, index) => {
    select.value = String(ballot.votes[songIds[index]] ?? '');
    select.disabled = true;
  });
  render();
  hideCopy();
  // The name goes into both name fields through the photo's own handling, which redraws it.
  $('vote-name').value = ballot.jury;
  $('vote-name').dispatchEvent(new Event('input'));
  $('vote-name').disabled = true;
  $('jury-name').disabled = true;
  $('vote-name-hint').hidden = true;
  submit.textContent = 'Votes cast';
  submit.disabled = true;
  $('vote-cast').hidden = true;
}

/** Shows this browser's ballot, when it has cast one; resolves to whether it has. */
async function showCast() {
  const mine = await myBallot();
  if (mine) lock(mine);
  return Boolean(mine);
}

/** Opens the email app with the votes. */
function email(body) {
  // mailto: wants CRLF line breaks (RFC 6068) and %20, not +, for spaces.
  const params = new URLSearchParams({ subject: SUBJECT, body: body.replace(/\n/g, '\r\n') }).toString().replace(/\+/g, '%20');
  // @ and + stay as they are: some email apps do not decode %40 or %2B in the address.
  const to = encodeURIComponent(form.dataset.email ?? '').replace(/%40/g, '@').replace(/%2B/g, '+');
  location.href = `mailto:${to}?${params}`;
  say(form.dataset.email ? `Your email app should open with your votes. No email app? Send them to ${form.dataset.email} from your webmail.` : 'Your email app should open with your votes.');
}

/** Whether this browser can share an image, through the share sheet of the phone or computer. */
const canShareImages = () => {
  try {
    return Boolean(navigator.canShare?.({ files: [new File([''], 'test.png', { type: 'image/png' })] }));
  } catch {
    return false;
  }
};

/**
 * Shares the jury photo and the votes, to any app the share sheet offers, with a link to this
 * page so whoever gets them can vote too. It starts right on the click: the photo file is made
 * ahead of time, since browsers only allow sharing straight after a click.
 */
function share() {
  const error = nameError();
  if (error) return sayPhoto(nameMessage(error));
  const photo = juryPhoto();
  if (!photo) return sayPhoto('The photo is still being made. Try again in a moment.');
  const lines = voteLines();
  const text = [`${juryName()}, live from the Flaky jury.`, ...(lines.length ? ['', ...lines] : []), '', 'Vote too:'].join('\n');
  sayPhoto('');
  navigator.share({ title: 'From Flaky With Love', text, url: location.origin + location.pathname, files: [photo] }).then(
    () => sayPhoto('Shared. Douze points for you!'),
    (error) => {
      if (error.name !== 'AbortError') sayPhoto('Sharing did not work in this browser. Download the photo instead.');
    },
  );
}

$('photo-share').hidden = !canShareImages();
$('photo-share').addEventListener('click', share);

/** Online, the button says so, and a jury that voted before from this browser sees its votes. */
async function goOnline() {
  submit.textContent = 'Cast my votes';
  $('vote-cast').hidden = false;
  $('vote-email').hidden = false;
  $('vote-privacy').hidden = false;
  try {
    if (await showCast()) say('Welcome back, jury. These are the votes you cast, and votes are final.');
  } catch {
    // Not knowing the earlier votes is fine: the database turns a second ballot away anyway.
  }
}

buildVotes();
render();
if (online) goOnline();
