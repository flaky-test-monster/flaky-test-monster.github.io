/**
 * The jury vote on the music page: points for the songs as at the Eurovision Song Contest
 * (12, 10, 8 and down to 1, each score to one song only), sent by email. There is no backend,
 * so the votes go out as a mailto: link, or are copied for pasting into webmail.
 */

const $ = (id) => document.getElementById(id);
const form = $('vote-form');
const rows = $('vote-rows');
const status = $('vote-status');
const POINTS = [12, 10, 8, 7, 6, 5, 4, 3, 2, 1];
const SUBJECT = 'From Flaky With Love: my votes';

/** The song titles, in the order of the song list. */
const songs = [...document.querySelectorAll('.song h3')].map((heading) => heading.textContent.trim());

/** One row per song: its title and a choice of points. */
function buildRows() {
  songs.forEach((title, index) => {
    const row = document.createElement('li');
    row.className = 'vote-row';
    const label = document.createElement('label');
    label.htmlFor = `vote-song-${index}`;
    label.textContent = title;
    const select = document.createElement('select');
    select.id = `vote-song-${index}`;
    select.name = `song-${index}`;
    select.add(new Option('No points', ''));
    for (const points of POINTS) select.add(new Option(points === 1 ? '1 point' : `${points} points`, String(points)));
    row.append(label, select);
    rows.append(row);
  });
}

/** @returns {HTMLSelectElement[]} */
const selects = () => [...rows.querySelectorAll('select')];

/** Each score goes to one song only: a score given to one song cannot be picked for another. */
function render() {
  const given = new Set(selects().map((select) => select.value).filter(Boolean));
  for (const select of selects()) {
    for (const option of select.options) option.disabled = option.value !== '' && option.value !== select.value && given.has(option.value);
    select.closest('.vote-row').classList.toggle('vote-row-top', select.value === '12');
  }
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

/** Shows a message under the votes. */
function say(message) {
  status.textContent = message;
}

form.addEventListener('change', render);

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const body = ballot();
  if (!body) {
    say('Give at least one song some points first.');
    selects()[0]?.focus();
    return;
  }
  // mailto: wants CRLF line breaks (RFC 6068) and %20, not +, for spaces.
  const params = new URLSearchParams({ subject: SUBJECT, body: body.replace(/\n/g, '\r\n') }).toString().replace(/\+/g, '%20');
  location.href = `mailto:${encodeURIComponent(form.dataset.email ?? '').replace(/%40/g, '@')}?${params}`;
  say('Your email app should open with your votes. No email app? Copy your votes and send them from your webmail.');
});

$('vote-copy').addEventListener('click', async () => {
  const body = ballot();
  if (!body) return say('Give at least one song some points first.');
  try {
    await navigator.clipboard.writeText(`${SUBJECT}\n\n${body}`);
    say(form.dataset.email ? `Copied. Paste your votes into an email to ${form.dataset.email}.` : 'Copied. Paste your votes into an email.');
  } catch {
    // No clipboard here (an old browser, or a page not served over HTTPS): show the votes to copy by hand.
    $('vote-text').textContent = `${SUBJECT}\n\n${body}`;
    $('vote-text').hidden = false;
    say('Copying did not work in this browser. Select your votes below and copy them by hand.');
  }
});

// Reset puts the values back only after this event, so render once it is done.
form.addEventListener('reset', () => setTimeout(() => {
  render();
  say('');
  $('vote-text').hidden = true;
}));

buildRows();
render();
