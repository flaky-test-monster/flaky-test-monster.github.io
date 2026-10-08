import { loadDetector } from './monster-detector.js';
import { monsterScore, smoothScore, verdict } from './monster-score.js';

/** Side of the square frame the model looks at; small keeps scans quick. */
const FRAME_SIZE = 384;
/** Rest between scans so the page stays responsive. */
const SCAN_PAUSE_MS = 300;
const VIDEO_WAIT_MS = 200;

const $ = (id) => document.getElementById(id);
/** Score where the webcam starts turning into a high-contrast poster. */
const POSTER_FROM = 40;

/**
 * Styles the webcam by score: harsher contrast as it rises, green poster once it is a monster.
 * @param {number | null} score running score, or null to show the plain webcam
 */
function setCameraLook(score) {
  const card = $('camera-card');
  const strength = score === null ? 0 : Math.min(1, Math.max(0, (score - POSTER_FROM) / (100 - POSTER_FROM)));
  card.style.setProperty('--poster', strength.toFixed(2));
  card.classList.toggle('is-monster', score !== null && verdict(score).key === 'monster');
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Loaded once per page, on the first scan, since the model download is large. */
let detectorPromise = null;
/** Bumped on every start and stop, so a scan loop can tell it has been replaced. */
let runId = 0;
let score = null;
let lastVerdict = null;

/**
 * Draws the middle square of the video into a small canvas for the model.
 * @param {HTMLVideoElement} video
 * @param {HTMLCanvasElement} canvas
 */
function grabFrame(video, canvas) {
  const side = Math.min(video.videoWidth, video.videoHeight);
  canvas.getContext('2d').drawImage(video, (video.videoWidth - side) / 2, (video.videoHeight - side) / 2, side, side, 0, 0, FRAME_SIZE, FRAME_SIZE);
  return canvas;
}

/**
 * Shows the running score on the meter.
 */
function render() {
  const result = verdict(score);
  $('scan-score').textContent = score;
  $('scan-meter').setAttribute('aria-valuenow', score);
  $('scan-meter').setAttribute('aria-valuetext', `${score} out of 100, ${result.label}`);
  $('scan-meter').style.setProperty('--score', score);
  $('scan-panel').dataset.verdict = result.key;
  $('scan-verdict').textContent = result.label;
  setCameraLook(score);
  // Announce only a change of verdict, not every new score.
  if (result.key !== lastVerdict) setStatus(`Verdict: ${result.label}`);
  lastVerdict = result.key;
}

function setStatus(message) {
  $('scan-status').textContent = message;
}

function setRunning(running) {
  $('scan-toggle').textContent = running ? 'Stop monster scan' : 'Monster scan';
  $('scan-toggle').setAttribute('aria-pressed', String(running));
}

/** Scans frame after frame until stopped or replaced by another run. */
async function scanLoop(id, video, detector) {
  const canvas = Object.assign(document.createElement('canvas'), { width: FRAME_SIZE, height: FRAME_SIZE });
  while (id === runId) {
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth) {
      await sleep(VIDEO_WAIT_MS);
      continue;
    }
    const traits = await detector.detect(grabFrame(video, canvas));
    if (id !== runId) return;
    score = smoothScore(score, monsterScore(traits));
    render();
    await sleep(SCAN_PAUSE_MS);
  }
}

/**
 * Starts scanning the webcam video, loading the model on first use.
 * @param {HTMLVideoElement} video
 */
export async function startMonsterScan(video) {
  const id = ++runId;
  score = null;
  lastVerdict = null;
  $('scan-panel').hidden = false;
  $('scan-panel').removeAttribute('data-verdict');
  $('scan-score').textContent = '--';
  $('scan-verdict').textContent = 'scanning';
  $('scan-meter').style.setProperty('--score', 0);
  $('scan-meter').removeAttribute('aria-valuenow');
  setCameraLook(null);
  setRunning(true);
  try {
    detectorPromise ??= loadDetector((message) => { if (id === runId) setStatus(message); });
    const detector = await detectorPromise;
    if (id !== runId) return;
    $('scan-model').textContent = detector.name;
    setStatus('Scanning');
    await scanLoop(id, video, detector);
  } catch (err) {
    // A failed download should not stick: the next attempt loads again.
    detectorPromise = null;
    if (id !== runId) return;
    console.error('Monster scan failed:', err);
    stopMonsterScan();
    setStatus(`Monster scan failed: ${err.message}`);
  }
}

/** Stops scanning; the last result stays on screen but the webcam goes back to normal. */
export function stopMonsterScan() {
  runId += 1;
  setCameraLook(null);
  setRunning(false);
}

/** Whether a scan is running. */
export function isMonsterScanning() {
  return $('scan-toggle').getAttribute('aria-pressed') === 'true';
}
