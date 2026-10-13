/**
 * The scoreboard on the music page: the songs' points from the online jury vote, highest first,
 * as at the end of the Eurovision Song Contest. It shows only with a Supabase project set up
 * (music-online.js), updates every half minute while the page is in view, and right after a
 * jury on this page casts its votes.
 */

import { online, scoreboard } from './music-online.js';

const $ = (id) => document.getElementById(id);
const section = $('scoreboard');
const list = $('scoreboard-list');
const status = $('scoreboard-status');
const REFRESH_MS = 30_000;

/** The song titles, by song id, from the song list. */
const titles = new Map([...document.querySelectorAll('.song')]
  .map((song) => [song.dataset.song, song.querySelector('h3').textContent.trim()]));

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

function render(board) {
  const songs = board.songs.filter((row) => titles.has(row.song));
  const top = Math.max(1, ...songs.map((row) => row.points));
  list.replaceChildren(...songs.map((row, index) => {
    const item = document.createElement('li');
    item.className = 'score';
    item.classList.toggle('score-leader', index === 0 && row.points > 0);
    const rank = document.createElement('span');
    rank.className = 'score-rank';
    rank.textContent = String(index + 1);
    const title = document.createElement('span');
    title.className = 'score-title';
    title.textContent = titles.get(row.song);
    const points = document.createElement('span');
    points.className = 'score-points';
    points.textContent = plural(row.points, 'point', 'points');
    const detail = document.createElement('span');
    detail.className = 'helper score-detail';
    if (row.juries === 0) detail.textContent = 'No points yet';
    else if (row.twelves > 0) detail.textContent = `${plural(row.juries, 'jury', 'juries')}, douze points from ${row.twelves}`;
    else detail.textContent = plural(row.juries, 'jury', 'juries');
    // The bar is decoration: the points say it in words.
    const bar = document.createElement('span');
    bar.className = 'score-bar';
    bar.setAttribute('aria-hidden', 'true');
    bar.style.setProperty('--share', String(row.points / top));
    item.append(rank, title, points, detail, bar);
    return item;
  }));
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  // The countries are counted from where the votes came in; ballots of unknown origin are not.
  const from = board.countries > 0 ? ` from ${plural(board.countries, 'country', 'countries')}` : '';
  const juries = board.juries === 0 ? 'No jury has voted yet' : `${plural(board.juries, 'jury', 'juries')}${from} ${board.juries === 1 ? 'has' : 'have'} voted`;
  status.textContent = `${juries}${board.open ? '' : ', and voting is closed'}. Updated ${time}.`;
}

// One request at a time; one asked for meanwhile, say right after a vote, follows it.
let loading = false;
let again = false;
async function refresh() {
  if (loading) {
    again = true;
    return;
  }
  loading = true;
  try {
    render(await scoreboard());
  } catch (error) {
    status.textContent = `${error.message} The scoreboard shows the last scores it had.`;
  } finally {
    loading = false;
    if (again) {
      again = false;
      refresh();
    }
  }
}

if (online) {
  section.hidden = false;
  refresh();
  setInterval(() => {
    if (document.visibilityState === 'visible') refresh();
  }, REFRESH_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh();
  });
  document.addEventListener('flaky:voted', refresh);
  $('scoreboard-refresh').addEventListener('click', refresh);
}
