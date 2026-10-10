import { drawFaces, loadFaceTracker, loadHandTracker, snapshotMonster, snapshotPreview } from './monster-face.js';
import { zip } from './zip.js';
import { isWaving, smoothScore, trackFaces, trackHands, verdict, WAVE_BONUS, WAVE_FROM } from './monster-score.js';

const $ = (id) => document.getElementById(id);
/** Score where the webcam starts turning into a high-contrast poster. */
const POSTER_FROM = 40;
/** How long the white flash over the preview takes to fade when a photo is taken. */
const FLASH_MS = 400;
/** The shutter sound: two short bursts of noise, the click and the clack, as [start, length] in seconds. */
const SHUTTER_CLICKS = [[0, 0.03], [0.07, 0.05]];
/** Least time between two photos while the score stays at 100. */
const PHOTO_EVERY_MS = 5000;
/** Photos kept to choose from; the oldest goes when another is taken. */
const PHOTO_LIMIT = 6;
/** Wait before a failed scan tries again; there is no button to restart it. */
const RETRY_MS = 5000;
/** How long the view must stay empty before the next human to step in counts as new, so a
    face the tracker loses for a few frames does not get the call to open the mouth twice. */
const EMPTY_BEFORE_NEW_MS = 2000;
/** Longest the call to open the mouth stays over the preview; it goes sooner once the human opens up. */
const CALL_MS = 5000;
/** What the score overlay asks for: no face in view, not a monster yet, a monster. */
const HINTS = {
  noFace: 'Please look into the camera.',
  human: 'Please open your eyes and mouth wide, like the monster.',
  monster: 'Thank you, you are a monster! Hold that face.',
  /** A monster with a mouth score above WAVE_FROM, not waving yet. */
  waveForBonus: `Hold that face and wave for ${WAVE_BONUS} bonus points!`,
  waving: `Wave bonus: +${WAVE_BONUS} points! Keep waving.`,
};

/** Bumped on every start and stop, so a scan loop can tell it has been replaced. */
let runId = 0;
let scanning = false;
let score = null;
/** @type {import('./monster-score.js').TrackedFace[]} */
let faces = [];
let monsterCount = 0;
/** Whether a monster earns the wave bonus in the current frame. */
let waving = false;
/** Loaded alongside the face tracker; null until then, or when it failed, and waves earn nothing. */
let handTracker = null;
/** @type {import('./monster-score.js').TrackedHand[]} */
let hands = [];
/** When the view last had no face in it, or null while someone is in view. */
let emptySince = null;
/** Whether the human who stepped in last has yet to get the call to open the mouth. */
let callDue = false;
/** Ends the call to open the mouth while it shows, or null when it does not. */
let callTimer = null;
let lastAnnouncement = null;
let lastPhotoAt = -Infinity;
/**
 * Monster photos, oldest first, shown as thumbnails beside the video. They stay across scans until the page reloads.
 * @type {{ blob: Blob, url: string, takenAt: Date, saving: boolean, saved: boolean }[]}
 */
const photos = [];
/** The photo shown in place of the video, or null for the live camera. */
/** @type {typeof photos[number] | null} */
let viewedPhoto = null;
/** Made when the page loads; browsers only let it play after the first click or tap. */
let audio = null;
/**
 * Saves the photo the user picked to the recent runs; resolves to whether it worked. Null
 * when there is no server to save to.
 * @type {((photo: Blob) => Promise<boolean>) | null}
 */
let savePhoto = async () => false;

/**
 * The webcam look for a score: harsher contrast as it rises, green poster once it is a monster.
 * @param {number | null} score running score, or null for the plain webcam
 */
function lookFor(score) {
  return {
    strength: score === null ? 0 : Math.min(1, Math.max(0, (score - POSTER_FROM) / (100 - POSTER_FROM))),
    green: score !== null && verdict(score).key === 'monster',
  };
}

/**
 * Styles the webcam by score.
 * @param {number | null} score running score, or null to show the plain webcam
 */
function setCameraLook(score) {
  const card = $('camera-card');
  const { strength, green } = lookFor(score);
  card.style.setProperty('--poster', strength.toFixed(2));
  card.classList.toggle('is-monster', green);
}

/**
 * Shows the score over the preview, with what to do next, or hides it when no scan has a score.
 * A human who steps in with a low score also gets a big call to open their mouth in the middle, once.
 * @param {number | null} shown rounded score
 */
function renderCameraScore(shown) {
  $('camera-score').hidden = shown === null;
  $('camera-big-score').hidden = !(shown > 100);
  if (shown === null) {
    endCall();
    return;
  }
  if (shown > 100) $('camera-big-score').textContent = shown;
  const result = verdict(shown);
  $('camera-score').dataset.verdict = result.key;
  $('camera-score-value').textContent = shown;
  $('camera-score-verdict').textContent = result.label;
  $('camera-score-bonus').hidden = !waving;
  $('camera-score-hint').textContent = hint(result.key);
}

/**
 * Shows the call to open the mouth once per human: from the first low score after they step
 * in, until no face in view is human any more or CALL_MS is up. Each face is judged on its own
 * score, so a human next to a monster still gets it. Hidden, but not ended, while no face is
 * in view, so a face the tracker loses for a few frames keeps its call.
 */
function renderCall() {
  const low = faces.some((face) => verdict(Math.round(face.score)).key === 'human');
  if (faces.length && !low) endCall();
  else if (callDue && low) {
    callDue = false;
    // A new human's call starts afresh, so the timer of an earlier one cannot cut it short.
    clearTimeout(callTimer);
    callTimer = setTimeout(endCall, CALL_MS);
  }
  $('camera-call').hidden = callTimer === null || !faces.length;
}

function endCall() {
  clearTimeout(callTimer);
  callTimer = null;
  $('camera-call').hidden = true;
}

/** What the score overlay asks for next, by the verdict of the top score. */
function hint(verdictKey) {
  if (!faces.length) return HINTS.noFace;
  if (waving) return HINTS.waving;
  if (handTracker && faces.some((face) => face.mouth > WAVE_FROM)) return HINTS.waveForBonus;
  return verdictKey === 'monster' ? HINTS.monster : HINTS.human;
}

/** "1 human", "2 monsters" and the like. */
const count = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/**
 * Shows how many humans and monsters are in view, or hides the count when no scan runs.
 * Every face that is not a monster yet counts as a human.
 * @param {boolean} shown
 */
function renderCounts(shown) {
  $('camera-counts').hidden = !shown;
  if (!shown) return;
  $('camera-humans').textContent = count(faces.length - monsterCount, 'human');
  $('camera-monsters').textContent = count(monsterCount, 'monster');
}

/**
 * Shows the running score, rounded, on the camera preview, and announces the verdict and how
 * many of the faces in view are monsters.
 */
function render() {
  const shown = Math.round(score);
  const result = verdict(shown);
  setCameraLook(shown);
  renderCameraScore(shown);
  renderCounts(true);
  // Announce only a change of verdict or count, not every new score.
  const announcement = `Verdict: ${result.label}${waving ? `, wave bonus +${WAVE_BONUS}` : ''}, ${count(faces.length - monsterCount, 'human')} and ${count(monsterCount, 'monster')} in view`;
  if (announcement !== lastAnnouncement) setStatus(announcement);
  lastAnnouncement = announcement;
}

function setStatus(message) {
  $('scan-status').textContent = message;
}

/**
 * Tracks the faces on every new video frame until stopped or replaced by another run. Each
 * face has its own score and only monster faces get the monster's eyes and tongue. The
 * highest face score is the score on the meter; with no face in view it falls to 0.
 */
function scanLoop(id, video, tracker) {
  let lastVideoTime = -1;
  const tick = () => {
    if (id !== runId) return;
    try {
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth && video.currentTime !== lastVideoTime) {
        lastVideoTime = video.currentTime;
        scanFrame(video, tracker);
      }
    } catch (err) {
      failScan(err, video);
      return;
    }
    requestAnimationFrame(tick);
  };
  tick();
}

/** Finds the faces in the current frame, updates their scores and paints the monsters. */
function scanFrame(video, tracker) {
  const now = performance.now();
  const aspect = video.videoWidth / video.videoHeight;
  const detected = tracker.detectForVideo(video, now).faceLandmarks;
  const previousShown = score === null ? null : Math.round(score);
  const previousCount = faces.length;
  const previousWaving = waving;
  // Hands only matter for the wave bonus, so they are only tracked while a face could earn it.
  hands = faces.some((face) => face.mouth > WAVE_FROM) ? trackHandsIn(video, aspect, now) : [];
  faces = trackFaces(faces, detected, aspect, hands.filter(isWaving).map((hand) => hand.palm));
  waving = faces.some((face) => face.waving);
  noticeNewcomer();
  // Judged on the rounded score, like the meter, so the tracker and the meter always agree.
  const monsters = faces.filter((face) => verdict(Math.round(face.score)).key === 'monster');
  score = faces.length ? Math.max(...faces.map((face) => face.score)) : smoothScore(score, 0);
  // Redraw the readout only when something visible changed, not on every frame.
  if (Math.round(score) !== previousShown || monsters.length !== monsterCount || faces.length !== previousCount || waving !== previousWaving) {
    monsterCount = monsters.length;
    render();
  }
  // Every frame, since a human's own score can change while the readout stays the same.
  renderCall();
  drawFaces(video, monsters.map((face) => face.landmarks));
  if (Math.round(score) >= 100 && now - lastPhotoAt >= PHOTO_EVERY_MS) takePhoto(video);
}

/**
 * Follows the hands in the current frame. A failing hand tracker is switched off rather than
 * stopping the scan: the score then simply has no wave bonus.
 */
function trackHandsIn(video, aspect, now) {
  if (!handTracker) return [];
  try {
    return trackHands(hands, handTracker.detectForVideo(video, now).landmarks, aspect, now);
  } catch (err) {
    console.warn('Hand tracking failed, no wave bonus:', err);
    handTracker = null;
    return [];
  }
}

/**
 * Lines up the call to open the mouth when a human steps into a view that has been empty for
 * a while. Short gaps, where the tracker loses a face for a few frames, do not count as empty.
 */
function noticeNewcomer() {
  const now = performance.now();
  if (!faces.length) {
    emptySince ??= now;
    return;
  }
  const wasEmpty = emptySince !== null && now - emptySince >= EMPTY_BEFORE_NEW_MS;
  emptySince = null;
  if (wasEmpty) callDue = true;
}

/**
 * Takes a monster photo and adds it to the thumbnails beside the video. It does not take
 * over the view: the camera, or the photo being looked at, stays.
 * @param {HTMLVideoElement} video
 */
async function takePhoto(video) {
  lastPhotoAt = performance.now();
  try {
    // Flash and click the moment the frame is captured, not once the PNG is encoded.
    const pending = snapshotMonster(video);
    flashCamera();
    playShutter();
    const blob = await pending;
    if (!blob) return;
    const photo = { blob, url: URL.createObjectURL(blob), takenAt: new Date(), saving: false, saved: false };
    photos.push(photo);
    if (photos.length > PHOTO_LIMIT) {
      const oldest = photos.shift();
      URL.revokeObjectURL(oldest.url);
      if (viewedPhoto === oldest) viewedPhoto = null;
    }
    renderPhotos();
    setStatus(`Monster photo ${photos.length} taken`);
  } catch (err) {
    // A missed photo is no reason to stop the scan; the next 100 tries again.
    console.warn('Monster photo failed:', err);
  }
}

/** The thumbnail button of a photo, by its place in the list. */
const thumbnail = (index) => $('scan-photo-strip').querySelectorAll('button')[index];

/**
 * Shows every photo as a thumbnail beside the video, and the one being looked at, if any,
 * in place of the video with its actions.
 */
function renderPhotos() {
  renderDownloadAll();
  $('scan-photo-strip').hidden = photos.length === 0;
  const time = (photo) => photo.takenAt.toLocaleTimeString();
  $('scan-photo-strip').replaceChildren(...photos.map((photo, i) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'scan-photo-choice';
    button.setAttribute('aria-pressed', String(photo === viewedPhoto));
    button.setAttribute('aria-label', `Show photo ${i + 1} of ${photos.length}, taken at ${time(photo)}${photo.saved ? ', saved' : ''}`);
    const img = document.createElement('img');
    img.src = photo.url;
    img.alt = '';
    button.append(img);
    button.addEventListener('click', () => viewPhoto(photo));
    const li = document.createElement('li');
    li.append(button);
    return li;
  }));

  $('camera-photo').hidden = !viewedPhoto;
  if (!viewedPhoto) return;
  $('camera-photo-img').src = viewedPhoto.url;
  $('camera-photo-img').alt = `Monster photo taken at ${time(viewedPhoto)}, with the monster look`;
  $('scan-photo-download').href = viewedPhoto.url;
  $('scan-photo-download').download = photoFileName(viewedPhoto);
  // Also off while a save is on its way, so a redraw in the meantime cannot allow a second save.
  $('scan-photo-keep').disabled = !savePhoto || viewedPhoto.saving || viewedPhoto.saved;
  $('scan-photo-keep').title = savePhoto ? '' : 'Saving needs the Flakifier server';
  $('scan-photo-keep').textContent = viewedPhoto.saved ? 'Saved to recent runs' : 'Save to recent runs';
}

/** The monster photos not saved to the recent runs, which are lost on reload. */
const unsavedPhotos = () => photos.filter((photo) => !photo.saved);

/** Offers the unsaved photos as one download, or hides the button when there are none. */
function renderDownloadAll() {
  const count = unsavedPhotos().length;
  $('scan-photos-download').hidden = count === 0;
  $('scan-photos-download').textContent = count === 1 ? 'Download the unsaved photo' : `Download ${count} unsaved photos`;
}

/** A file name for a photo by when it was taken, so several of them do not clash. */
function photoFileName(photo) {
  const pad = (n) => String(n).padStart(2, '0');
  const at = photo.takenAt;
  return `flaky-test-monster-${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}.png`;
}

/** Downloads every unsaved photo: one as a PNG, several in a ZIP file. */
async function downloadUnsaved() {
  const unsaved = unsavedPhotos();
  if (!unsaved.length) return;
  const single = unsaved.length === 1;
  // Off while the ZIP is packed, so a second click does not download it twice.
  $('scan-photos-download').disabled = true;
  let blob;
  try {
    blob = single ? unsaved[0].blob : await zip(unsaved.map((photo) => ({ name: photoFileName(photo), blob: photo.blob, date: photo.takenAt })));
  } finally {
    $('scan-photos-download').disabled = false;
  }
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = single ? photoFileName(unsaved[0]) : 'flaky-test-monsters.zip';
  link.click();
  // Long enough for the download to start; the photos themselves keep their own URLs.
  setTimeout(() => URL.revokeObjectURL(link.href), 10000);
  setStatus(single ? 'Downloading the unsaved photo' : `Downloading ${unsaved.length} unsaved photos as a ZIP file`);
}

/** Shows a photo in place of the video, or the same photo again to go back to the camera. */
function viewPhoto(photo) {
  if (photo === viewedPhoto) return backToCamera();
  viewedPhoto = photo;
  renderPhotos();
  $('camera-photo-back').focus();
}

/** Goes from a photo back to the live camera, with focus on that photo's thumbnail. */
function backToCamera() {
  const index = photos.indexOf(viewedPhoto);
  showLiveCamera();
  thumbnail(index)?.focus();
}

/** Shows the live camera again in place of a monster photo. */
export function showLiveCamera() {
  if (!viewedPhoto) return;
  viewedPhoto = null;
  renderPhotos();
}

/** Saves the photo being looked at to the recent runs, once. */
async function keepViewedPhoto() {
  const photo = viewedPhoto;
  if (!photo || !savePhoto || photo.saving || photo.saved) return;
  photo.saving = true;
  renderPhotos();
  photo.saved = await savePhoto(photo.blob);
  photo.saving = false;
  if (photo.saved) setStatus('Photo saved to recent runs');
  else setStatus('Saving the photo failed. Try again.');
  renderPhotos();
}

/**
 * Stops the scan and says why, so a failure never leaves a frozen scan on screen, then tries
 * again in a while, unless the camera has been stopped or the scan restarted since.
 */
function failScan(err, video) {
  console.error('Monster scan failed:', err);
  stopMonsterScan();
  const id = runId;
  setStatus(`Monster scan failed: ${err.message}. Trying again in a few seconds.`);
  setTimeout(() => {
    if (id === runId && video.srcObject?.active) startMonsterScan(video);
  }, RETRY_MS);
}

/** Flashes the preview white, unless the user asked for reduced motion. */
function flashCamera() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  $('camera-flash').animate([{ opacity: 0.9 }, { opacity: 0 }], { duration: FLASH_MS, easing: 'ease-out' });
}

/** Gets the sound ready; it only starts playing once the page has had a click or tap. */
function prepareShutter() {
  try {
    audio ??= new AudioContext();
    audio.resume();
  } catch {
    // No Web Audio: photos are taken silently.
  }
}

/** A camera shutter click, made from fading bursts of filtered noise. */
function playShutter() {
  if (audio?.state !== 'running') return;
  const now = audio.currentTime;
  for (const [start, length] of SHUTTER_CLICKS) {
    const buffer = audio.createBuffer(1, Math.ceil(audio.sampleRate * length), audio.sampleRate);
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) samples[i] = (Math.random() * 2 - 1) * (1 - i / samples.length) ** 3;
    const source = new AudioBufferSourceNode(audio, { buffer });
    const filter = new BiquadFilterNode(audio, { type: 'bandpass', frequency: 2500, Q: 0.8 });
    const gain = new GainNode(audio, { gain: 0.6 });
    source.connect(filter).connect(gain).connect(audio.destination);
    source.start(now + start);
  }
}

/**
 * Starts scanning the webcam video, loading the face tracker on first use. The scan is always
 * on while the camera is: a call while it runs does nothing.
 * @param {HTMLVideoElement} video
 */
export async function startMonsterScan(video) {
  if (scanning) return;
  const id = ++runId;
  scanning = true;
  prepareShutter();
  score = null;
  faces = [];
  monsterCount = 0;
  waving = false;
  hands = [];
  // Not awaited: the scan runs without the wave bonus until the hand tracker is there.
  loadHandTracker().then(
    (tracker) => { if (id === runId) handTracker = tracker; },
    (err) => console.warn('Hand tracker unavailable, no wave bonus:', err),
  );
  // An empty view to start with, so whoever is in front of the camera gets the call.
  emptySince = -Infinity;
  callDue = false;
  endCall();
  lastAnnouncement = null;
  setCameraLook(null);
  renderCameraScore(null);
  renderCounts(false);
  try {
    setStatus('Loading face tracker');
    const tracker = await loadFaceTracker();
    if (id !== runId) return;
    setStatus('Scanning');
    scanLoop(id, video, tracker);
  } catch (err) {
    if (id === runId) failScan(err, video);
  }
}

/** Stops scanning; the last result stays on screen but the webcam goes back to normal. */
export function stopMonsterScan() {
  runId += 1;
  scanning = false;
  setCameraLook(null);
  renderCameraScore(null);
  renderCounts(false);
  drawFaces($('video'), []);
}

/**
 * A photo of the webcam as the preview shows it, monster look and all, for Take photo.
 * @param {HTMLVideoElement} video
 * @returns {Promise<Blob | null>} a PNG
 */
export function takePreviewPhoto(video) {
  return snapshotPreview(video, lookFor(scanning && score !== null ? Math.round(score) : null));
}

/**
 * Sets how a photo the user picks is saved to the recent runs.
 * @param {((photo: Blob) => Promise<boolean>) | null} saver gets a PNG, resolves to whether it
 *   was saved; null disables saving
 */
export function onSaveMonsterPhoto(saver) {
  savePhoto = saver;
}

$('scan-photo-keep').addEventListener('click', keepViewedPhoto);
$('scan-photos-download').addEventListener('click', downloadUnsaved);
$('camera-photo-back').addEventListener('click', backToCamera);
$('camera-photo').addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !document.fullscreenElement) backToCamera();
});
// The scan starts on its own, without a click, so the shutter sound waits for the first click,
// tap or key press.
document.addEventListener('pointerdown', prepareShutter, { passive: true });
document.addEventListener('keydown', prepareShutter);
