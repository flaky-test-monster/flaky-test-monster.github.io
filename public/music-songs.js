/**
 * The song players on the music page: play and pause, a position slider and the time, for
 * each song's MP3. Only one song or the music video plays at a time. A song whose MP3 cannot
 * be loaded falls back to Suno's own embed, so the page keeps working until every MP3 is in.
 */

/** "1:05" for 65 seconds; "0:00" while the length is not known yet. */
function clock(seconds) {
  const whole = Number.isFinite(seconds) ? Math.floor(seconds) : 0;
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/** Puts Suno's embed in place of the player, with the name the player had. */
function fallBackToSuno(song, name) {
  // An error already set when this module ran can still have its event queued: fall back once.
  const player = song.querySelector('.player');
  if (!player) return;
  const iframe = document.createElement('iframe');
  iframe.title = `${name}, on Suno`;
  iframe.src = `https://suno.com/embed/${song.dataset.suno}`;
  iframe.width = '760';
  iframe.height = '240';
  iframe.allow = 'autoplay; encrypted-media; fullscreen';
  iframe.loading = 'lazy';
  iframe.referrerPolicy = 'no-referrer-when-downgrade';
  player.replaceWith(iframe);
}

/** Tells the lock screen and headphone controls which song is playing. */
function announce(title) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title,
    artist: 'The Flaky Test Monster',
    album: 'From Flaky With Love',
    artwork: [{ src: new URL('monster.jpg', import.meta.url).href, type: 'image/jpeg' }],
  });
}

function setUp(song) {
  const audio = song.querySelector('audio');
  const play = song.querySelector('.song-play');
  const seek = song.querySelector('.song-seek');
  const time = song.querySelector('.song-time');
  const name = seek.getAttribute('aria-label').replace(/^Position in /, '');

  function render() {
    const playing = !audio.paused && !audio.ended;
    play.textContent = playing ? 'Pause' : 'Play';
    play.setAttribute('aria-label', `${playing ? 'Pause' : 'Play'} ${name}`);
    seek.max = String(Number.isFinite(audio.duration) ? audio.duration : 0);
    seek.value = String(audio.currentTime);
    seek.setAttribute('aria-valuetext', `${clock(audio.currentTime)} of ${clock(audio.duration)}`);
    time.textContent = `${clock(audio.currentTime)} / ${clock(audio.duration)}`;
  }

  // The browser's own controls stay for visitors without JavaScript; with it, ours take over.
  audio.controls = false;
  song.querySelector('.player-controls').hidden = false;

  play.addEventListener('click', () => {
    if (audio.paused || audio.ended) audio.play().catch(() => {});
    else audio.pause();
  });
  seek.addEventListener('input', () => {
    audio.currentTime = Number(seek.value);
  });
  audio.addEventListener('play', () => announce(song.querySelector('h3').textContent));
  for (const event of ['play', 'pause', 'ended', 'timeupdate', 'loadedmetadata', 'durationchange', 'seeked']) {
    audio.addEventListener(event, render);
  }
  audio.addEventListener('error', () => fallBackToSuno(song, name));
  // The MP3 may have failed before this module ran.
  if (audio.error) fallBackToSuno(song, name);
  else render();
}

document.querySelectorAll('.song[data-suno]').forEach(setUp);

// One at a time: whatever starts playing, a song or the music video, pauses all the others.
document.addEventListener('play', (event) => {
  for (const media of document.querySelectorAll('audio, video')) {
    if (media !== event.target) media.pause();
  }
}, true);
