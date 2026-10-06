// Local, offline counterparts of the OpenAI + Tripo3D steps: FLUX.1 Kontext via the mflux
// CLI for the figure image, and a pixal3d.cpp `trellis-server` for image-to-3D.
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const MFLUX_TIMEOUT_MS = 60 * 60 * 1000;
const LOCAL_3D_TIMEOUT_MS = 60 * 60 * 1000;
const HEALTH_TIMEOUT_MS = 2000;
const STDERR_TAIL_CHARS = 300;

/**
 * Reads the local pipeline settings. Read per call rather than at import, because
 * server.js loads .env only after its imports have run.
 */
function settings() {
  // LOCAL_FAST=1 trades image quality for speed (about 10x less work) when testing the
  // pipeline. The 3D step already runs at trellis-server's lowest resolution.
  const fast = process.env.LOCAL_FAST === '1';
  return {
    mfluxCommand: process.env.MFLUX_COMMAND ?? 'mflux-generate-kontext',
    mfluxQuantize: process.env.MFLUX_QUANTIZE ?? '8',
    // LOCAL_LORAS=0 runs every figure on plain FLUX.1 Kontext, without its style LoRA.
    loras: process.env.LOCAL_LORAS !== '0',
    mfluxSteps: fast ? '8' : '20',
    mfluxSize: fast ? '512' : '1024',
    url: process.env.LOCAL_3D_URL ?? 'http://127.0.0.1:8080',
    resolution: process.env.LOCAL_3D_RESOLUTION ?? '512',
  };
}

/**
 * Runs a command, resolving when it exits with status 0. Only the tail of stderr is kept,
 * since mflux prints long progress bars there.
 * @param {string} command
 * @param {string[]} args
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
function run(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], timeout: timeoutMs });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS); });
    child.on('error', (err) => {
      reject(err.code === 'ENOENT' ? new Error(`${command} not found; install mflux (see README)`) : err);
    });
    child.on('close', (code, signal) => {
      if (code === 0) return resolve();
      reject(new Error(`${command} failed (${signal ?? `exit ${code}`}): ${stderr.trim()}`));
    });
  });
}

/**
 * Turns a portrait photo into the chosen kind of figure with FLUX.1 Kontext, run through
 * mflux, with the figure's style LoRA when it has one. Kontext takes only the photo, so a
 * figure's reference image is not used here. The first run downloads about 34 GB of weights.
 * A figure with a LoRA uses `localPrompt` only together with it; without the LoRA the
 * LoRA's trigger sentence would mean nothing, so the OpenAI prompt is used instead.
 * @param {string} inputPath path of the source photo
 * @param {import('./figures.js').Figure} figure
 * @returns {Promise<Buffer>} PNG bytes of the figure image
 */
export async function makeFigureImageLocal(inputPath, figure) {
  const dir = await mkdtemp(path.join(tmpdir(), 'flakifier-'));
  const output = path.join(dir, 'figure.png');
  const { mfluxCommand, mfluxQuantize, mfluxSteps, mfluxSize, loras } = settings();
  const lora = loras ? figure.localLora : undefined;
  const prompt = figure.localLora && !lora ? figure.prompt : figure.localPrompt ?? figure.prompt;
  try {
    await run(mfluxCommand, [
      '--image-path', inputPath,
      '--prompt', prompt,
      ...(lora ? ['--lora-paths', lora.path, '--lora-scales', String(lora.scale)] : []),
      '--steps', mfluxSteps,
      '--width', mfluxSize,
      '--height', mfluxSize,
      '-q', mfluxQuantize,
      '--output', output,
    ], MFLUX_TIMEOUT_MS);
    // mflux exits 0 even when generation stops early, so a missing file is the failure signal.
    return await readFile(output).catch(() => {
      throw new Error(`${mfluxCommand} finished without writing an image`);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Sends a request with node:http and buffers the response. Used instead of fetch, whose
 * 5-minute header timeout is shorter than a local 3D generation.
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string, string>, body?: Buffer, timeoutMs: number }} options
 * @returns {Promise<{ status: number, body: Buffer }>}
 */
function httpRequest(url, { method = 'GET', headers = {}, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`Request to ${url} timed out`)));
    req.on('error', reject);
    req.end(body);
  });
}

/**
 * Turns the statue image into a GLB with a pixal3d.cpp trellis-server. The request blocks
 * until the model is finished, which takes several minutes.
 * @param {Buffer} png statue image
 * @returns {Promise<Buffer>} GLB bytes
 */
export async function imageToGlbLocal(png) {
  const { url, resolution } = settings();
  const form = new FormData();
  form.append('image', new Blob([png], { type: 'image/png' }), 'statue.png');
  form.append('resolution', resolution);
  // Let the platform encode the multipart body, then send it without fetch's timeouts.
  const encoded = new Request(url, { method: 'POST', body: form });
  const { status, body } = await httpRequest(`${url}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': encoded.headers.get('content-type') },
    body: Buffer.from(await encoded.arrayBuffer()),
    timeoutMs: LOCAL_3D_TIMEOUT_MS,
  });
  if (status !== 200) {
    let message = body.toString('utf8').slice(0, STDERR_TAIL_CHARS);
    try {
      message = JSON.parse(message).error ?? message;
    } catch {
      // Not JSON; keep the raw text.
    }
    throw new Error(`Local 3D server failed (${status}): ${message}`);
  }
  return body;
}

/**
 * Explains why the local pipeline cannot run right now, or returns null when it can.
 * @returns {Promise<string | null>}
 */
export async function localUnavailableReason() {
  const { mfluxCommand, url } = settings();
  try {
    const { status } = await httpRequest(`${url}/health`, { timeoutMs: HEALTH_TIMEOUT_MS });
    if (status !== 200) return `Local 3D server at ${url} is not healthy (${status})`;
  } catch {
    return `Local 3D server is not running at ${url}; start trellis-server (see README)`;
  }
  try {
    await run('which', [mfluxCommand], HEALTH_TIMEOUT_MS);
  } catch {
    return `${mfluxCommand} not found on PATH; install mflux (see README)`;
  }
  return null;
}
