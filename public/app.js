import { onSaveMonsterPhoto, stopMonsterScan, toggleMonsterScan } from './monster-scan.js';
import { mountViewer } from './viewer.js';

const COUNTDOWN_SECONDS = 3;
const POLL_INTERVAL_MS = 2000;
const POLL_MAX_RETRIES = 5;
const POLL_BACKOFF_MAX_MS = 30000;
const STAGES = ['input', 'image', 'model', 'stl'];
/** Per-3D-method hint, intermediate model download and the file the viewer shows. */
const PIPELINE_UI = {
  tripo: { hint: 'This usually takes one to three minutes.', modelDownload: 'Download GLB', viewerFile: 'model.glb' },
  shapes: { hint: 'This usually takes one to four minutes.', modelDownload: null, viewerFile: 'model.stl' },
  local: { hint: 'Running on this Mac usually takes 10 to 20 minutes.', modelDownload: 'Download GLB', viewerFile: 'model.glb' },
};
const PIPELINE_LABELS = { tripo: 'Tripo3D', shapes: 'Simple shapes', local: 'Local', photo: 'Monster scan' };
/** Pipeline of a run that only holds a monster scan photo; opening it offers the photo to flakify. */
const PHOTO_PIPELINE = 'photo';
const RECENT_LIMIT = 6;
const INTERRUPTED_MESSAGE = 'This conversion was interrupted because the server stopped. Start a new one.';
const JOB_HASH_PATTERN = /^#job=([0-9a-f-]{36})$/;
/** Set by scripts/build-pages.sh: a static copy with no /api, so only the in-browser parts work. */
const NO_BACKEND = document.documentElement.dataset.backend === 'none';

const $ = (id) => document.getElementById(id);
/** The per-conversion part of the state, as it is before a photo is chosen. */
const freshJobState = () => ({ blob: null, previewUrl: null, jobId: null, pipeline: 'tripo', figure: 'monster', name: '', pollTimer: null, pollFailures: 0, disposeViewer: null });
const state = { figures: {}, stream: null, recent: [], showAllRecent: false, ...freshJobState() };

/**
 * Reveals one step section with a fade and hides the rest. Moves focus into the new step
 * so keyboard and screen reader users are not left on a control that just disappeared.
 */
function showStep(name, { focus = true } = {}) {
  for (const step of document.querySelectorAll('.step')) {
    const active = step.dataset.step === name;
    step.hidden = !active;
    step.classList.toggle('is-visible', false);
    if (!active) continue;
    requestAnimationFrame(() => requestAnimationFrame(() => step.classList.add('is-visible')));
    if (focus) step.focus({ preventScroll: true });
  }
}

/** Starts the webcam preview; says how to fix it when access is refused or there is no camera. */
async function startCamera() {
  if (state.stream) return;
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 } } });
    $('video').srcObject = state.stream;
    setCameraBlocked(false);
  } catch {
    setCameraBlocked(true);
  }
}

/** Shows the camera error and disables the buttons that need the camera, or undoes that. */
function setCameraBlocked(blocked) {
  $('camera-error').hidden = !blocked;
  $('take-photo').disabled = blocked;
  $('scan-toggle').disabled = blocked;
}

/** Shows the camera preview full screen, with the logo on top, or leaves full screen. */
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else $('camera-frame').requestFullscreen().catch(() => {});
}

/** Stops the webcam so the indicator light goes off. */
function stopCamera() {
  if (document.fullscreenElement) document.exitFullscreen();
  stopMonsterScan();
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

/** Shows the chosen photo, or replaces the previous one, freeing its object URL. */
function setPreview(blob) {
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.blob = blob;
  state.previewUrl = blob ? URL.createObjectURL(blob) : null;
  if (state.previewUrl) {
    $('preview').src = state.previewUrl;
    $('dl-photo').href = state.previewUrl;
  } else {
    $('preview').removeAttribute('src');
    $('dl-photo').removeAttribute('href');
  }
}

/** Moves to the confirm step with the chosen image. */
function chooseImage(blob) {
  if (!blob) return;
  setPreview(blob);
  stopCamera();
  showStep('confirm');
}

/** Error message from a failed API response, which may not be JSON (e.g. a proxy page). */
async function responseError(res, fallback) {
  const body = await res.json().catch(() => ({}));
  return body.error ?? `${fallback} (${res.status})`;
}

/** Uploads the image, creates a job and starts polling. */
async function startJob() {
  $('flakify').disabled = true;
  try {
    state.pipeline = $('pipeline').value;
    state.figure = $('figure').value;
    state.name = $('job-name').value.trim();
    const query = new URLSearchParams({ pipeline: state.pipeline, figure: state.figure, name: state.name });
    const res = await fetch(`/api/jobs?${query}`, { method: 'POST', headers: { 'Content-Type': state.blob.type }, body: state.blob });
    if (!res.ok) throw new Error(await responseError(res, 'Upload failed'));
    openJob({ id: (await res.json()).id, pipeline: state.pipeline, figure: state.figure, name: state.name });
  } catch (err) {
    resetProgress();
    showStep('progress');
    showError(err.message);
  } finally {
    $('flakify').disabled = false;
  }
}

/**
 * Shows a stored or freshly started conversion: the result when it is finished, otherwise
 * the progress view, which keeps polling. The id goes in the URL so a reload reopens it.
 * @param {{ id: string, pipeline: string, figure: string, name: string | null }} job
 */
function openJob(job) {
  clearTimeout(state.pollTimer);
  state.disposeViewer?.();
  const pipeline = job.pipeline in PIPELINE_UI ? job.pipeline : 'tripo';
  Object.assign(state, { jobId: job.id, pipeline, figure: job.figure, name: job.name ?? '', disposeViewer: null });
  history.replaceState(null, '', `#job=${job.id}`);
  stopCamera();
  resetProgress();
  showStep('progress');
  poll();
}

/** Display name of a figure key, falling back to the key for presets that were removed. */
function figureLabel(figure) {
  return state.figures[figure] ?? figure;
}

/** Fills the figure picker from the server's presets. */
async function loadFigures() {
  if (NO_BACKEND) return;
  try {
    const res = await fetch('/api/figures');
    if (!res.ok) throw new Error(`Figures failed (${res.status})`);
    const { figures, default: selected } = await res.json();
    state.figures = Object.fromEntries(figures.map(({ id, label }) => [id, label]));
    $('figure').replaceChildren(...figures.map(({ id, label }) => new Option(label, id, id === selected, id === selected)));
  } catch {
    // Keep the built-in monster option; the server still accepts it.
  }
}

/** Formats a job's creation time for the recent list. */
function formatDate(iso) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** One-word status of a stored job for the recent list. */
function jobState(job) {
  if (job.pipeline === PHOTO_PIPELINE) return 'Photo';
  if (job.error) return 'Failed';
  if (STAGES.every((stage) => job.stages[stage])) return 'Done';
  return job.running ? 'In progress' : 'Interrupted';
}

/** Renders the recent conversions, newest first, each opening its job when clicked. */
function renderRecent() {
  const jobs = state.showAllRecent ? state.recent : state.recent.slice(0, RECENT_LIMIT);
  $('recent').hidden = state.recent.length === 0;
  $('recent-more').hidden = state.showAllRecent || state.recent.length <= RECENT_LIMIT;
  $('recent-more').textContent = `Show all ${state.recent.length}`;
  $('recent-list').replaceChildren(...jobs.map((job) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'recent-item';
    const thumb = job.stages.image ?? job.stages.input;
    const img = document.createElement('img');
    img.className = 'recent-thumb';
    img.alt = '';
    img.loading = 'lazy';
    if (thumb) img.src = `/api/jobs/${job.id}/${thumb}`;
    const text = document.createElement('span');
    text.className = 'recent-text';
    const title = document.createElement('span');
    title.className = 'recent-name';
    title.textContent = job.name || formatDate(job.createdAt);
    const meta = document.createElement('span');
    meta.className = 'recent-meta';
    const status = document.createElement('span');
    status.textContent = jobState(job);
    status.dataset.state = status.textContent.toLowerCase().replace(' ', '-');
    meta.append([figureLabel(job.figure), PIPELINE_LABELS[job.pipeline] ?? job.pipeline, job.name ? formatDate(job.createdAt) : null, ''].filter((part) => part !== null).join(' · '), status);
    text.append(title, meta);
    button.append(img, text);
    button.addEventListener('click', () => (job.pipeline === PHOTO_PIPELINE ? openPhoto(job) : openJob(job)));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'recent-delete';
    remove.textContent = '×';
    remove.title = 'Delete';
    remove.setAttribute('aria-label', `Delete ${title.textContent}`);
    remove.disabled = job.running === true;
    remove.addEventListener('click', async () => {
      if (!(await deleteJob(job))) return;
      state.recent = state.recent.filter((other) => other.id !== job.id);
      renderRecent();
    });
    const li = document.createElement('li');
    li.className = 'recent-row';
    li.append(button, remove);
    return li;
  }));
}

/**
 * Deletes a stored conversion after the user confirms. Returns whether it was deleted.
 * @param {{ id: string, name: string | null, createdAt?: string }} job
 */
async function deleteJob(job) {
  const label = job.name || (job.createdAt ? `the conversion from ${formatDate(job.createdAt)}` : 'this conversion');
  if (!confirm(`Delete ${label}? Its images and 3D files are removed for good.`)) return false;
  try {
    const res = await fetch(`/api/jobs/${job.id}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 404) throw new Error(await responseError(res, 'Delete failed'));
    return true;
  } catch (err) {
    alert(err.message);
    return false;
  }
}

/** Fetches the stored conversions for the recent list. A failure just hides the list. */
async function loadRecent() {
  if (NO_BACKEND) return;
  try {
    const res = await fetch('/api/jobs');
    if (!res.ok) throw new Error(`List failed (${res.status})`);
    state.recent = (await res.json()).jobs;
  } catch {
    state.recent = [];
  }
  renderRecent();
}

/**
 * Opens a monster photo run at the confirm step, ready to flakify.
 * @param {{ id: string, stages: { input: string | null } }} job
 * @returns {Promise<boolean>} whether the photo opened
 */
async function openPhoto(job) {
  try {
    const res = await fetch(`/api/jobs/${job.id}/${job.stages.input}`);
    if (!res.ok) throw new Error(await responseError(res, 'Could not load the photo'));
    chooseImage(await res.blob());
    return true;
  } catch (err) {
    alert(err.message);
    return false;
  }
}

/**
 * Saves a monster photo the user picked as a run of its own in the recent runs.
 * @param {Blob} photo PNG
 * @returns {Promise<boolean>} whether it was saved
 */
async function saveMonsterPhoto(photo) {
  try {
    const res = await fetch('/api/photos', { method: 'POST', headers: { 'Content-Type': photo.type }, body: photo });
    if (!res.ok) throw new Error(await responseError(res, 'Saving the monster photo failed'));
    await loadRecent();
    return true;
  } catch (err) {
    console.warn(err.message);
    return false;
  }
}

/** Reopens the conversion named in the URL, if any. Returns whether one was opened. */
async function restoreFromUrl() {
  const id = location.hash.match(JOB_HASH_PATTERN)?.[1];
  if (!id || NO_BACKEND) return false;
  try {
    const res = await fetch(`/api/jobs/${id}`);
    if (!res.ok) throw new Error(`Job lookup failed (${res.status})`);
    const job = await res.json();
    if (job.pipeline === PHOTO_PIPELINE) {
      history.replaceState(null, '', location.pathname);
      // When the photo cannot load, startup goes on to the camera as with no link at all.
      return await openPhoto(job);
    }
    openJob(job);
    return true;
  } catch {
    history.replaceState(null, '', location.pathname);
    return false;
  }
}

/** Same rule as the server's fileSlug(): an ASCII file name prefix for downloads. */
function fileSlug(name) {
  const slug = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'flakifier';
}

/** Shows the job name as a heading, or hides the heading when there is none. */
function showName(element, name) {
  element.textContent = name;
  element.hidden = !name;
}

/** Clears stepper, preview and error state. */
function resetProgress() {
  showName($('progress-name'), state.name);
  clearTimeout(state.pollTimer);
  state.pollFailures = 0;
  $('error').hidden = true;
  $('image-preview').hidden = true;
  $('progress-status').textContent = '';
  const ui = PIPELINE_UI[state.pipeline];
  $('progress-hint').textContent = ui.hint;
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

/** Lights up the stepper according to which files exist and announces the running stage. */
function renderStages(stages) {
  let nextPending = true;
  for (const li of document.querySelectorAll('#stepper li')) {
    const done = Boolean(stages[li.dataset.stage]);
    li.classList.toggle('done', done);
    li.classList.toggle('active', !done && nextPending);
    if (!done && nextPending) {
      const message = `Running: ${li.textContent}`;
      if ($('progress-status').textContent !== message) $('progress-status').textContent = message;
    }
    if (!done) nextPending = false;
  }
  if (stages.image && $('image-preview').hidden) {
    $('image-preview').src = `/api/jobs/${state.jobId}/${stages.image}`;
    $('image-preview').hidden = false;
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
  const { jobId } = state;
  try {
    const res = await fetch(`/api/jobs/${jobId}`);
    // The user moved on (start over, another job) while the request was in flight.
    if (jobId !== state.jobId) return;
    if (res.status === 404) return showError('Job not found');
    if (!res.ok) throw new Error(`Status check failed (${res.status})`);
    const { stages, error, running } = await res.json();
    state.pollFailures = 0;
    renderStages(stages);
    if (error) return showError(error);
    if (STAGES.every((stage) => stages[stage])) return showResult(stages);
    if (running === false) return showError(INTERRUPTED_MESSAGE);
    state.pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
  } catch (err) {
    if (jobId !== state.jobId) return;
    state.pollFailures += 1;
    if (state.pollFailures > POLL_MAX_RETRIES) return showError(`Lost contact with the server: ${err.message}`);
    state.pollTimer = setTimeout(poll, nextPollDelay(state.pollFailures));
  }
}

/** Shows every stage side by side, fills in download links and loads the 3D viewer. */
async function showResult(stages) {
  const { jobId } = state;
  const file = (name) => `/api/jobs/${jobId}/${name}?download=1`;
  const view = (name) => `/api/jobs/${jobId}/${name}`;
  $('dl-stl').href = file('model.stl');
  const ui = PIPELINE_UI[state.pipeline];
  showName($('result-name'), state.name);
  $('stage-original').src = view(stages.input);
  $('stage-image').src = view(stages.image);
  $('stage-image-label').textContent = figureLabel(state.figure);
  $('stage-final').removeAttribute('src');
  $('dl-final').hidden = true;
  $('dl-image').href = file(stages.image);
  $('dl-model').hidden = !ui.modelDownload;
  if (ui.modelDownload) {
    $('dl-model').href = file(stages.model);
    $('dl-model').textContent = ui.modelDownload;
  }
  $('dl-original').href = file(stages.input);
  showStep('result');
  try {
    const { dispose, still } = await mountViewer($('viewer'), view(ui.viewerFile));
    if (jobId !== state.jobId) return dispose();
    state.disposeViewer = dispose;
    $('stage-final').src = still;
    $('dl-final').href = still;
    $('dl-final').download = `${fileSlug(state.name)}-final.png`;
    $('dl-final').hidden = false;
  } catch (err) {
    if (jobId !== state.jobId) return;
    $('viewer').textContent = `Could not load 3D preview: ${err.message}`;
    $('stage-final').alt = 'No render: the 3D model could not be loaded';
  }
}

/** Returns to the first step and clears everything. */
function startOver() {
  clearTimeout(state.pollTimer);
  state.disposeViewer?.();
  setPreview(null);
  Object.assign(state, freshJobState());
  history.replaceState(null, '', location.pathname);
  $('job-name').value = '';
  showStep('source');
  startCamera();
  loadRecent();
}

$('take-photo').addEventListener('click', async () => {
  $('take-photo').disabled = true;
  await runCountdown();
  chooseImage(await captureFrame());
  $('take-photo').disabled = false;
});
// Not every browser can show an element full screen (iPhone Safari cannot); there the button stays hidden.
$('fullscreen-toggle').hidden = !document.fullscreenEnabled;
$('fullscreen-toggle').addEventListener('click', toggleFullscreen);
document.addEventListener('fullscreenchange', () => {
  $('fullscreen-toggle').setAttribute('aria-pressed', String(document.fullscreenElement === $('camera-frame')));
});
$('scan-toggle').addEventListener('click', () => toggleMonsterScan($('video')));
onSaveMonsterPhoto(NO_BACKEND ? null : saveMonsterPhoto);
$('retake').addEventListener('click', () => { showStep('source'); startCamera(); });
$('flakify').addEventListener('click', startJob);
$('home-link').addEventListener('click', (event) => {
  // Let the browser open a new tab or window as usual; a plain click resets in place.
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  startOver();
});
$('try-again').addEventListener('click', startOver);
$('start-over').addEventListener('click', startOver);
$('delete-job').addEventListener('click', async () => {
  if (await deleteJob({ id: state.jobId, name: state.name })) startOver();
});
$('recent-more').addEventListener('click', () => { state.showAllRecent = true; renderRecent(); });

/** Disables what needs the server and says so; the photo can still be downloaded instead. */
function disableBackendFeatures() {
  $('no-backend-notice').hidden = false;
  $('flakify-unavailable').hidden = false;
  $('dl-photo').hidden = false;
  for (const id of ['job-name', 'figure', 'pipeline', 'flakify']) $(id).disabled = true;
  $('flakify').setAttribute('aria-describedby', 'flakify-unavailable');
}

if (NO_BACKEND) disableBackendFeatures();
await loadFigures();
if (!(await restoreFromUrl())) {
  showStep('source', { focus: false });
  startCamera();
}
loadRecent();
