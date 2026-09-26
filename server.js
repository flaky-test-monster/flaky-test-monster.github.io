import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { makeStatueImage } from './lib/openai.js';
import { imageToStl } from './lib/tripo.js';
import { JOB_FILE_TYPES, createJob, getJobStatus, resolveJobFile, writeJobError, writeJobFile } from './lib/jobs.js';

const PORT = 3000;
const HOST = 'localhost';
const PUBLIC_DIR = path.join(import.meta.dirname, 'public');
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ERROR_MESSAGE_LIMIT = 300;
const REQUIRED_ENV = ['OPENAI_API_KEY', 'TRIPO_API_KEY'];
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
 * Loads .env and verifies the API keys are present. Exits with a clear message otherwise.
 */
function loadConfig() {
  try {
    process.loadEnvFile();
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    console.error('No .env file found. Copy .env.example to .env and add your API keys.');
    process.exit(1);
  }
  const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    console.error(`Missing in .env: ${missing.join(', ')}`);
    process.exit(1);
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
 * Runs photo -> statue -> GLB -> STL for one job, persisting each stage as it completes.
 * @param {string} id
 * @param {Buffer} input
 * @param {'image/png' | 'image/jpeg'} mimeType
 */
async function runPipeline(id, input, mimeType) {
  const log = (message) => console.log(`[${id}] ${message}`);
  try {
    log('Generating statue image');
    const statue = await makeStatueImage(input, mimeType);
    await writeJobFile(id, 'statue.png', statue);
    const { stl } = await imageToStl(statue, async (event) => {
      log(event.message);
      if (event.glb) await writeJobFile(id, 'model.glb', event.glb);
    });
    await writeJobFile(id, 'model.stl', stl);
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

/** POST /api/jobs */
async function createJobRoute(req, res) {
  const mimeType = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  const extension = INPUT_EXTENSIONS[mimeType];
  if (!extension) throw new HttpError(415, 'Send the image as image/png or image/jpeg');
  const input = await readBody(req);
  const id = await createJob(input, extension);
  sendJson(res, 202, { id });
  runPipeline(id, input, mimeType).catch((err) => console.error(`[${id}] Unhandled pipeline error:`, err));
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

loadConfig();
createServer(onRequest).listen(PORT, HOST, () => {
  console.log(`Flakifier running at http://${HOST}:${PORT}`);
});
