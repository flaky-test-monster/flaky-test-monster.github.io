import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_FIGURE, FIGURES } from './lib/figures.js';
import { makeFigureImage, makeFigureScene } from './lib/openai.js';
import { imageToGlbLocal, localUnavailableReason, makeFigureImageLocal } from './lib/local.js';
import { sceneToStl } from './lib/mesh.js';
import { glbToStl } from './lib/stl.js';
import { imageToStl } from './lib/tripo.js';
import { JOB_FILE_TYPES, createJob, deleteJob, getJobStatus, listJobs, resolveJobFile, writeJobError, writeJobFile } from './lib/jobs.js';

const PORT = Number(process.env.PORT) || 3000;
const HOST = 'localhost';
const PUBLIC_DIR = path.join(import.meta.dirname, 'public');
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ERROR_MESSAGE_LIMIT = 300;
const NAME_LIMIT = 60;
const DEFAULT_PIPELINE = 'tripo';
/** Old combined style names, still accepted from older pages and scripts. */
const LEGACY_PIPELINES = { marble: 'tripo', lego: 'shapes' };
const INPUT_EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg' };
/** Pipeline of a run that only holds a monster scan photo and never converts it. */
const PHOTO_PIPELINE = 'photo';
const PHOTO_NAME = 'Monster photo';
const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};
const DEFAULT_TYPE = 'application/octet-stream';

/** Ids of the jobs this process is working on. A job that is neither finished, failed nor
 * in here was cut off by a server restart and will never finish. */
const runningJobs = new Set();

/** HTTP error carrying the status code to respond with. */
class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Returns an availability check that reports env variables which are not set.
 * @param {string[]} keys
 * @returns {() => Promise<string | null>}
 */
const requireEnv = (keys) => async () => {
  const missing = keys.filter((key) => !process.env[key]);
  return missing.length > 0 ? `This pipeline needs ${missing.join(', ')} in .env` : null;
};

/**
 * The ways a figure image becomes an STL. unavailable() explains why a pipeline cannot run
 * (or returns null), and run() persists its stages as job files.
 * @type {Record<string, { unavailable: () => Promise<string | null>, run: (id: string, input: Buffer, mimeType: string, figure: import('./lib/figures.js').Figure, log: (message: string) => void) => Promise<void> }>}
 */
const PIPELINES = {
  // photo -> figure image (OpenAI) -> Tripo3D GLB -> STL
  tripo: {
    unavailable: requireEnv(['OPENAI_API_KEY', 'TRIPO_API_KEY']),
    async run(id, input, mimeType, figure, log) {
      log(`Generating ${figure.label} image`);
      const image = await makeFigureImage(input, mimeType, figure);
      await writeJobFile(id, 'figure.png', image);
      const { stl } = await imageToStl(image, async (event) => {
        log(event.message);
        if (event.glb) await writeJobFile(id, 'model.glb', event.glb);
      });
      await writeJobFile(id, 'model.stl', stl);
    },
  },
  // photo -> figure image (OpenAI) -> GPT shape list -> STL, OpenAI only
  shapes: {
    unavailable: requireEnv(['OPENAI_API_KEY']),
    async run(id, input, mimeType, figure, log) {
      log(`Generating ${figure.label} image`);
      const image = await makeFigureImage(input, mimeType, figure);
      await writeJobFile(id, 'figure.png', image);
      log('Generating 3D model');
      const scene = await makeFigureScene(image, figure);
      await writeJobFile(id, 'model.json', JSON.stringify(scene, null, 2));
      log(`Building STL from ${scene.parts?.length ?? 0} parts`);
      await writeJobFile(id, 'model.stl', sceneToStl(scene));
    },
  },
  // photo -> figure image (FLUX.1 Kontext) -> GLB (pixal3d.cpp) -> STL, all on this Mac
  local: {
    unavailable: localUnavailableReason,
    async run(id, input, mimeType, figure, log) {
      log(`Generating ${figure.label} image with FLUX.1 Kontext`);
      const image = await makeFigureImageLocal(resolveJobFile(id, `input.${INPUT_EXTENSIONS[mimeType]}`), figure);
      await writeJobFile(id, 'figure.png', image);
      log('Generating 3D model with the local trellis-server');
      const glb = await imageToGlbLocal(image);
      await writeJobFile(id, 'model.glb', glb);
      log('Converting GLB to STL');
      await writeJobFile(id, 'model.stl', glbToStl(glb));
    },
  },
};

/**
 * Loads .env when present and reports which pipelines cannot run yet. The server starts
 * regardless: the local pipeline needs no keys, and its tools may be started later.
 */
async function loadConfig() {
  try {
    process.loadEnvFile();
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    console.warn('No .env file found; only the local pipeline can run. See .env.example.');
  }
  for (const [name, pipeline] of Object.entries(PIPELINES)) {
    const reason = await pipeline.unavailable();
    if (reason) console.warn(`Pipeline "${name}" unavailable: ${reason}`);
  }
}

/**
 * Sends a JSON response.
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/**
 * Reads a file from disk and sends it, mapping a missing file to 404.
 * @param {import('node:http').ServerResponse} res
 * @param {string} filePath
 * @param {string} contentType
 * @param {string} [downloadName] when set, the file is sent as an attachment
 */
async function sendFile(res, filePath, contentType, downloadName) {
  let data;
  try {
    data = await readFile(filePath);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EISDIR') throw new HttpError(404, 'Not found');
    throw err;
  }
  const headers = { 'Content-Type': contentType, 'Content-Length': data.length };
  if (downloadName) headers['Content-Disposition'] = `attachment; filename="${downloadName}"`;
  res.writeHead(200, headers);
  res.end(data);
}

/**
 * Buffers the request body, rejecting anything larger than the limit.
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<Buffer>}
 */
async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_UPLOAD_BYTES) throw new HttpError(413, 'Image is larger than 10 MB');
    chunks.push(chunk);
  }
  if (size === 0) throw new HttpError(400, 'Request body is empty');
  return Buffer.concat(chunks);
}

/**
 * Trims an error into a one-line message suitable for error.txt.
 * @param {unknown} err
 * @returns {string}
 */
function shortMessage(err) {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/\s+/g, ' ').trim().slice(0, ERROR_MESSAGE_LIMIT) || 'Unknown error';
}

/**
 * Runs the chosen pipeline for one job, recording a failure in error.txt.
 * @param {string} id
 * @param {string} pipeline key of PIPELINES
 * @param {string} figure key of FIGURES
 * @param {Buffer} input
 * @param {'image/png' | 'image/jpeg'} mimeType
 */
async function runPipeline(id, pipeline, figure, input, mimeType) {
  const log = (message) => console.log(`[${id}] ${message}`);
  runningJobs.add(id);
  try {
    log(`Running ${pipeline} pipeline for a ${FIGURES[figure].label}`);
    await PIPELINES[pipeline].run(id, input, mimeType, FIGURES[figure], log);
    log('Done');
  } catch (err) {
    console.error(`[${id}] Pipeline failed:`, err);
    await writeJobError(id, shortMessage(err));
  } finally {
    runningJobs.delete(id);
  }
}

/**
 * Adds whether the job is still running in this process to its stored status.
 * @param {NonNullable<Awaited<ReturnType<typeof getJobStatus>>>} status
 */
function withRunning(status) {
  return { ...status, running: runningJobs.has(status.id) };
}

/**
 * Cleans the user-given job name: no control characters, single spaces, bounded length.
 * @param {string | null} raw
 * @returns {string}
 */
function cleanName(raw) {
  return (raw ?? '').replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/g, ' ').trim().slice(0, NAME_LIMIT);
}

/**
 * Turns a job name into an ASCII file name prefix, e.g. "Zoë's bust" -> "zoes-bust".
 * @param {string | null} name
 * @returns {string} the slug, or "flakifier" when nothing usable is left
 */
function fileSlug(name) {
  const slug = (name ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'flakifier';
}

/** GET / */
async function serveIndex(req, res) {
  await sendFile(res, path.join(PUBLIC_DIR, 'index.html'), STATIC_TYPES['.html']);
}

/** GET /browser: the in-browser pipeline page, which loads its files relative to /public/ */
async function redirectBrowser(req, res) {
  res.writeHead(302, { Location: '/public/browser.html' });
  res.end();
}

/** GET /public/* */
async function serveStatic(req, res, url, [, relative]) {
  const filePath = path.resolve(PUBLIC_DIR, relative);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(400, 'Invalid path');
  const contentType = STATIC_TYPES[path.extname(filePath).toLowerCase()] ?? DEFAULT_TYPE;
  await sendFile(res, filePath, contentType);
}

/** POST /api/jobs?pipeline=tripo|shapes|local&figure=<key of FIGURES>&name=... */
async function createJobRoute(req, res, url) {
  const mimeType = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  const extension = INPUT_EXTENSIONS[mimeType];
  if (!extension) throw new HttpError(415, 'Send the image as image/png or image/jpeg');
  const requested = url.searchParams.get('pipeline') || DEFAULT_PIPELINE;
  const pipeline = LEGACY_PIPELINES[requested] ?? requested;
  if (!Object.hasOwn(PIPELINES, pipeline)) throw new HttpError(400, `Unknown pipeline: ${requested}`);
  const figure = url.searchParams.get('figure') || (requested === 'lego' ? 'lego' : DEFAULT_FIGURE);
  if (!Object.hasOwn(FIGURES, figure)) throw new HttpError(400, `Unknown figure: ${figure}`);
  const reason = await PIPELINES[pipeline].unavailable();
  if (reason) throw new HttpError(400, reason);
  const input = await readBody(req);
  const id = await createJob(input, extension, pipeline, figure, cleanName(url.searchParams.get('name')));
  sendJson(res, 202, { id });
  runPipeline(id, pipeline, figure, input, mimeType).catch((err) => console.error(`[${id}] Unhandled pipeline error:`, err));
}

/**
 * Reads a monster scan photo from the request, which must be a PNG.
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<Buffer>}
 */
async function readPhoto(req) {
  const mimeType = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (mimeType !== 'image/png') throw new HttpError(415, 'Send the photo as image/png');
  return readBody(req);
}

/** POST /api/photos: stores a monster scan photo as a run of its own, without converting it. */
async function createPhotoRoute(req, res) {
  const id = await createJob(await readPhoto(req), 'png', PHOTO_PIPELINE, DEFAULT_FIGURE, PHOTO_NAME);
  sendJson(res, 201, { id });
}

/** GET /api/figures: the figure presets the page offers, without their prompts. */
async function listFiguresRoute(req, res) {
  sendJson(res, 200, { figures: Object.entries(FIGURES).map(([id, { label }]) => ({ id, label })), default: DEFAULT_FIGURE });
}

/** GET /api/jobs */
async function listJobsRoute(req, res) {
  sendJson(res, 200, { jobs: (await listJobs()).map(withRunning) });
}

/** GET /api/jobs/:id */
async function jobStatusRoute(req, res, url, [, id]) {
  const status = await getJobStatus(id);
  if (!status) throw new HttpError(404, 'Job not found');
  sendJson(res, 200, withRunning(status));
}

/** DELETE /api/jobs/:id */
async function deleteJobRoute(req, res, url, [, id]) {
  // A running pipeline would recreate files in the folder as it goes.
  if (runningJobs.has(id)) throw new HttpError(409, 'This conversion is still running');
  if (!(await deleteJob(id))) throw new HttpError(404, 'Job not found');
  res.writeHead(204);
  res.end();
}

/** GET /api/jobs/:id/:file */
async function jobFileRoute(req, res, url, [, id, name]) {
  const filePath = resolveJobFile(id, name);
  if (!filePath) throw new HttpError(404, 'Not found');
  const download = url.searchParams.get('download') === '1';
  const prefix = download ? fileSlug((await getJobStatus(id))?.name) : null;
  await sendFile(res, filePath, JOB_FILE_TYPES[name], download ? `${prefix}-${name}` : undefined);
}

const ROUTES = [
  { pattern: /^\/$/, handlers: { GET: serveIndex } },
  { pattern: /^\/browser\/?$/, handlers: { GET: redirectBrowser } },
  { pattern: /^\/public\/(.+)$/, handlers: { GET: serveStatic } },
  { pattern: /^\/api\/figures$/, handlers: { GET: listFiguresRoute } },
  { pattern: /^\/api\/jobs$/, handlers: { GET: listJobsRoute, POST: createJobRoute } },
  { pattern: /^\/api\/jobs\/([^/]+)$/, handlers: { GET: jobStatusRoute, DELETE: deleteJobRoute } },
  { pattern: /^\/api\/jobs\/([^/]+)\/([^/]+)$/, handlers: { GET: jobFileRoute } },
  { pattern: /^\/api\/photos$/, handlers: { POST: createPhotoRoute } },
];

/**
 * Matches the request against ROUTES and runs the handler, translating errors to
 * HTTP status codes.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
async function handle(req, res) {
  const url = new URL(req.url, `http://${HOST}`);
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    throw new HttpError(400, 'Malformed URL');
  }
  if (pathname.includes('\0') || pathname.split('/').includes('..')) throw new HttpError(400, 'Invalid path');
  for (const route of ROUTES) {
    const match = pathname.match(route.pattern);
    if (!match) continue;
    const handler = route.handlers[req.method];
    if (!handler) {
      res.setHeader('Allow', Object.keys(route.handlers).join(', '));
      throw new HttpError(405, 'Method not allowed');
    }
    return handler(req, res, url, match);
  }
  throw new HttpError(404, 'Not found');
}

/**
 * Entry point for every request.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
async function onRequest(req, res) {
  try {
    await handle(req, res);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(`${req.method} ${req.url} failed:`, err);
    if (res.headersSent) return res.end();
    sendJson(res, status, { error: status === 500 ? 'Internal server error' : err.message });
  }
}

await loadConfig();
createServer(onRequest).listen(PORT, HOST, () => {
  console.log(`Flakifier running at http://${HOST}:${PORT}`);
});
