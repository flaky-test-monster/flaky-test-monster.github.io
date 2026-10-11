/**
 * The music video on the music page, with its own controls: play and pause, stop, repeat
 * (on by default, so it plays round and round) and full screen.
 */

const $ = (id) => document.getElementById(id);
const video = $('music-video');

/** "1:05" for 65 seconds; "0:00" while the length is not known yet. */
function clock(seconds) {
  const whole = Number.isFinite(seconds) ? Math.floor(seconds) : 0;
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/** Brings the buttons and the time in line with the video. */
function render() {
  const playing = !video.paused && !video.ended;
  $('video-stage').classList.toggle('playing', playing);
  $('video-play').title = playing ? 'Pause' : 'Play';
  $('video-play').setAttribute('aria-label', playing ? 'Pause the video' : 'Play the video');
  $('video-stop').disabled = video.currentTime === 0 && !playing;
  $('video-repeat').setAttribute('aria-pressed', String(video.loop));
  $('video-time').textContent = `${clock(video.currentTime)} / ${clock(video.duration)}`;
}

function togglePlay() {
  if (video.paused || video.ended) video.play().catch(() => {});
  else video.pause();
}

/** Stops the video and goes back to its start. Stop is then disabled, so keyboard focus moves
 * on to Play instead of falling back to the top of the page. */
function stop() {
  const hadFocus = document.activeElement === $('video-stop');
  video.pause();
  video.currentTime = 0;
  render();
  if (hadFocus) $('video-play').focus();
}

/** Full screen for the video, or the iPhone's own video player where elements cannot go full screen. */
function fullscreen() {
  if (document.fullscreenElement === video) document.exitFullscreen();
  else if (video.requestFullscreen) video.requestFullscreen().catch(() => {});
  else video.webkitEnterFullscreen?.();
}

$('video-play').addEventListener('click', togglePlay);
$('video-stop').addEventListener('click', stop);
$('video-repeat').addEventListener('click', () => {
  video.loop = !video.loop;
  render();
});
$('video-fullscreen').addEventListener('click', fullscreen);
$('video-fullscreen').hidden = !(document.fullscreenEnabled || video.webkitEnterFullscreen);
// A click on the picture plays or pauses, like most players; in full screen the browser's own controls take over.
video.addEventListener('click', () => {
  if (document.fullscreenElement !== video) togglePlay();
});
for (const event of ['play', 'pause', 'ended', 'timeupdate', 'loadedmetadata', 'seeked']) video.addEventListener(event, render);
// Without this, a video that fails to load leaves a black box and buttons that do nothing.
video.addEventListener('error', () => {
  $('video-note').textContent = 'The video could not be loaded. Try again later.';
  for (const id of ['video-play', 'video-stop', 'video-fullscreen']) $(id).disabled = true;
});
render();
