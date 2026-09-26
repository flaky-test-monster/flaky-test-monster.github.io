import { mountViewer } from './viewer.js';

const COUNTDOWN_SECONDS = 3;
const POLL_INTERVAL_MS = 2000;
const POLL_MAX_RETRIES = 5;
const POLL_BACKOFF_MAX_MS = 30000;
const STAGES = ['input', 'statue', 'glb', 'stl'];
const ACCEPTED_TYPES = ['image/png', 'image/jpeg'];

const $ = (id) => document.getElementById(id);
const state = { stream: null, blob: null, jobId: null, pollTimer: null, pollFailures: 0, disposeViewer: null };

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
    $('camera-card').hidden = true;
    document.querySelector('.cards').classList.add('single');
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

/** Moves to the confirm step with the chosen image. */
function chooseImage(blob) {
  if (!blob || !ACCEPTED_TYPES.includes(blob.type)) return;
  state.blob = blob;
  $('preview').src = URL.createObjectURL(blob);
  showStep('confirm');
}

/** Uploads the image, creates a job and starts polling. */
async function startJob() {
  $('flakify').disabled = true;
  try {
    const res = await fetch('/api/jobs', { method: 'POST', headers: { 'Content-Type': state.blob.type }, body: state.blob });
    if (!res.ok) throw new Error((await res.json()).error ?? `Upload failed (${res.status})`);
    state.jobId = (await res.json()).id;
    stopCamera();
    resetProgress();
    showStep('progress');
    poll();
  } catch (err) {
    resetProgress();
    showStep('progress');
    showError(err.message);
  } finally {
    $('flakify').disabled = false;
  }
}

/** Clears stepper, preview and error state. */
function resetProgress() {
  clearTimeout(state.pollTimer);
  state.pollFailures = 0;
  $('error').hidden = true;
  $('statue-preview').hidden = true;
  $('progress-hint').hidden = false;
  for (const li of document.querySelectorAll('#stepper li')) li.classList.remove('done', 'active');
}

/** Shows a one-line error under the stepper. */
function showError(message) {
  $('error-text').textContent = message;
  $('error').hidden = false;
  $('progress-hint').hidden = true;
  document.querySelector('#stepper li.active')?.classList.remove('active');
}

/** Lights up the stepper according to which files exist. */
function renderStages(stages) {
  let nextPending = true;
  for (const li of document.querySelectorAll('#stepper li')) {
    const done = Boolean(stages[li.dataset.stage]);
    li.classList.toggle('done', done);
    li.classList.toggle('active', !done && nextPending);
    if (!done) nextPending = false;
  }
  if (stages.statue && $('statue-preview').hidden) {
    $('statue-preview').src = `/api/jobs/${state.jobId}/statue.png`;
    $('statue-preview').hidden = false;
  }
}

/** Delay before the next poll: normal interval, or exponential backoff after failures. */
function nextPollDelay(failures) {
  return Math.min(POLL_INTERVAL_MS * 2 ** failures, POLL_BACKOFF_MAX_MS);
}

/**
 * Polls the job until every stage exists or the server reports an error. A transient
 * network or 5xx failure is retried with bounded backoff; only a 404 or exhausting the
 * retries is treated as terminal, since the server-side job keeps running regardless.
 */
async function poll() {
  try {
    const res = await fetch(`/api/jobs/${state.jobId}`);
    if (res.status === 404) return showError('Job not found');
    if (!res.ok) throw new Error(`Status check failed (${res.status})`);
    const { stages, error } = await res.json();
    state.pollFailures = 0;
    renderStages(stages);
    if (error) return showError(error);
    if (STAGES.every((stage) => stages[stage])) return showResult(stages);
    state.pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
  } catch (err) {
    state.pollFailures += 1;
    if (state.pollFailures > POLL_MAX_RETRIES) return showError(`Lost contact with the server: ${err.message}`);
    state.pollTimer = setTimeout(poll, nextPollDelay(state.pollFailures));
  }
}

/** Fills in download links and loads the 3D viewer. */
async function showResult(stages) {
  const file = (name) => `/api/jobs/${state.jobId}/${name}?download=1`;
  $('dl-stl').href = file('model.stl');
  $('dl-glb').href = file('model.glb');
  $('dl-statue').href = file('statue.png');
  $('dl-original').href = file(stages.input);
  showStep('result');
  try {
    state.disposeViewer = await mountViewer($('viewer'), `/api/jobs/${state.jobId}/model.glb`);
  } catch (err) {
    $('viewer').textContent = `Could not load 3D preview: ${err.message}`;
  }
}

/** Returns to the first step and clears everything. */
function startOver() {
  clearTimeout(state.pollTimer);
  state.disposeViewer?.();
  Object.assign(state, { blob: null, jobId: null, pollTimer: null, pollFailures: 0, disposeViewer: null });
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
const uploadCard = $('upload-card');
uploadCard.addEventListener('dragover', (event) => { event.preventDefault(); uploadCard.classList.add('is-dragover'); });
uploadCard.addEventListener('dragleave', () => uploadCard.classList.remove('is-dragover'));
uploadCard.addEventListener('drop', (event) => {
  event.preventDefault();
  uploadCard.classList.remove('is-dragover');
  chooseImage(event.dataTransfer.files[0]);
});
$('retake').addEventListener('click', () => showStep('source'));
$('flakify').addEventListener('click', startJob);
$('try-again').addEventListener('click', (event) => { event.preventDefault(); startOver(); });
$('start-over').addEventListener('click', (event) => { event.preventDefault(); startOver(); });

showStep('source');
startCamera();
