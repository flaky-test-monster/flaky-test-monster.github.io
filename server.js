import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { makeFigureScene, makeLegoImage, makeStatueImage } from './lib/openai.js';
import { imageToGlbLocal, localUnavailableReason, makeStatueImageLocal } from './lib/local.js';
import { sceneToStl } from './lib/mesh.js';
import { glbToStl } from './lib/stl.js';
import { imageToStl } from './lib/tripo.js';
import { JOB_FILE_TYPES, createJob, getJobStatus, resolveJobFile, writeJobError, writeJobFile } from './lib/jobs.js';

const PORT = Number(process.env.PORT) || 3000;
const HOST = 'localhost';
const PUBLIC_DIR = path.join(import.meta.dirname, 'public');
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ERROR_MESSAGE_LIMIT = 300;
const DEFAULT_PIPELINE = 'marble';
const INPUT_EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg' };
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
 * The ways a photo can become an STL. unavailable() explains why a pipeline cannot run
 * (or returns null), and run() persists its stages as job files.
 * @type {Record<string, { unavailable: () => Promise<string | null>, run: (id: string, input: Buffer, mimeType: string, log: (message: string) => void) => Promise<void> }>}
 */
const PIPELINES = {
  // photo -> marble statue image -> Tripo3D GLB -> STL
  marble: {
    unavailable: requireEnv(['OPENAI_API_KEY', 'TRIPO_API_KEY']),
    async run(id, input, mimeType, log) {
      log('Generating statue image');
      const statue = await makeStatueImage(input, mimeType);
      await writeJobFile(id, 'statue.png', statue);
      const { stl } = await imageToStl(statue, async (event) => {
        log(event.message);
        if (event.glb) await writeJobFile(id, 'model.glb', event.glb);
      });
      await writeJobFile(id, 'model.stl', stl);
    },
  },
  // photo -> LEGO minifigure image -> GPT shape list -> STL, OpenAI only
  lego: {
    unavailable: requireEnv(['OPENAI_API_KEY']),
    async run(id, input, mimeType, log) {
      log('Generating LEGO image');
      const lego = await makeLegoImage(input, mimeType);
      await writeJobFile(id, 'lego.png', lego);
      log('Generating 3D model');
      const scene = await makeFigureScene(lego);
      await writeJobFile(id, 'model.json', JSON.stringify(scene, null, 2));
      log(`Building STL from ${scene.parts?.length ?? 0} parts`);
      await writeJobFile(id, 'model.stl', sceneToStl(scene));
    },
  },
  // photo -> marble statue image (FLUX.1 Kontext) -> GLB (pixal3d.cpp) -> STL, all on this Mac
  local: {
    unavailable: localUnavailableReason,
    async run(id, input, mimeType, log) {
      log('Generating statue image with FLUX.1 Kontext');
      const statue = await makeStatueImageLocal(resolveJobFile(id, `input.${INPUT_EXTENSIONS[mimeType]}`));
      await writeJobFile(id, 'statue.png', statue);
      log('Generating 3D model with the local trellis-server');
      const glb = await imageToGlbLocal(statue);
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
 * @param {Buffer} input
 * @param {'image/png' | 'image/jpeg'} mimeType
 */
async function runPipeline(id, pipeline, input, mimeType) {
  const log = (message) => console.log(`[${id}] ${message}`);
  try {
    log(`Running ${pipeline} pipeline`);
    await PIPELINES[pipeline].run(id, input, mimeType, log);
    log('Done');
  } catch (err) {
    console.error(`[${id}] Pipeline failed:`, err);
    await writeJobError(id, shortMessage(err));
  }
}

/** GET / */
async function serveIndex(req, res) {
  await sendFile(res, path.join(PUBLIC_DIR, 'index.html'), STATIC_TYPES['.html']);
}

/** GET /public/* */
async function serveStatic(req, res, url, [, relative]) {
  const filePath = path.resolve(PUBLIC_DIR, relative);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(400, 'Invalid path');
  const contentType = STATIC_TYPES[path.extname(filePath).toLowerCase()] ?? DEFAULT_TYPE;
  await sendFile(res, filePath, contentType);
}

/** POST /api/jobs?pipeline=marble|lego|local */
async function createJobRoute(req, res, url) {
  const mimeType = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  const extension = INPUT_EXTENSIONS[mimeType];
  if (!extension) throw new HttpError(415, 'Send the image as image/png or image/jpeg');
  const pipeline = url.searchParams.get('pipeline') || DEFAULT_PIPELINE;
  if (!Object.hasOwn(PIPELINES, pipeline)) throw new HttpError(400, `Unknown pipeline: ${pipeline}`);
  const reason = await PIPELINES[pipeline].unavailable();
  if (reason) throw new HttpError(400, reason);
  const input = await readBody(req);
  const id = await createJob(input, extension, pipeline);
  sendJson(res, 202, { id });
  runPipeline(id, pipeline, input, mimeType).catch((err) => console.error(`[${id}] Unhandled pipeline error:`, err));
}

/** GET /api/jobs/:id */
async function jobStatusRoute(req, res, url, [, id]) {
  const status = await getJobStatus(id);
  if (!status) throw new HttpError(404, 'Job not found');
  sendJson(res, 200, status);
}

/** GET /api/jobs/:id/:file */
async function jobFileRoute(req, res, url, [, id, name]) {
  const filePath = resolveJobFile(id, name);
  if (!filePath) throw new HttpError(404, 'Not found');
  const download = url.searchParams.get('download') === '1';
  await sendFile(res, filePath, JOB_FILE_TYPES[name], download ? `flakifier-${name}` : undefined);
}

const ROUTES = [
  { pattern: /^\/$/, handlers: { GET: serveIndex } },
  { pattern: /^\/public\/(.+)$/, handlers: { GET: serveStatic } },
  { pattern: /^\/api\/jobs$/, handlers: { POST: createJobRoute } },
  { pattern: /^\/api\/jobs\/([^/]+)$/, handlers: { GET: jobStatusRoute } },
  { pattern: /^\/api\/jobs\/([^/]+)\/([^/]+)$/, handlers: { GET: jobFileRoute } },
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
