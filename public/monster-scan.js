import { loadDetector } from './monster-detector.js';
import { TRAITS, monsterScore, smoothScore, verdict } from './monster-score.js';

/** Side of the square frame the model looks at; small keeps scans quick. */
const FRAME_SIZE = 384;
/** Rest between scans so the page stays responsive. */
const SCAN_PAUSE_MS = 300;
const VIDEO_WAIT_MS = 200;

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Loaded once per page, on the first scan, since the model download is large. */
let detectorPromise = null;
/** Bumped on every start and stop, so a scan loop can tell it has been replaced. */
let runId = 0;
let scanning = false;
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

/** One line per trait with its points; lit when the model saw it. */
function renderTraitList() {
  $('scan-traits').replaceChildren(...TRAITS.map(({ key, label, points }) => {
    const li = document.createElement('li');
    li.dataset.trait = key;
    li.dataset.seen = 'false';
    const name = document.createElement('span');
    name.textContent = label;
    const seen = document.createElement('span');
    seen.className = 'scan-seen visually-hidden';
    const value = document.createElement('span');
    value.className = 'scan-points';
    value.textContent = points > 0 ? `+${points}` : `−${-points}`;
    li.append(name, seen, value);
    return li;
  }));
}

/**
 * Shows the newest scan: the running score on the meter and which traits were seen.
 * @param {import('./monster-score.js').Traits} traits
 */
function render(traits) {
  const result = verdict(score);
  $('scan-score').textContent = score;
  $('scan-meter').setAttribute('aria-valuenow', score);
  $('scan-meter').setAttribute('aria-valuetext', `${score} out of 100, ${result.label}`);
  $('scan-meter').style.setProperty('--score', score);
  $('scan-panel').dataset.verdict = result.key;
  $('scan-verdict').textContent = result.label;
  for (const li of $('scan-traits').children) {
    const seen = traits[li.dataset.trait];
    li.dataset.seen = String(seen);
    li.querySelector('.scan-seen').textContent = seen ? ': yes' : ': no';
  }
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
    // Wait for the first frame, and rest while the tab is in the background.
    if (document.hidden || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      await sleep(VIDEO_WAIT_MS);
      continue;
    }
    const traits = await detector.detect(grabFrame(video, canvas));
    if (id !== runId) return;
    score = smoothScore(score, monsterScore(traits));
    render(traits);
    await sleep(SCAN_PAUSE_MS);
  }
}

/**
 * Loads the model once per page; a failed load is forgotten so the next scan retries.
 * @returns {Promise<import('./monster-detector.js').Detector>}
 */
function getDetector() {
  detectorPromise ??= loadDetector(setStatus).catch((err) => {
    detectorPromise = null;
    throw err;
  });
  return detectorPromise;
}

/**
 * Starts scanning the webcam video, loading the model on first use.
 * @param {HTMLVideoElement} video
 */
async function startMonsterScan(video) {
  const id = ++runId;
  scanning = true;
  score = null;
  lastVerdict = null;
  $('scan-panel').hidden = false;
  $('scan-panel').removeAttribute('data-verdict');
  $('scan-score').textContent = '--';
  $('scan-verdict').textContent = 'scanning';
  $('scan-meter').style.setProperty('--score', 0);
  $('scan-meter').removeAttribute('aria-valuenow');
  renderTraitList();
  setRunning(true);
  try {
    const detector = await getDetector();
    if (id !== runId) return;
    $('scan-model').textContent = detector.name;
    setStatus('Scanning');
    await scanLoop(id, video, detector);
  } catch (err) {
    if (id !== runId) return;
    console.error('Monster scan failed:', err);
    stopMonsterScan();
    setStatus(`Monster scan failed: ${err.message}`);
  }
}

/** Stops scanning; the last result stays on screen. */
export function stopMonsterScan() {
  runId += 1;
  scanning = false;
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
