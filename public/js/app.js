import { findFaces } from './monster-face.js';
import { onSaveMonsterPhoto, showLiveCamera, startMonsterScan, stopMonsterScan, takePreviewPhoto } from './monster-scan.js';
import { mountViewer } from './viewer.js';

const COUNTDOWN_SECONDS = 3;
const POLL_INTERVAL_MS = 2000;
const POLL_MAX_RETRIES = 5;
const POLL_BACKOFF_MAX_MS = 30000;
const STAGES = ['input', 'image', 'model', 'stl'];
const STAGE_LABELS = ['Input', 'Figure', '3D model', 'STL'];
/** Per-3D-method hint, stepper labels, intermediate model download and the file the viewer shows. */
const PIPELINE_UI = {
  tripo: { hint: 'This usually takes one to three minutes.', modelDownload: 'Download GLB', viewerFile: 'model.glb' },
  shapes: { hint: 'This usually takes one to four minutes.', modelDownload: null, viewerFile: 'model.stl' },
  local: { hint: 'Running on this Mac usually takes 10 to 20 minutes.', modelDownload: 'Download GLB', viewerFile: 'model.glb' },
  browser: { hint: 'Loading the models…', stageLabels: ['Models', 'Cut-out', 'Depth', 'STL'] },
};
const PIPELINE_LABELS = { tripo: 'Tripo3D', shapes: 'Simple shapes', local: 'Local', browser: 'In this browser', photo: 'Monster scan' };
/** The pipeline that runs in this page (browser-worker.js) instead of on the server. */
const BROWSER_PIPELINE = 'browser';
/**
 * The ways to make a figure, in the order the form lists them, explained for people who
 * do not know the models. Server ones may not be set up; the server says which and why.
 */
const MODELS = [
  {
    id: 'tripo',
    name: 'Best quality, in the cloud',
    description: 'OpenAI draws your figure, then Tripo3D sculpts it into a detailed 3D model. Your photo is sent to both companies. Costs roughly 40 to 90 cents per figure and takes one to three minutes.',
  },
  {
    id: 'shapes',
    name: 'Chunky toy look, in the cloud',
    description: 'OpenAI draws your figure, then rebuilds it from simple blocks, balls and cylinders, like a toy. Your photo is sent to OpenAI. Costs roughly 10 to 35 cents and takes one to four minutes.',
  },
  {
    id: 'local',
    name: 'Private, on the Flakifier Mac',
    description: 'Free models draw and sculpt your figure on the Mac that runs Flakifier. Nothing goes to the cloud and nothing is paid, but it takes 10 to 20 minutes.',
  },
  {
    id: BROWSER_PIPELINE,
    name: 'Free and private, in this browser',
    description: 'Free models run right here on your device and turn the photo into a 3D picture that stands out from a flat back, like a medal, rather than a full figure: a monster bobblehead with googly eyes, or a plain relief. The photo never leaves this device. The first run downloads about 130 MB; after that it takes a minute or two.',
  },
];
/** What the in-browser pipeline can make: the shapes public/js/relief.js builds. */
const BROWSER_FIGURES = [
  { id: 'monster', label: 'Monster bobblehead: big head, googly eyes, tongue' },
  { id: 'relief', label: 'Relief with a flat back' },
  { id: 'rounded', label: 'Rounded on both sides' },
  { id: 'bricks', label: 'LEGO-style bricks' },
];
/** Status line while the in-browser pipeline works on a stage. */
const BROWSER_HINTS = {
  faces: 'Finding the face…',
  input: 'Preparing the photo…',
  cutout: 'Removing the background…',
  depth: 'Estimating depth…',
  stl: 'Building the 3D model…',
};
/** Stepper stage each in-browser stage completes. */
const BROWSER_STAGES = { input: 'input', cutout: 'image', depth: 'model', stl: 'stl' };
const MB = 1024 * 1024;
/** Longest wait for the face landmarks; the figure is made without them after that. */
const FACE_TIMEOUT_MS = 20000;
/** Pipeline of a run that only holds a monster scan photo; opening it offers the photo to flakify. */
const PHOTO_PIPELINE = 'photo';
const RECENT_LIMIT = 6;
const INTERRUPTED_MESSAGE = 'This conversion was interrupted because the server stopped. Start a new one.';
const JOB_HASH_PATTERN = /^#job=([0-9a-f-]{36})$/;
/** Set by scripts/build-pages.sh: a static copy with no /api, so only the in-browser parts work. */
const NO_BACKEND = document.documentElement.dataset.backend === 'none';

const $ = (id) => document.getElementById(id);
/** The per-conversion part of the state, as it is before a photo is chosen. */
const freshJobState = () => ({ blob: null, previewUrl: null, jobId: null, run: 0, pipeline: 'tripo', figure: 'monster', name: '', pollTimer: null, pollFailures: 0, disposeViewer: null, browser: null });
const state = {
  figures: {},
  serverFigures: [{ id: 'monster', label: 'Flaky Test Monster' }],
  defaultFigure: 'monster',
  /** Why each method cannot run here, by id; a missing entry means it can. */
  unavailable: {},
  /** True while Flakify is creating a job. */
  starting: false,
  /** The figure last picked for each method, kept while switching between them. */
  figureChoice: {},
  worker: null,
  stream: null,
  /** Set once the camera has run, so coming back to the start turns it on again. */
  cameraWanted: false,
  recent: [],
  showAllRecent: false,
  ...freshJobState(),
};
/** Each opened or started conversion gets a new number, so late answers for an old one are ignored. */
let runCounter = 0;
/** Numbers availability checks, so an older answer that arrives late does not win. */
let availabilityCheck = 0;

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

/** Whether the current history entry is the start: the camera and recent runs. */
function atStart() {
  return (history.state?.step ?? 'start') === 'start';
}

/**
 * Gives a step after the start its own history entry, so the browser's Back button leads to
 * the start. Every such entry sits right on top of the start's: from the start it is pushed,
 * from another step it replaces that one, so Back from a conversion skips the photo check.
 * @param {'confirm' | 'job'} step the photo check, or a conversion in progress or finished
 * @param {string} [url] with the job id for a conversion that can be reopened
 */
function enterStep(step, url = location.pathname) {
  if (atStart()) history.pushState({ step }, '', url);
  else history.replaceState({ step }, '', url);
}

/**
 * Starts the webcam preview; says how to fix it when access is refused or there is no camera.
 * Only runs from the Start the camera button, or on coming back to the start after that.
 */
async function startCamera() {
  if (state.stream) return;
  // Checked before the button is disabled and hidden, which would drop its focus to the page.
  const hadFocus = document.activeElement === $('camera-start');
  $('camera-start').disabled = true;
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 } } });
    $('video').srcObject = state.stream;
    // Only a camera that actually ran comes back by itself; a refused one waits for the button.
    state.cameraWanted = true;
    setCameraOn(true);
    // Keyboard users go on to the next action; a camera resumed by itself takes no focus.
    if (hadFocus) $('take-photo').focus();
    // The monster scan is always on while the camera is.
    startMonsterScan($('video'));
  } catch {
    setCameraOn(false, { blocked: true });
  } finally {
    $('camera-start').disabled = false;
  }
  if (hadFocus && !state.stream) $('camera-start').focus();
}

/**
 * Shows the Start the camera button and disables the buttons that need the camera, or the
 * other way round once it runs; with blocked, also says why it is not running.
 */
function setCameraOn(on, { blocked = false } = {}) {
  $('camera-start').hidden = on;
  $('camera-error').hidden = !blocked;
  $('take-photo').disabled = !on;
}

/** Turns the camera back on at the start if it was started before, otherwise waits for its button. */
function resumeCamera() {
  if (state.cameraWanted) startCamera();
}

/** Shows the camera preview and the monster photos full screen, with the logo on top, or leaves full screen. */
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else $('camera-stage').requestFullscreen().catch(() => {});
}

/** Stops the webcam so the indicator light goes off. */
function stopCamera() {
  if (document.fullscreenElement) document.exitFullscreen();
  stopMonsterScan();
  showLiveCamera();
  state.stream?.getTracks().forEach((track) => track.stop());
  state.stream = null;
  setCameraOn(false);
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

/** Grabs the current video frame as a PNG blob, with the monster look the preview has. */
function captureFrame() {
  return takePreviewPhoto($('video'));
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
  enterStep('confirm');
  showStep('confirm');
  // A method may have been set up (or stopped) since the page loaded.
  loadAvailability();
}

/** Error message from a failed API response, which may not be JSON (e.g. a proxy page). */
async function responseError(res, fallback) {
  const body = await res.json().catch(() => ({}));
  return body.error ?? `${fallback} (${res.status})`;
}

/** Uploads the image, creates a job and starts polling. */
async function startJob() {
  state.starting = true;
  $('flakify').disabled = true;
  try {
    state.pipeline = selectedModel();
    state.figure = $('figure').value;
    state.name = $('job-name').value.trim();
    if (state.pipeline === BROWSER_PIPELINE) return runInBrowser();
    const query = new URLSearchParams({ pipeline: state.pipeline, figure: state.figure, name: state.name });
    const res = await fetch(`/api/jobs?${query}`, { method: 'POST', headers: { 'Content-Type': state.blob.type }, body: state.blob });
    if (!res.ok) throw new Error(await responseError(res, 'Upload failed'));
    openJob({ id: (await res.json()).id, pipeline: state.pipeline, figure: state.figure, name: state.name });
  } catch (err) {
    enterStep('job');
    resetProgress();
    showStep('progress');
    showError(err.message);
  } finally {
    state.starting = false;
    $('flakify').disabled = !selectedModel();
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
  leaveBrowserRun();
  const pipeline = job.pipeline in PIPELINE_UI && job.pipeline !== BROWSER_PIPELINE ? job.pipeline : 'tripo';
  Object.assign(state, { jobId: job.id, run: ++runCounter, pipeline, figure: job.figure, name: job.name ?? '', disposeViewer: null });
  enterStep('job', `#job=${job.id}`);
  stopCamera();
  resetProgress();
  showStep('progress');
  poll();
}

/** Display name of a figure key, falling back to the key for presets that were removed. */
function figureLabel(figure) {
  return state.figures[figure] ?? BROWSER_FIGURES.find(({ id }) => id === figure)?.label ?? figure;
}

/** Loads the server's figure presets. Without a server only the built-in monster is known. */
async function loadFigures() {
  if (NO_BACKEND) return;
  try {
    const res = await fetch('/api/figures');
    if (!res.ok) throw new Error(`Figures failed (${res.status})`);
    const { figures, default: selected } = await res.json();
    state.figures = Object.fromEntries(figures.map(({ id, label }) => [id, label]));
    state.serverFigures = figures;
    state.defaultFigure = selected;
  } catch {
    // Keep the built-in monster option; the server still accepts it.
  }
}

/**
 * Finds out which methods can run here: the server reports its own, and the in-browser one
 * needs Web Workers and WebAssembly. Then draws the method list.
 */
async function loadAvailability() {
  const check = ++availabilityCheck;
  const unavailable = {};
  const serverModels = MODELS.filter(({ id }) => id !== BROWSER_PIPELINE);
  if (NO_BACKEND) {
    for (const { id } of serverModels) unavailable[id] = 'it needs the Flakifier server, which this preview site does not have.';
  } else {
    try {
      const res = await fetch('/api/pipelines');
      if (!res.ok) throw new Error(`Pipelines failed (${res.status})`);
      for (const { id, unavailable: reason } of (await res.json()).pipelines) if (reason) unavailable[id] = reason;
    } catch {
      for (const { id } of serverModels) unavailable[id] = 'the Flakifier server could not be reached.';
    }
  }
  if (typeof Worker === 'undefined' || typeof WebAssembly === 'undefined') {
    unavailable[BROWSER_PIPELINE] = 'this browser cannot run the models. Try a current Chrome, Edge, Firefox or Safari.';
  }
  if (check !== availabilityCheck) return;
  state.unavailable = unavailable;
  renderModels();
}

/** The method picked in the form, or undefined when none can run. */
function selectedModel() {
  return document.querySelector('input[name="model"]:checked')?.value;
}

/**
 * Lists the methods as radio buttons with their explanation. Those that cannot run are
 * disabled and say why. Keeps the current pick when it can still run, else picks the first
 * that can.
 */
function renderModels() {
  const current = selectedModel();
  const usable = MODELS.filter(({ id }) => !state.unavailable[id]);
  const pick = usable.some(({ id }) => id === current) ? current : usable[0]?.id;
  $('models').replaceChildren(...MODELS.map(({ id, name, description }) => {
    const reason = state.unavailable[id];
    const label = document.createElement('label');
    label.className = 'model';
    const input = document.createElement('input');
    Object.assign(input, { type: 'radio', name: 'model', value: id, checked: id === pick, disabled: Boolean(reason) });
    const title = document.createElement('span');
    title.className = 'model-name';
    title.textContent = name;
    const text = document.createElement('span');
    text.className = 'model-description';
    text.textContent = description;
    label.append(input, title, text);
    if (reason) {
      const note = document.createElement('span');
      note.className = 'model-note';
      note.textContent = `Not available here: ${reason}`;
      label.append(note);
    }
    return label;
  }));
  const none = usable.length === 0;
  $('flakify-unavailable').hidden = !none;
  // Stays off while a job is being started, so a second click cannot start a second job.
  $('flakify').disabled = none || state.starting;
  if (none) $('flakify').setAttribute('aria-describedby', 'flakify-unavailable');
  else $('flakify').removeAttribute('aria-describedby');
  renderFigures();
}

/** Fills the figure picker with what the picked method can make, keeping earlier picks. */
function renderFigures() {
  const model = selectedModel();
  const browser = model === BROWSER_PIPELINE;
  const figures = browser ? BROWSER_FIGURES : state.serverFigures;
  const wanted = state.figureChoice[browser ? BROWSER_PIPELINE : 'server'] ?? (browser ? figures[0].id : state.defaultFigure);
  const selected = figures.some(({ id }) => id === wanted) ? wanted : figures[0].id;
  $('figure').replaceChildren(...figures.map(({ id, label }) => new Option(label, id, id === selected, id === selected)));
  $('figure').disabled = !model;
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
      history.replaceState({ step: 'start' }, '', location.pathname);
      // When the photo cannot load, startup goes on to the camera as with no link at all.
      return await openPhoto(job);
    }
    // Opened from a link: the start goes below it, so Back leads there and not off the site.
    if (atStart()) history.replaceState({ step: 'start' }, '', location.pathname);
    openJob(job);
    return true;
  } catch {
    history.replaceState({ step: 'start' }, '', location.pathname);
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
  const labels = ui.stageLabels ?? STAGE_LABELS;
  document.querySelectorAll('#stepper li').forEach((li, i) => {
    li.classList.remove('done', 'active');
    li.removeAttribute('aria-current');
    li.textContent = labels[i];
  });
}

/** Shows a one-line error under the stepper. */
function showError(message) {
  $('error-text').textContent = message;
  $('error').hidden = false;
  $('progress-hint').hidden = true;
  const active = document.querySelector('#stepper li.active');
  active?.classList.remove('active');
  active?.removeAttribute('aria-current');
}

/**
 * Lights up the stepper according to which stages are done and announces the running one.
 * @param {Record<string, unknown>} stages truthy for each finished stage
 * @param {string} [imageUrl] figure image to preview, by default the job's from the server
 */
function renderStages(stages, imageUrl = stages.image && `/api/jobs/${state.jobId}/${stages.image}`) {
  let nextPending = true;
  for (const li of document.querySelectorAll('#stepper li')) {
    const done = Boolean(stages[li.dataset.stage]);
    li.classList.toggle('done', done);
    li.classList.toggle('active', !done && nextPending);
    // The running step is marked for assistive tech too, not just by the class the CSS lights up.
    if (!done && nextPending) li.setAttribute('aria-current', 'step');
    else li.removeAttribute('aria-current');
    if (!done && nextPending) {
      const message = `Running: ${li.textContent}`;
      if ($('progress-status').textContent !== message) $('progress-status').textContent = message;
    }
    if (!done) nextPending = false;
  }
  if (imageUrl && $('image-preview').hidden) {
    $('image-preview').src = imageUrl;
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

/** Shows a finished server job: every stage side by side, downloads and the 3D viewer. */
function showResult(stages) {
  const file = (name) => `/api/jobs/${state.jobId}/${name}?download=1`;
  const view = (name) => `/api/jobs/${state.jobId}/${name}`;
  const ui = PIPELINE_UI[state.pipeline];
  return renderResult({
    original: view(stages.input),
    image: view(stages.image),
    imageLabel: figureLabel(state.figure),
    viewer: view(ui.viewerFile),
    // The server names downloaded files itself.
    downloads: {
      stl: { href: file('model.stl') },
      image: { href: file(stages.image), text: 'Download figure image' },
      model: ui.modelDownload ? { href: file(stages.model), text: ui.modelDownload } : null,
      original: { href: file(stages.input) },
    },
    deletable: true,
  });
}

/** Sets a download link, or clears its file name so the server's name applies. */
function setDownload(link, { href, name = '', text }) {
  link.href = href;
  link.download = name;
  if (text) link.textContent = text;
}

/**
 * Shows a finished conversion side by side, fills in the downloads and loads the 3D viewer.
 * @param {{ original: string, image: string, imageLabel: string, viewer: string, deletable: boolean,
 *   downloads: Record<'stl' | 'image' | 'original', { href: string, name?: string, text?: string }> &
 *   { model: { href: string, name?: string, text: string } | null } }} result
 */
async function renderResult({ original, image, imageLabel, viewer, downloads, deletable }) {
  const { run } = state;
  showName($('result-name'), state.name);
  $('stage-original').src = original;
  $('stage-image').src = image;
  $('stage-image-label').textContent = imageLabel;
  $('stage-final').removeAttribute('src');
  $('dl-final').hidden = true;
  setDownload($('dl-stl'), downloads.stl);
  setDownload($('dl-image'), downloads.image);
  setDownload($('dl-original'), downloads.original);
  $('dl-model').hidden = !downloads.model;
  if (downloads.model) setDownload($('dl-model'), downloads.model);
  $('delete-job').hidden = !deletable;
  showStep('result');
  try {
    const { dispose, still } = await mountViewer($('viewer'), viewer);
    if (run !== state.run) return dispose();
    state.disposeViewer = dispose;
    $('stage-final').src = still;
    $('dl-final').href = still;
    $('dl-final').download = `${fileSlug(state.name)}-final.png`;
    $('dl-final').hidden = false;
  } catch (err) {
    if (run !== state.run) return;
    $('viewer').textContent = `Could not load 3D preview: ${err.message}`;
    $('stage-final').alt = 'No render: the 3D model could not be loaded';
  }
}

/** The model worker, created on first use and kept so the loaded models are reused. */
function getWorker() {
  if (!state.worker) {
    state.worker = new Worker(new URL('./browser-worker.js', import.meta.url), { type: 'module' });
    state.worker.addEventListener('message', (event) => handleWorkerMessage(event.data));
    state.worker.addEventListener('error', (event) => {
      stopWorker();
      if (!state.browser || state.browser.finished) return;
      state.browser.finished = true;
      showError(`The in-browser models could not start: ${event.message || 'worker error'}`);
    });
  }
  return state.worker;
}

/** Stops the worker, for example to abandon a run; the next run starts a new one. */
function stopWorker() {
  state.worker?.terminate();
  state.worker = null;
}

/** Runs the in-browser pipeline on the chosen photo; its stages fill the same progress view. */
function runInBrowser() {
  clearTimeout(state.pollTimer);
  state.disposeViewer?.();
  leaveBrowserRun();
  Object.assign(state, { jobId: null, run: ++runCounter, disposeViewer: null, browser: { done: {}, files: {}, urls: [], downloads: new Map(), finished: false } });
  enterStep('job');
  stopCamera();
  resetProgress();
  showStep('progress');
  $('progress-hint').textContent = BROWSER_HINTS.faces;
  const { run, blob, figure } = state;
  // The face tracker needs the page (WebGL), so it runs here and the worker gets the landmarks.
  // The worker downloads its models in the meantime.
  getWorker().postMessage({ run, preload: true });
  const timeout = new Promise((resolve) => setTimeout(() => resolve([]), FACE_TIMEOUT_MS));
  Promise.race([findFaces(blob), timeout]).then((faces) => {
    // A worker that failed to start has already shown its error and finished the run.
    if (run !== state.run || !state.browser || state.browser.finished) return;
    getWorker().postMessage({ run, blob, faces, options: { shape: figure } });
  });
}

/**
 * Lets go of the current in-browser run: frees its files, and stops the worker if it is
 * still working, since it handles one photo at a time. A new worker loads the cached models.
 */
function leaveBrowserRun() {
  if (!state.browser) return;
  if (!state.browser.finished) stopWorker();
  state.browser.urls.forEach((url) => URL.revokeObjectURL(url));
  state.browser = null;
}

/** Object URL for a result of the in-browser run, freed when the run is left. */
function browserUrl(blob) {
  const url = URL.createObjectURL(blob);
  state.browser.urls.push(url);
  return url;
}

/** Download progress summed over every model file seen so far. */
function downloadHint(downloads) {
  let loaded = 0, total = 0;
  for (const file of downloads.values()) { loaded += file.loaded; total += file.total; }
  return `Downloading the models, first run only: ${(loaded / MB).toFixed(0)} of ${(total / MB).toFixed(0)} MB`;
}

/** Progress, stage results, the end and errors from the in-browser run. */
function handleWorkerMessage(message) {
  const run = state.browser;
  // Messages carry the number of the run they belong to; anything older is ignored.
  if (state.pipeline !== BROWSER_PIPELINE || !run || message.run !== state.run) return;
  if (message.type === 'progress') {
    if (message.stage === 'download') {
      run.downloads.set(message.file, { loaded: message.loaded ?? 0, total: message.total ?? 0 });
      $('progress-hint').textContent = downloadHint(run.downloads);
      return;
    }
    if (message.device) run.device = message.device;
    // The worker reports 'input' once the models are loaded.
    if (message.stage === 'input') run.done.input = true;
    renderStages(run.done, null);
    if (BROWSER_HINTS[message.stage]) $('progress-hint').textContent = BROWSER_HINTS[message.stage];
  } else if (message.type === 'stage') {
    run.files[message.stage] = message.file;
    run.done[BROWSER_STAGES[message.stage]] = true;
    // null, not undefined: the default would build a server URL for the figure image.
    renderStages(run.done, message.stage === 'cutout' ? browserUrl(message.file) : null);
  } else if (message.type === 'done') {
    run.finished = true;
    showBrowserResult();
  } else if (message.type === 'error') {
    run.finished = true;
    showError(message.message);
  }
}

/** Shows the in-browser result. It lives only in this page, so nothing can be deleted. */
function showBrowserResult() {
  const { files } = state.browser;
  const prefix = `${fileSlug(state.name)}-${state.figure}`;
  const stl = browserUrl(files.stl);
  const cutout = browserUrl(files.cutout);
  return renderResult({
    original: state.previewUrl,
    image: cutout,
    imageLabel: 'Cut-out',
    viewer: stl,
    downloads: {
      stl: { href: stl, name: `${prefix}.stl` },
      image: { href: cutout, name: `${prefix}-cutout.png`, text: 'Download cut-out' },
      model: { href: browserUrl(files.depth), name: `${prefix}-depth.png`, text: 'Download depth map' },
      original: { href: state.previewUrl, name: `${prefix}-photo.${state.blob.type === 'image/jpeg' ? 'jpg' : 'png'}` },
    },
    deletable: false,
  });
}

/**
 * Returns to the first step and clears everything. From a later step that is the browser's
 * Back, so the history does not grow a start entry for every round.
 */
function startOver() {
  if (!atStart()) return history.back();
  resetToStart();
}

/** Clears everything and shows the first step, on the start's history entry. */
function resetToStart() {
  clearTimeout(state.pollTimer);
  state.disposeViewer?.();
  leaveBrowserRun();
  setPreview(null);
  Object.assign(state, freshJobState(), { run: ++runCounter });
  history.replaceState({ step: 'start' }, '', location.pathname);
  $('job-name').value = '';
  showStep('source');
  resumeCamera();
  loadRecent();
}

$('camera-start').addEventListener('click', startCamera);
$('take-photo').addEventListener('click', async () => {
  $('take-photo').disabled = true;
  // The photo is of the camera, so a monster photo being looked at makes way for it.
  showLiveCamera();
  await runCountdown();
  chooseImage(await captureFrame());
  $('take-photo').disabled = !state.stream;
});
// Not every browser can show an element full screen (iPhone Safari cannot); there the button stays hidden.
$('fullscreen-toggle').hidden = !document.fullscreenEnabled;
$('fullscreen-toggle').addEventListener('click', toggleFullscreen);
document.addEventListener('fullscreenchange', () => {
  $('fullscreen-toggle').setAttribute('aria-pressed', String(document.fullscreenElement === $('camera-stage')));
});
onSaveMonsterPhoto(NO_BACKEND ? null : saveMonsterPhoto);
$('retake').addEventListener('click', startOver);
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
// Back and Forward between the start and the later steps.
window.addEventListener('popstate', async () => {
  if (history.state?.step === 'job' && (await restoreFromUrl())) return;
  // The start, or Forward to a step that cannot come back: the photo check or an in-browser
  // run, whose photo went when Back cleared everything.
  resetToStart();
});
$('recent-more').addEventListener('click', () => { state.showAllRecent = true; renderRecent(); });

$('models').addEventListener('change', renderFigures);
$('figure').addEventListener('change', () => {
  state.figureChoice[selectedModel() === BROWSER_PIPELINE ? BROWSER_PIPELINE : 'server'] = $('figure').value;
});

/** Says what needs the server; the photo can also be downloaded to flakify it elsewhere. */
function showNoBackendNotice() {
  $('no-backend-notice').hidden = false;
  $('dl-photo').hidden = false;
}

if (NO_BACKEND) showNoBackendNotice();
await loadFigures();
// Not awaited: the server's check can take seconds and the form is not shown yet; choosing
// a photo checks again anyway.
loadAvailability();
if (!(await restoreFromUrl())) {
  // A reload of the photo check: the photo is gone, so this entry becomes the start.
  history.replaceState({ step: 'start' }, '', location.pathname);
  showStep('source', { focus: false });
}
loadRecent();
