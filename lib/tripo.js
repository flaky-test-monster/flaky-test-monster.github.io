import { glbToStl } from './stl.js';

const TRIPO_BASE_URL = 'https://api.tripo3d.ai/v2/openapi';
const POLL_INTERVAL_MS = 3 * 1000;
const MAX_WAIT_MS = 10 * 60 * 1000;
const API_TIMEOUT_MS = 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 3 * 60 * 1000;
const TRIPO_OK_CODE = 0;
const TASK_SUCCESS = 'success';
const TASK_FAILED_STATES = new Set(['failed', 'cancelled', 'banned', 'expired', 'unknown']);
const STL_FORMAT = 'STL';

/**
 * Resolves after the poll interval.
 * @returns {Promise<void>}
 */
const sleep = () => new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

/**
 * Sends an authenticated request to the Tripo3D API and returns the `data` payload.
 * @param {string} route path relative to the API base, e.g. "/task"
 * @param {RequestInit} [init]
 * @returns {Promise<any>}
 */
async function tripoRequest(route, init = {}) {
  const apiKey = process.env.TRIPO_API_KEY;
  if (!apiKey) throw new Error('TRIPO_API_KEY is not set');
  const res = await fetch(TRIPO_BASE_URL + route, {
    ...init,
    headers: { Authorization: `Bearer ${apiKey}`, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Tripo3D returned a non-JSON response (${res.status})`);
  }
  if (!res.ok || json.code !== TRIPO_OK_CODE) {
    throw new Error(`Tripo3D request failed (${res.status}): ${json.message ?? json.suggestion ?? text}`);
  }
  return json.data;
}

/**
 * Uploads a PNG and returns the image token Tripo3D uses to reference it.
 * @param {Buffer} png
 * @returns {Promise<string>}
 */
async function uploadImage(png) {
  const form = new FormData();
  form.append('file', new Blob([png], { type: 'image/png' }), 'statue.png');
  const data = await tripoRequest('/upload', { method: 'POST', body: form });
  if (!data?.image_token) throw new Error('Tripo3D upload returned no image token');
  return data.image_token;
}

/**
 * Creates a Tripo3D task and returns its id.
 * @param {object} body task definition
 * @returns {Promise<string>}
 */
async function createTask(body) {
  const data = await tripoRequest('/task', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!data?.task_id) throw new Error('Tripo3D did not return a task id');
  return data.task_id;
}

/**
 * Polls a task until it succeeds, fails, or the overall wait limit is exceeded.
 * @param {string} taskId
 * @param {(message: string) => void | Promise<void>} report progress reporter
 * @returns {Promise<object>} the task's `output` object
 */
async function waitForTask(taskId, report) {
  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    const task = await tripoRequest(`/task/${taskId}`);
    if (task.status === TASK_SUCCESS) return task.output ?? {};
    if (TASK_FAILED_STATES.has(task.status)) {
      throw new Error(`Tripo3D task ${task.type ?? ''} ended with status "${task.status}"`);
    }
    await report(`Tripo3D task ${taskId} ${task.status} (${task.progress ?? 0}%)`);
    await sleep();
  }
  throw new Error('Tripo3D task timed out');
}

/**
 * Downloads a generated model file.
 * @param {string} url signed URL returned by Tripo3D
 * @returns {Promise<Buffer>}
 */
async function download(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Model download failed (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Asks Tripo3D to convert a finished model task to STL and downloads the result.
 * @param {string} modelTaskId
 * @param {(message: string) => void | Promise<void>} report
 * @returns {Promise<Buffer>}
 */
async function exportStl(modelTaskId, report) {
  const taskId = await createTask({
    type: 'convert_model',
    format: STL_FORMAT,
    original_model_task_id: modelTaskId,
  });
  const output = await waitForTask(taskId, report);
  if (!output.model) throw new Error('Tripo3D STL conversion returned no file');
  return download(output.model);
}

/**
 * Turns a statue PNG into a 3D model via Tripo3D and returns GLB and STL buffers.
 * The GLB is also handed to `onProgress` as soon as it is available so callers can
 * persist it before the STL export finishes.
 * @param {Buffer} pngBuffer statue image
 * @param {(event: { stage: string, message: string, glb?: Buffer }) => void | Promise<void>} [onProgress]
 * @returns {Promise<{ glb: Buffer, stl: Buffer }>}
 */
export async function imageToStl(pngBuffer, onProgress = () => {}) {
  const report = (stage, message, extra = {}) => onProgress({ stage, message, ...extra });

  await report('upload', 'Uploading statue image to Tripo3D');
  const imageToken = await uploadImage(pngBuffer);

  await report('model', 'Starting image-to-3D task');
  const modelTaskId = await createTask({ type: 'image_to_model', file: { type: 'png', file_token: imageToken } });
  const output = await waitForTask(modelTaskId, (message) => report('model', message));
  const glbUrl = output.pbr_model ?? output.model ?? output.base_model;
  if (!glbUrl) throw new Error('Tripo3D task finished without a model file');

  await report('download', 'Downloading GLB');
  const glb = await download(glbUrl);
  await report('glb', 'GLB ready', { glb });

  let stl;
  try {
    await report('stl', 'Requesting STL export from Tripo3D');
    stl = await exportStl(modelTaskId, (message) => report('stl', message));
  } catch (err) {
    await report('stl', `Tripo3D STL export unavailable (${err.message}); converting GLB locally`);
    stl = glbToStl(glb);
  }
  return { glb, stl };
}
