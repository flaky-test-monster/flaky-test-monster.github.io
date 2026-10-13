/**
 * The jury vote on the music page: points for the songs as at the Eurovision Song Contest
 * (12, 10, 8 and down to 1, each score to one song only). With a Supabase project set up in the
 * page's meta tags the votes are cast online (music-online.js) and the scoreboard shows the
 * totals; without one, they go out as a mailto: link. The jury photo and the votes can also be
 * shared, through the share sheet of browsers that can share images.
 */

import { castBallot, myBallot, online } from './music-online.js';
import { juryName, juryPhoto, nameError, nameMessage, sayPhoto } from './music-photo.js';

const $ = (id) => document.getElementById(id);
const form = $('vote-form');
const status = $('vote-status');
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

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const error = nameError();
  if (error) {
    // The field is on the jury photo, further down: go there, where its error says what to do.
    $('jury-name').focus();
    return say('The votes were not sent: the name on the jury photo needs fixing.');
  }
  const body = ballot();
  if (!body) return say('Give at least one song some points first: the choice is next to each song.');
  if (online) cast();
  else email(body);
});

/** Casts the votes online; the scoreboard hears about it and updates. */
async function cast() {
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  say('Casting your votes…');
  try {
    await castBallot(juryName(), votes(), $('vote-captcha'));
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

/** Online, the button says so, and a jury that voted before from this browser gets its points back. */
async function goOnline() {
  form.querySelector('[type="submit"]').textContent = 'Cast my votes';
  $('vote-privacy').hidden = false;
  try {
    const mine = await myBallot();
    // Only if nothing was picked while the ballot loaded.
    if (!mine || selects().some((select) => select.value)) return;
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
