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
const PIPELINE_LABELS = { tripo: 'Tripo3D', shapes: 'Simple shapes', local: 'Local' };
const ACCEPTED_TYPES = ['image/png', 'image/jpeg'];
const RECENT_LIMIT = 6;
const INTERRUPTED_MESSAGE = 'This conversion was interrupted because the server stopped. Start a new one.';
const JOB_HASH_PATTERN = /^#job=([0-9a-f-]{36})$/;

const $ = (id) => document.getElementById(id);
const state = { figures: {}, stream: null, blob: null, jobId: null, pipeline: 'tripo', figure: 'monster', name: '', pollTimer: null, pollFailures: 0, disposeViewer: null, recent: [], showAllRecent: false };

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
    state.pipeline = $('pipeline').value;
    state.figure = $('figure').value;
    state.name = $('job-name').value.trim();
    const query = new URLSearchParams({ pipeline: state.pipeline, figure: state.figure, name: state.name });
    const res = await fetch(`/api/jobs?${query}`, { method: 'POST', headers: { 'Content-Type': state.blob.type }, body: state.blob });
    if (!res.ok) throw new Error((await res.json()).error ?? `Upload failed (${res.status})`);
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
    button.addEventListener('click', () => openJob(job));
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
  const res = await fetch(`/api/jobs/${job.id}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) {
    alert((await res.json().catch(() => ({}))).error ?? `Delete failed (${res.status})`);
    return false;
  }
  return true;
}

/** Fetches the stored conversions for the recent list. A failure just hides the list. */
async function loadRecent() {
  try {
    const res = await fetch('/api/jobs');
    if (!res.ok) throw new Error(`List failed (${res.status})`);
    state.recent = (await res.json()).jobs;
  } catch {
    state.recent = [];
  }
  renderRecent();
}

/** Reopens the conversion named in the URL, if any. Returns whether one was opened. */
async function restoreFromUrl() {
  const id = location.hash.match(JOB_HASH_PATTERN)?.[1];
  if (!id) return false;
  try {
    const res = await fetch(`/api/jobs/${id}`);
    if (!res.ok) throw new Error(`Job lookup failed (${res.status})`);
    openJob(await res.json());
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
  const ui = PIPELINE_UI[state.pipeline];
  document.querySelector('#stepper li[data-stage="image"]').textContent = 'Figure';
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

/** Lights up the stepper according to which files exist. */
function renderStages(stages) {
  let nextPending = true;
  for (const li of document.querySelectorAll('#stepper li')) {
    const done = Boolean(stages[li.dataset.stage]);
    li.classList.toggle('done', done);
    li.classList.toggle('active', !done && nextPending);
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
  try {
    const res = await fetch(`/api/jobs/${state.jobId}`);
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
    state.pollFailures += 1;
    if (state.pollFailures > POLL_MAX_RETRIES) return showError(`Lost contact with the server: ${err.message}`);
    state.pollTimer = setTimeout(poll, nextPollDelay(state.pollFailures));
  }
}

/** Shows every stage side by side, fills in download links and loads the 3D viewer. */
async function showResult(stages) {
  const file = (name) => `/api/jobs/${state.jobId}/${name}?download=1`;
  const view = (name) => `/api/jobs/${state.jobId}/${name}`;
  $('dl-stl').href = file('model.stl');
  const ui = PIPELINE_UI[state.pipeline];
  showName($('result-name'), state.name);
  $('stage-original').src = view(stages.input);
  $('stage-image').src = view(stages.image);
  $('stage-image-label').textContent = figureLabel(state.figure);
  $('stage-final-label').textContent = 'Final 3D figure';
  $('stage-final').removeAttribute('src');
  $('dl-final').hidden = true;
  $('dl-image').href = file(stages.image);
  $('dl-image').textContent = 'Download figure image';
  $('dl-model').hidden = !ui.modelDownload;
  if (ui.modelDownload) {
    $('dl-model').href = file(stages.model);
    $('dl-model').textContent = ui.modelDownload;
  }
  $('dl-original').href = file(stages.input);
  showStep('result');
  try {
    const { dispose, still } = await mountViewer($('viewer'), view(ui.viewerFile));
    state.disposeViewer = dispose;
    $('stage-final').src = still;
    $('dl-final').href = still;
    $('dl-final').download = `${fileSlug(state.name)}-final.png`;
    $('dl-final').hidden = false;
  } catch (err) {
    $('viewer').textContent = `Could not load 3D preview: ${err.message}`;
    $('stage-final').alt = 'No render: the 3D model could not be loaded';
  }
}

/** Returns to the first step and clears everything. */
function startOver() {
  clearTimeout(state.pollTimer);
  state.disposeViewer?.();
  Object.assign(state, { blob: null, jobId: null, pipeline: 'tripo', figure: 'monster', name: '', pollTimer: null, pollFailures: 0, disposeViewer: null });
  history.replaceState(null, '', location.pathname);
  $('file-input').value = '';
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
$('delete-job').addEventListener('click', async () => {
  if (await deleteJob({ id: state.jobId, name: state.name })) startOver();
});
$('recent-more').addEventListener('click', () => { state.showAllRecent = true; renderRecent(); });

await loadFigures();
if (!(await restoreFromUrl())) {
  showStep('source');
  startCamera();
}
loadRecent();
