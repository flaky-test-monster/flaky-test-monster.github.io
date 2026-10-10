/**
 * The song players on the music page: a play and pause button and the time, for each song's
 * MP3. Only one song or the music video plays at a time.
 */

/** "1:05" for 65 seconds; "0:00" while the length is not known yet. */
function clock(seconds) {
  const whole = Number.isFinite(seconds) ? Math.floor(seconds) : 0;
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
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
  const time = song.querySelector('.song-time');
  const name = play.getAttribute('aria-label').replace(/^Play /, '');

  function render() {
    const playing = !audio.paused && !audio.ended;
    // The button draws a play or pause icon from the song's class; its label says which.
    song.classList.toggle('playing', playing);
    play.setAttribute('aria-label', `${playing ? 'Pause' : 'Play'} ${name}`);
    time.textContent = `${clock(audio.currentTime)} / ${clock(audio.duration)}`;
  }

  // The browser's own controls stay for visitors without JavaScript; with it, ours take over.
  audio.controls = false;
  song.querySelector('.player-controls').hidden = false;

  play.addEventListener('click', () => {
    if (audio.paused || audio.ended) audio.play().catch(() => {});
    else audio.pause();
  });
  audio.addEventListener('play', () => announce(song.querySelector('h3').textContent));
  for (const event of ['play', 'pause', 'ended', 'timeupdate', 'loadedmetadata', 'durationchange', 'seeked']) {
    audio.addEventListener(event, render);
  }
  audio.addEventListener('error', unavailable);
  // The MP3 may have failed before this module ran.
  if (audio.error) unavailable();
  else render();

  /** A song whose MP3 cannot be loaded says so, instead of a play button that does nothing. */
  function unavailable() {
    play.disabled = true;
    time.textContent = 'Not available';
  }
}

document.querySelectorAll('.song').forEach(setUp);

// One at a time: whatever starts playing, a song or the music video, pauses all the others.
document.addEventListener('play', (event) => {
  for (const media of document.querySelectorAll('audio, video')) {
    if (media !== event.target) media.pause();
  }
}, true);
