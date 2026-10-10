/**
 * The song players on the music page: play and pause, a position slider and the time, for
 * each song's MP3. Only one song or the music video plays at a time.
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
  const seek = song.querySelector('.song-seek');
  const time = song.querySelector('.song-time');
  const name = seek.getAttribute('aria-label').replace(/^Position in /, '');
  let dragging = false;

  function render() {
    const playing = !audio.paused && !audio.ended;
    const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
    // The button draws a play or pause icon from the song's class; its label says which.
    song.classList.toggle('playing', playing);
    play.setAttribute('aria-label', `${playing ? 'Pause' : 'Play'} ${name}`);
    seek.max = String(duration);
    // While someone drags the slider, the song's progress must not pull the thumb away from them.
    if (!dragging) seek.value = String(audio.currentTime);
    seek.style.setProperty('--progress', `${duration ? (audio.currentTime / duration) * 100 : 0}%`);
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
  seek.addEventListener('pointerdown', () => { dragging = true; });
  for (const event of ['pointerup', 'pointercancel']) {
    seek.addEventListener(event, () => { dragging = false; });
  }
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
    seek.disabled = true;
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
