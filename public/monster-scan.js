import { drawFaces, loadFaceTracker } from './monster-face.js';
import { smoothScore, trackFaces, verdict } from './monster-score.js';

const $ = (id) => document.getElementById(id);
/** Score where the webcam starts turning into a high-contrast poster. */
const POSTER_FROM = 40;

/** Bumped on every start and stop, so a scan loop can tell it has been replaced. */
let runId = 0;
let score = null;
/** @type {import('./monster-score.js').TrackedFace[]} */
let faces = [];
let monsterCount = 0;
let lastAnnouncement = null;

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
}

/** Stops the scan and says why, so a failure never leaves a frozen scan on screen. */
function failScan(err) {
  console.error('Monster scan failed:', err);
  stopMonsterScan();
  setStatus(`Monster scan failed: ${err.message}`);
}

/**
 * Starts scanning the webcam video, loading the face tracker on first use.
 * @param {HTMLVideoElement} video
 */
export async function startMonsterScan(video) {
  const id = ++runId;
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
  setCameraLook(null);
  drawFaces($('video'), []);
  setRunning(false);
}

/** Whether a scan is running. */
export function isMonsterScanning() {
  return $('scan-toggle').getAttribute('aria-pressed') === 'true';
}
