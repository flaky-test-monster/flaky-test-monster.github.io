import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Directory that holds one sub-folder per job. The only module-level state in the app. */
export const JOBS_DIR = path.join(import.meta.dirname, '..', 'jobs');

const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INPUT_FILE_PATTERN = /^input\.(png|jpg)$/;
const JOB_FILE_PATTERN = /^(input\.(png|jpg)|statue\.png|lego\.png|model\.glb|model\.json|model\.stl|pipeline\.txt|name\.txt|error\.txt)$/;
const ERROR_FILE = 'error.txt';
const PIPELINE_FILE = 'pipeline.txt';
const NAME_FILE = 'name.txt';
const TMP_SUFFIX = '.tmp';

/** File name -> Content-Type for every file a job folder may contain. */
export const JOB_FILE_TYPES = {
  'input.png': 'image/png',
  'input.jpg': 'image/jpeg',
  'statue.png': 'image/png',
  'lego.png': 'image/png',
  'model.glb': 'model/gltf-binary',
  'model.json': 'application/json; charset=utf-8',
  'pipeline.txt': 'text/plain; charset=utf-8',
  'name.txt': 'text/plain; charset=utf-8',
  'model.stl': 'model/stl',
  'error.txt': 'text/plain; charset=utf-8',
};

/**
 * Checks whether a string is a well-formed job id (UUID v4). Anything else is rejected
 * before it can be used to build a filesystem path.
 * @param {string} id
 * @returns {boolean}
 */
export function isValidJobId(id) {
  return JOB_ID_PATTERN.test(id);
}

/**
 * Returns the absolute folder of a job, throwing on malformed ids.
 * @param {string} id
 * @returns {string}
 */
export function jobDir(id) {
  if (!isValidJobId(id)) throw new Error(`Invalid job id: ${id}`);
  return path.join(JOBS_DIR, id);
}

/**
 * Returns the absolute path of a named file inside a job folder, or null when the name is
 * not one of the known job files. Never resolves outside the job folder.
 * @param {string} id
 * @param {string} name
 * @returns {string | null}
 */
export function resolveJobFile(id, name) {
  if (!isValidJobId(id) || !JOB_FILE_PATTERN.test(name)) return null;
  return path.join(jobDir(id), name);
}

/**
 * Writes a file atomically: the bytes go to a temporary sibling first and are renamed
 * into place, so readers never observe a partially written file.
 * @param {string} filePath
 * @param {Buffer | string} data
 * @returns {Promise<void>}
 */
async function writeAtomic(filePath, data) {
  const tmpPath = filePath + TMP_SUFFIX;
  await writeFile(tmpPath, data);
  await rename(tmpPath, filePath);
}

/**
 * Creates a new job folder and stores the input image, chosen pipeline and name in it.
 * @param {Buffer} inputBuffer raw image bytes
 * @param {'png' | 'jpg'} extension file extension matching the image format
 * @param {string} pipeline pipeline name, e.g. "marble" or "lego"
 * @param {string} [name] optional name the user gave the conversion
 * @returns {Promise<string>} the new job id
 */
export async function createJob(inputBuffer, extension, pipeline, name) {
  const id = randomUUID();
  await mkdir(jobDir(id), { recursive: true });
  await writeJobFile(id, PIPELINE_FILE, pipeline);
  if (name) await writeJobFile(id, NAME_FILE, name);
  await writeJobFile(id, `input.${extension}`, inputBuffer);
  return id;
}

/**
 * Atomically writes one of the known job files (statue.png, model.glb, model.stl, ...).
 * @param {string} id
 * @param {string} name one of the names in JOB_FILE_TYPES
 * @param {Buffer | string} data
 * @returns {Promise<void>}
 */
export async function writeJobFile(id, name, data) {
  const filePath = resolveJobFile(id, name);
  if (!filePath) throw new Error(`Unknown job file name: ${name}`);
  await writeAtomic(filePath, data);
}

/**
 * Records a short, human-readable failure message for a job.
 * @param {string} id
 * @param {string} message
 * @returns {Promise<void>}
 */
export async function writeJobError(id, message) {
  await writeJobFile(id, ERROR_FILE, message);
}

/**
 * Derives the job status from the files present in its folder.
 * Each stage holds the file name when that stage is complete, otherwise null. The image
 * stage is the restyled photo (statue.png or lego.png) and the model stage the
 * intermediate 3D file (model.glb or model.json), depending on the pipeline.
 * @param {string} id
 * @returns {Promise<{ pipeline: string, name: string | null, stages: { input: string | null, image: string | null, model: string | null, stl: string | null }, error: string | null } | null>}
 *   null when the job does not exist
 */
export async function getJobStatus(id) {
  if (!isValidJobId(id)) return null;
  let files;
  try {
    files = await readdir(jobDir(id));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  const has = (name) => (files.includes(name) ? name : null);
  const stages = {
    input: files.find((name) => INPUT_FILE_PATTERN.test(name)) ?? null,
    image: has('statue.png') ?? has('lego.png'),
    model: has('model.glb') ?? has('model.json'),
    stl: has('model.stl'),
  };
  const read = async (name) => (files.includes(name) ? readFile(path.join(jobDir(id), name), 'utf8') : null);
  const error = await read(ERROR_FILE);
  const pipeline = await read(PIPELINE_FILE);
  const name = await read(NAME_FILE);
  return { pipeline, name, stages, error };
}
