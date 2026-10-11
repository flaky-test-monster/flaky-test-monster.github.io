/**
 * The jury vote on the music page: points for the songs as at the Eurovision Song Contest
 * (12, 10, 8 and down to 1, each score to one song only), sent by email. There is no backend,
 * so the votes go out as a mailto: link. The jury photo and the votes can also be shared, through
 * the share sheet of browsers that can share images.
 */

import { checkName, juryName, juryPhoto, sayPhoto } from './music-photo.js';

const $ = (id) => document.getElementById(id);
const form = $('vote-form');
const status = $('vote-status');
const POINTS = [12, 10, 8, 7, 6, 5, 4, 3, 2, 1];
const SUBJECT = 'From Flaky With Love: my votes';

/** The songs, in the order of the song list. */
const songItems = [...document.querySelectorAll('.song')];
const songs = songItems.map((song) => song.querySelector('h3').textContent.trim());

/** Puts a choice of points right next to each song's player. */
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
  if (!checkName()) return say('');
  const body = ballot();
  if (!body) {
    say('Give at least one song some points first: the choice is next to each song.');
    selects()[0]?.focus();
    return;
  }
  // mailto: wants CRLF line breaks (RFC 6068) and %20, not +, for spaces.
  const params = new URLSearchParams({ subject: SUBJECT, body: body.replace(/\n/g, '\r\n') }).toString().replace(/\+/g, '%20');
  // @ and + stay as they are: some email apps do not decode %40 or %2B in the address.
  const to = encodeURIComponent(form.dataset.email ?? '').replace(/%40/g, '@').replace(/%2B/g, '+');
  location.href = `mailto:${to}?${params}`;
  say(form.dataset.email ? `Your email app should open with your votes. No email app? Send them to ${form.dataset.email} from your webmail.` : 'Your email app should open with your votes.');
});

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
  if (!checkName()) return sayPhoto('');
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

buildVotes();
render();
