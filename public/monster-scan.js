import { drawFaces, loadFaceTracker, snapshotMonster } from './monster-face.js';
import { smoothScore, trackFaces, verdict } from './monster-score.js';

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

/** Bumped on every start and stop, so a scan loop can tell it has been replaced. */
let runId = 0;
let scanning = false;
let score = null;
/** @type {import('./monster-score.js').TrackedFace[]} */
let faces = [];
let monsterCount = 0;
let lastAnnouncement = null;
let lastPhotoAt = -Infinity;
/**
 * Monster photos to choose from, oldest first. They stay across scans until the page reloads.
 * @type {{ blob: Blob, url: string, takenAt: Date, saving: boolean, saved: boolean }[]}
 */
const photos = [];
/** @type {typeof photos[number] | null} */
let selectedPhoto = null;
/** Made on the click that starts a scan, since browsers only allow sound after a user gesture. */
let audio = null;
/**
 * Saves the photo the user picked to the recent runs; resolves to whether it worked.
 * @type {(photo: Blob) => Promise<boolean>}
 */
/** @type {((photo: Blob) => Promise<boolean>) | null} null when there is no server to save to */
let savePhoto = async () => false;

/**
 * Styles the webcam by score: harsher contrast as it rises, green poster once it is a
 * monster.
 * @param {number | null} score running score, or null to show the plain webcam
 */
function setCameraLook(score) {
  const card = $('camera-card');
  const strength = score === null ? 0 : Math.min(1, Math.max(0, (score - POSTER_FROM) / (100 - POSTER_FROM)));
  card.style.setProperty('--poster', strength.toFixed(2));
  card.classList.toggle('is-monster', score !== null && verdict(score).key === 'monster');
}

/**
 * Shows the score over the full screen preview, or hides it when no scan has a score.
 * @param {number | null} shown rounded score
 */
function renderCameraScore(shown) {
  $('camera-score').hidden = shown === null;
  if (shown === null) return;
  const result = verdict(shown);
  $('camera-score').dataset.verdict = result.key;
  $('camera-score-value').textContent = shown;
  $('camera-score-verdict').textContent = result.label;
  $('camera-score-monsters').textContent = `${monsterCount} ${monsterCount === 1 ? 'monster' : 'monsters'} in view`;
}

/** Shows how many of the faces in view are monsters. */
function renderTracker() {
  $('scan-monsters').textContent = monsterCount;
  $('scan-monsters-label').textContent = monsterCount === 1 ? 'monster' : 'monsters';
  $('scan-faces').textContent = faces.length;
  $('scan-faces-label').textContent = faces.length === 1 ? 'face' : 'faces';
  $('scan-tracker').dataset.monsters = String(monsterCount > 0);
}

/**
 * Shows the running score, rounded, on the meter and how many of the faces in view are
 * monsters.
 */
function render() {
  const shown = Math.round(score);
  const result = verdict(shown);
  $('scan-score').textContent = shown;
  $('scan-meter').setAttribute('aria-valuenow', shown);
  $('scan-meter').setAttribute('aria-valuetext', `${shown} out of 100, ${result.label}`);
  $('scan-meter').style.setProperty('--score', shown);
  $('scan-panel').dataset.verdict = result.key;
  $('scan-verdict').textContent = result.label;
  setCameraLook(shown);
  renderCameraScore(shown);
  renderTracker();
  // Announce only a change of verdict or count, not every new score.
  const announcement = `Verdict: ${result.label}, ${monsterCount} of ${faces.length} in view are monsters`;
  if (announcement !== lastAnnouncement) setStatus(announcement);
  lastAnnouncement = announcement;
}

function setStatus(message) {
  $('scan-status').textContent = message;
}

function setRunning(running) {
  $('scan-toggle').textContent = running ? 'Stop monster scan' : 'Monster scan';
  $('scan-toggle').setAttribute('aria-pressed', String(running));
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
      failScan(err);
      return;
    }
    requestAnimationFrame(tick);
  };
  tick();
}

/** Finds the faces in the current frame, updates their scores and paints the monsters. */
function scanFrame(video, tracker) {
  const detected = tracker.detectForVideo(video, performance.now()).faceLandmarks;
  const previousShown = score === null ? null : Math.round(score);
  const previousCount = faces.length;
  faces = trackFaces(faces, detected, video.videoWidth / video.videoHeight);
  // Judged on the rounded score, like the meter, so the tracker and the meter always agree.
  const monsters = faces.filter((face) => verdict(Math.round(face.score)).key === 'monster');
  score = faces.length ? Math.max(...faces.map((face) => face.score)) : smoothScore(score, 0);
  // Redraw the readout only when something visible changed, not on every frame.
  if (Math.round(score) !== previousShown || monsters.length !== monsterCount || faces.length !== previousCount) {
    monsterCount = monsters.length;
    render();
  }
  drawFaces(video, monsters.map((face) => face.landmarks));
  if (Math.round(score) === 100 && performance.now() - lastPhotoAt >= PHOTO_EVERY_MS) takePhoto(video);
}

/**
 * Takes a monster photo and adds it to the ones to choose from. The newest is selected,
 * unless the user has picked an older one to look at.
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
    const followNewest = selectedPhoto === null || selectedPhoto === photos.at(-1);
    const photo = { blob, url: URL.createObjectURL(blob), takenAt: new Date(), saving: false, saved: false };
    photos.push(photo);
    if (photos.length > PHOTO_LIMIT) {
      const oldest = photos.shift();
      URL.revokeObjectURL(oldest.url);
      if (selectedPhoto === oldest) selectedPhoto = null;
    }
    if (followNewest || selectedPhoto === null) selectedPhoto = photo;
    renderPhotos();
    setStatus(`Monster photo ${photos.length} taken`);
  } catch (err) {
    // A missed photo is no reason to stop the scan; the next 100 tries again.
    console.warn('Monster photo failed:', err);
  }
}

/** Shows the selected photo large and every photo as a thumbnail to pick from. */
function renderPhotos() {
  $('scan-photo').hidden = photos.length === 0;
  if (!selectedPhoto) return;
  const time = (photo) => photo.takenAt.toLocaleTimeString();
  $('scan-photo-img').src = selectedPhoto.url;
  $('scan-photo-img').alt = `Monster photo taken at ${time(selectedPhoto)}, with the monster look`;
  $('scan-photo-download').href = selectedPhoto.url;
  // Also off while a save is on its way, so a redraw in the meantime cannot allow a second save.
  $('scan-photo-keep').disabled = !savePhoto || selectedPhoto.saving || selectedPhoto.saved;
  $('scan-photo-keep').title = savePhoto ? '' : 'Saving needs the Flakifier server';
  $('scan-photo-keep').textContent = selectedPhoto.saved ? 'Saved to recent runs' : 'Save to recent runs';
  $('scan-photo-strip').replaceChildren(...photos.map((photo, i) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'scan-photo-choice';
    button.setAttribute('aria-pressed', String(photo === selectedPhoto));
    button.setAttribute('aria-label', `Photo ${i + 1} of ${photos.length}, taken at ${time(photo)}${photo.saved ? ', saved' : ''}`);
    const img = document.createElement('img');
    img.src = photo.url;
    img.alt = '';
    button.append(img);
    button.addEventListener('click', () => {
      selectedPhoto = photo;
      renderPhotos();
    });
    const li = document.createElement('li');
    li.append(button);
    return li;
  }));
}

/** Saves the selected photo to the recent runs, once. */
async function keepSelectedPhoto() {
  const photo = selectedPhoto;
  if (!photo || !savePhoto || photo.saving || photo.saved) return;
  photo.saving = true;
  renderPhotos();
  photo.saved = await savePhoto(photo.blob);
  photo.saving = false;
  if (photo.saved) setStatus('Photo saved to recent runs');
  else setStatus('Saving the photo failed. Try again.');
  renderPhotos();
}

/** Stops the scan and says why, so a failure never leaves a frozen scan on screen. */
function failScan(err) {
  console.error('Monster scan failed:', err);
  stopMonsterScan();
  setStatus(`Monster scan failed: ${err.message}`);
}

/** Flashes the preview white, unless the user asked for reduced motion. */
function flashCamera() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  $('camera-flash').animate([{ opacity: 0.9 }, { opacity: 0 }], { duration: FLASH_MS, easing: 'ease-out' });
}

/** Gets the sound ready; call from the click that starts a scan. */
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
 * Starts scanning the webcam video, loading the face tracker on first use.
 * @param {HTMLVideoElement} video
 */
async function startMonsterScan(video) {
  const id = ++runId;
  scanning = true;
  prepareShutter();
  score = null;
  faces = [];
  monsterCount = 0;
  lastAnnouncement = null;
  $('scan-panel').hidden = false;
  $('scan-panel').removeAttribute('data-verdict');
  $('scan-score').textContent = '--';
  $('scan-verdict').textContent = 'scanning';
  $('scan-meter').style.setProperty('--score', 0);
  $('scan-meter').removeAttribute('aria-valuenow');
  renderTracker();
  setCameraLook(null);
  renderCameraScore(null);
  setRunning(true);
  try {
    setStatus('Loading face tracker');
    const tracker = await loadFaceTracker();
    if (id !== runId) return;
    setStatus('Scanning');
    scanLoop(id, video, tracker);
  } catch (err) {
    if (id === runId) failScan(err);
  }
}

/** Stops scanning; the last result stays on screen but the webcam goes back to normal. */
export function stopMonsterScan() {
  runId += 1;
  scanning = false;
  setCameraLook(null);
  renderCameraScore(null);
  drawFaces($('video'), []);
  setRunning(false);
}

/**
 * Starts a scan of the webcam video, or stops the one that is running.
 * @param {HTMLVideoElement} video
 */
export function toggleMonsterScan(video) {
  if (scanning) stopMonsterScan();
  else startMonsterScan(video);
}

/**
 * Sets how a photo the user picks is saved to the recent runs.
 * @param {((photo: Blob) => Promise<boolean>) | null} saver gets a PNG, resolves to whether it
 *   was saved; null disables saving
 */
export function onSaveMonsterPhoto(saver) {
  savePhoto = saver;
}

$('scan-photo-keep').addEventListener('click', keepSelectedPhoto);
