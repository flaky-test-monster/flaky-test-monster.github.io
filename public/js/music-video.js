/**
 * The music video on the music page, with its own controls: play and pause, stop, repeat
 * (on by default, so it plays round and round), the lyrics and full screen. The lyrics come
 * from the video's text track (a WebVTT file, one cue per line) and are drawn over the
 * video like classic karaoke: the line being sung lit up a touch early, the next line dim under
 * it rolling up when its turn comes, and no lyrics while the music plays alone. On the iPhone,
 * where only the browser's own player goes full screen, that player shows them as subtitles.
 */

const $ = (id) => document.getElementById(id);
const video = $('music-video');
const stage = $('video-stage');
const lyrics = $('video-lyrics');
const track = video.querySelector('track')?.track;
/** A line shows this long before it is sung, and stays this long after; longer pauses, the
 * intro and the break between the verses, have no lyrics. It lights up EARLY before it starts. */
const LEAD = 2;
const LINGER = 1;
const EARLY = 0.3;
/** The three lines of the panel, by their place: the line being sung, the next one, and the
 * spare one off the panel, which is the one sung before and becomes the next one after. */
const slots = [...lyrics.querySelectorAll('.lyrics-line:not(.lyrics-sizer)')];
/** The hidden line that gives the panel its width: the longest line of the song. */
const sizer = lyrics.querySelector('.lyrics-sizer');
/** The cues in the first two slots, so the panel only changes when the line does. */
let shown = [null, null];
let frame = 0;

/** Brings the buttons in line with the video. */
function render() {
  const playing = !video.paused && !video.ended;
  stage.classList.toggle('playing', playing);
  const action = playing ? 'Pause' : 'Play';
  $('video-play').title = action;
  $('video-play').setAttribute('aria-label', `${action} the video`);
  $('video-stop').disabled = video.currentTime === 0 && !playing;
  $('video-repeat').setAttribute('aria-pressed', String(video.loop));
  renderLyrics();
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

/** Full screen for the whole stage, so the lyrics and the controls stay over the video; or the
 * iPhone's own video player, where elements cannot go full screen. */
function fullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else if (stage.requestFullscreen) stage.requestFullscreen().catch(() => {});
  else video.webkitEnterFullscreen?.();
}

/** Whether the lyrics are wanted (the Lyrics button). */
function lyricsOn() {
  return $('video-lyrics-toggle').getAttribute('aria-pressed') === 'true';
}

/** Draws the line being sung, lit up a touch before it starts, and the next line dim under it.
 * Just before a line it waits dim; just after one it stays, lit. Otherwise the panel fades out
 * and keeps its lines meanwhile. Nothing shows while the video stands at its start. */
function renderLyrics() {
  const cues = track?.cues;
  if (!cues || !lyricsOn() || (video.paused && video.currentTime === 0)) {
    lyrics.hidden = true;
    lyrics.classList.toggle('visible', false);
    return;
  }
  lyrics.hidden = false;
  const now = video.currentTime;
  const all = [...cues];
  if (!sizer.textContent) sizer.textContent = all.map((cue) => cue.text).sort((a, b) => b.length - a.length)[0] ?? '';
  const active = all.find((cue) => cue.startTime <= now && now < cue.endTime);
  const prev = all.filter((cue) => cue.endTime <= now).pop();
  const next = all.find((cue) => cue.startTime > now);
  let cue = active;
  if (!cue && next && next.startTime - now <= LEAD) cue = next;
  if (!cue && prev && now - prev.endTime <= LINGER) cue = prev;
  const visible = lyrics.classList.contains('visible');
  lyrics.classList.toggle('visible', Boolean(cue));
  if (!cue) return;
  const following = all[all.indexOf(cue) + 1] ?? null;
  if (cue !== shown[0]) {
    if (visible && cue === shown[1]) roll();
    else place();
    setLine(slots[0], cue);
    setLine(slots[1], following);
    shown = [cue, following];
  }
  slots[0].classList.toggle('lit', cue.startTime - now <= EARLY);
}

/** The next line rolls up into the sung line's place, that one out above, and the spare line in
 * from below as the new next one. The spare first jumps below without a transition. */
function roll() {
  const [sung, next, spare] = slots;
  spare.classList.add('jump');
  setSlot(spare, 2, 0);
  void spare.offsetHeight;
  spare.classList.remove('jump');
  setSlot(sung, -1, 0);
  setSlot(next, 0, 1);
  setSlot(spare, 1, 1);
  slots.splice(0, 3, next, spare, sung);
}

/** The lines in their places at once, with no roll: a new section, a seek or the first line. */
function place() {
  for (const line of slots) line.classList.add('jump');
  setSlot(slots[0], 0, 1);
  setSlot(slots[1], 1, 1);
  setSlot(slots[2], 2, 0);
  void lyrics.offsetHeight;
  for (const line of slots) line.classList.remove('jump');
}

function setSlot(line, slot, shown) {
  line.style.setProperty('--slot', slot);
  line.style.setProperty('--shown', shown);
}

/** Puts a cue's words in a line, dim, or empties it: after the last line there is no next one. */
function setLine(line, cue) {
  line.textContent = cue?.text ?? '';
  line.classList.remove('lit');
}

/** The lines light up on the frame; timeupdate alone comes a few times a second. */
function animate() {
  renderLyrics();
  frame = video.paused || video.ended ? 0 : requestAnimationFrame(animate);
}

/** Our own lyrics on the page ('hidden' loads the cues without showing them), the browser's
 * subtitles in the iPhone's player, none when the lyrics are off. */
function setTrackMode() {
  if (!track) return;
  const native = video.webkitDisplayingFullscreen;
  track.mode = !lyricsOn() ? 'disabled' : native ? 'showing' : 'hidden';
  renderLyrics();
}

$('video-play').addEventListener('click', togglePlay);
$('video-stop').addEventListener('click', stop);
$('video-repeat').addEventListener('click', () => {
  video.loop = !video.loop;
  render();
});
$('video-fullscreen').addEventListener('click', fullscreen);
$('video-fullscreen').hidden = !(document.fullscreenEnabled || video.webkitEnterFullscreen);
// A click on the picture plays or pauses, like most players.
video.addEventListener('click', togglePlay);
for (const event of ['play', 'pause', 'ended', 'timeupdate', 'loadedmetadata', 'seeked']) video.addEventListener(event, render);
// Without this, a video that fails to load leaves a black box and buttons that do nothing.
video.addEventListener('error', () => {
  $('video-note').textContent = 'The video could not be loaded. Try again later.';
  for (const id of ['video-play', 'video-stop', 'video-fullscreen', 'video-lyrics-toggle']) $(id).disabled = true;
});

// The lyrics: only with a text track, which the page always has; the button stays hidden
// otherwise, and the browser shows nothing either.
if (track) {
  const toggle = $('video-lyrics-toggle');
  toggle.hidden = false;
  toggle.addEventListener('click', () => {
    toggle.setAttribute('aria-pressed', String(!lyricsOn()));
    toggle.title = lyricsOn() ? 'Hide the lyrics' : 'Show the lyrics';
    setTrackMode();
  });
  track.addEventListener('cuechange', renderLyrics);
  // A cue file that cannot be loaded leaves nothing to show: the button goes too.
  video.querySelector('track').addEventListener('error', () => {
    toggle.hidden = true;
  });
  video.addEventListener('play', () => {
    if (!frame) frame = requestAnimationFrame(animate);
  });
  for (const event of ['webkitbeginfullscreen', 'webkitendfullscreen']) video.addEventListener(event, setTrackMode);
  setTrackMode();
}
render();
