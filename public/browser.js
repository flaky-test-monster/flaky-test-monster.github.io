// In-browser pipeline page: photo -> cut-out -> depth map -> relief STL, all on this device.
// The models run in browser-worker.js; nothing is uploaded and nothing is stored on a server.
import { mountViewer } from './viewer.js';

const COUNTDOWN_SECONDS = 3;
const STAGES = ['input', 'cutout', 'depth', 'stl'];
const ACCEPTED_TYPES = ['image/png', 'image/jpeg'];
const MB = 1024 * 1024;
const STAGE_HINTS = {
  loading: 'Loading the models…',
  input: 'Preparing the photo…',
  cutout: 'Removing the background…',
  depth: 'Estimating depth…',
  stl: 'Building the 3D model…',
};
const DEVICE_LABELS = { webgpu: 'WebGPU', wasm: 'WebAssembly (CPU, slower)' };

const $ = (id) => document.getElementById(id);
const state = { shape: 'relief', stream: null, blob: null, worker: null, urls: [], files: {}, downloads: new Map(), device: null, disposeViewer: null };

/** Reveals one step section with a fade and hides the rest. */
function showStep(name) {
  for (const step of document.querySelectorAll('.step')) {
    const active = step.dataset.step === name;
    step.hidden = !active;
    step.classList.toggle('is-visible', false);
    if (active) requestAnimationFrame(() => requestAnimationFrame(() => step.classList.add('is-visible')));
  }
}

/** Starts the webcam preview; hides the camera card when access is refused. */
async function startCamera() {
  if (state.stream) return;
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 } } });
    $('video').srcObject = state.stream;
  } catch {
    // Uploading still works: hide only the camera parts.
    $('camera-frame').hidden = true;
    $('take-photo').hidden = true;
    $('camera-error').hidden = false;
  }
}

/** Stops the webcam so the indicator light goes off. */
function stopCamera() {
  state.stream?.getTracks().forEach((track) => track.stop());
  state.stream = null;
}

/** Shows a 3-2-1 overlay on the video, then resolves. */
async function runCountdown() {
  const overlay = $('countdown');
  overlay.hidden = false;
  for (let n = COUNTDOWN_SECONDS; n > 0; n--) {
    overlay.textContent = n;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  overlay.hidden = true;
}

/** Grabs the current video frame as a PNG blob. */
function captureFrame() {
  const video = $('video');
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

/** Object URL that is revoked on the next start over. */
function objectUrl(blob) {
  const url = URL.createObjectURL(blob);
  state.urls.push(url);
  return url;
}

/** Moves to the confirm step with the chosen image. */
function chooseImage(blob) {
  if (!blob || !ACCEPTED_TYPES.includes(blob.type)) return;
  state.blob = blob;
  $('preview').src = objectUrl(blob);
  showStep('confirm');
}

/** The model worker, created once and kept so the loaded models are reused across runs. */
function getWorker() {
  if (!state.worker) {
    state.worker = new Worker(new URL('./browser-worker.js', import.meta.url), { type: 'module' });
    state.worker.addEventListener('message', (event) => handleMessage(event.data));
    state.worker.addEventListener('error', (event) => {
      showError(`The pipeline could not start: ${event.message || 'worker error'}`);
      state.worker = null;
    });
  }
  return state.worker;
}

/** Sends the photo and options to the worker. */
function startRun() {
  stopCamera();
  state.shape = $('shape').value;
  resetProgress();
  showStep('progress');
  getWorker().postMessage({
    blob: state.blob,
    options: { shape: state.shape, resolution: Number($('resolution').value) },
  });
}

/** Clears stepper, preview and error state. */
function resetProgress() {
  state.files = {};
  $('error').hidden = true;
  $('image-preview').hidden = true;
  $('progress-hint').hidden = false;
  $('progress-hint').textContent = 'Starting…';
  for (const li of document.querySelectorAll('#stepper li')) li.classList.remove('done', 'active');
  markStage('input', false);
}

/** Lights up the stepper: stages before `stage` are done, `stage` is done or active. */
function markStage(stage, done) {
  const index = STAGES.indexOf(stage);
  document.querySelectorAll('#stepper li').forEach((li, i) => {
    li.classList.toggle('done', i < index || (i === index && done));
    li.classList.toggle('active', (i === index && !done) || (done && i === index + 1));
  });
}

/** Shows a one-line error under the stepper. */
function showError(message) {
  $('error-text').textContent = message;
  $('error').hidden = false;
  $('progress-hint').hidden = true;
  document.querySelector('#stepper li.active')?.classList.remove('active');
}

/** Download progress summed over every model file seen so far. */
function downloadHint() {
  let loaded = 0, total = 0;
  for (const file of state.downloads.values()) { loaded += file.loaded; total += file.total; }
  return `Downloading the models (first run only): ${(loaded / MB).toFixed(0)} of ${(total / MB).toFixed(0)} MB`;
}

/** Reacts to progress, stage results, completion and errors from the worker. */
function handleMessage(message) {
  if (message.type === 'progress') {
    if (message.stage === 'download') {
      state.downloads.set(message.file, { loaded: message.loaded ?? 0, total: message.total ?? 0 });
      $('progress-hint').textContent = downloadHint();
      return;
    }
    if (message.device) state.device = message.device;
    if (STAGES.includes(message.stage)) markStage(message.stage, message.stage === 'input');
    $('progress-hint').textContent = STAGE_HINTS[message.stage] ?? '';
  } else if (message.type === 'stage') {
    state.files[message.stage] = message.file;
    if (message.stage === 'stl') state.triangles = message.triangles;
    markStage(message.stage, true);
    if (message.stage === 'cutout') {
      $('image-preview').src = objectUrl(message.file);
      $('image-preview').hidden = false;
    }
  } else if (message.type === 'done') {
    showResult();
  } else if (message.type === 'error') {
    showError(message.message);
  }
}

/** Shows every stage side by side, fills in download links and loads the 3D viewer. */
async function showResult() {
  const stlUrl = objectUrl(state.files.stl);
  $('stage-original').src = objectUrl(state.blob);
  $('stage-cutout').src = $('dl-cutout').href = objectUrl(state.files.cutout);
  $('stage-depth').src = $('dl-depth').href = objectUrl(state.files.depth);
  $('dl-stl').href = stlUrl;
  $('dl-final').hidden = true;
  const sizeMb = (state.files.stl.size / MB).toFixed(1);
  $('result-hint').textContent = `${state.triangles.toLocaleString()} triangles, ${sizeMb} MB, 100 mm tall. Ran on ${DEVICE_LABELS[state.device] ?? state.device}.`;
  $('dl-stl').download = `flakifier-${state.shape}.stl`;
  showStep('result');
  try {
    const { dispose, still } = await mountViewer($('viewer'), stlUrl);
    state.disposeViewer = dispose;
    $('dl-final').href = still;
    $('dl-final').hidden = false;
  } catch (err) {
    $('viewer').textContent = `Could not load 3D preview: ${err.message}`;
  }
}

/** Returns to the first step and clears everything except the loaded models. */
function startOver() {
  state.disposeViewer?.();
  state.urls.forEach((url) => URL.revokeObjectURL(url));
  Object.assign(state, { blob: null, urls: [], files: {}, disposeViewer: null });
  $('file-input').value = '';
  showStep('source');
  startCamera();
}

$('take-photo').addEventListener('click', async () => {
  $('take-photo').disabled = true;
  await runCountdown();
  chooseImage(await captureFrame());
  $('take-photo').disabled = false;
});
$('file-input').addEventListener('change', (event) => chooseImage(event.target.files[0]));
const uploadCard = $('camera-card');
uploadCard.addEventListener('dragover', (event) => { event.preventDefault(); uploadCard.classList.add('is-dragover'); });
uploadCard.addEventListener('dragleave', () => uploadCard.classList.remove('is-dragover'));
uploadCard.addEventListener('drop', (event) => {
  event.preventDefault();
  uploadCard.classList.remove('is-dragover');
  chooseImage(event.dataTransfer.files[0]);
});
$('retake').addEventListener('click', () => showStep('source'));
$('flakify').addEventListener('click', startRun);
$('try-again').addEventListener('click', (event) => { event.preventDefault(); startOver(); });
$('start-over').addEventListener('click', (event) => { event.preventDefault(); startOver(); });

showStep('source');
startCamera();
