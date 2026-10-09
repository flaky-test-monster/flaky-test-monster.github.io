// Runs the in-browser pipeline off the main thread: background removal (MODNet), depth
// estimation (Depth Anything V2 Small), the face touches from caricature.js and the relief
// mesher. The page finds the face landmarks (MediaPipe) and sends them along with the photo. Models are downloaded from
// the Hugging Face Hub on first use and cached by the browser for later runs.
import { env, pipeline } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js';
import { applyWarp, caricatureWarp, faceLift, largestFace, monsterParts } from './caricature.js';
import { reliefToStl } from './relief.js';

const CUTOUT_MODEL = 'Xenova/modnet';
const DEPTH_MODEL = 'onnx-community/depth-anything-v2-small';
/** Longest side the models see; larger photos are scaled down first. */
const MAX_INPUT_PX = 1024;
/** The figure that gets the caricature and the monster parts; it is built as a relief. */
const MONSTER_FIGURE = 'monster';

env.allowLocalModels = false;

/** @type {Promise<{ cutout: Function, depth: Function, device: string }> | null} */
let modelsPromise = null;

/** Number of the run being worked on, sent back with every message so the page can drop stale ones. */
let currentRun = null;
/** Posts a message to the page, tagged with the current run. */
const send = (message) => postMessage({ ...message, run: currentRun });
/** Posts a progress message to the page. */
const report = (message) => send({ type: 'progress', ...message });

/**
 * Creates one pipeline on WebGPU when available, falling back to WebAssembly (CPU).
 * @param {string} task
 * @param {string} model
 */
async function createPipeline(task, model) {
  const progress_callback = (event) => {
    if (event.status === 'progress') report({ stage: 'download', file: `${model}/${event.file}`, loaded: event.loaded, total: event.total });
  };
  if (navigator.gpu) {
    try {
      return { run: await pipeline(task, model, { device: 'webgpu', dtype: 'fp32', progress_callback }), device: 'webgpu' };
    } catch (err) {
      console.warn(`WebGPU unavailable for ${model}, using WebAssembly:`, err);
    }
  }
  return { run: await pipeline(task, model, { device: 'wasm', dtype: 'fp32', progress_callback }), device: 'wasm' };
}

/** Loads both models once per worker. A failed load is retried on the next run. */
function loadModels() {
  modelsPromise ??= (async () => {
    report({ stage: 'loading' });
    const cutout = await createPipeline('background-removal', CUTOUT_MODEL);
    const depth = await createPipeline('depth-estimation', DEPTH_MODEL);
    return { cutout: cutout.run, depth: depth.run, device: depth.device };
  })().catch((err) => {
    modelsPromise = null;
    throw err;
  });
  return modelsPromise;
}

/** Decodes the photo, scaled down so its longest side is at most MAX_INPUT_PX. */
async function decodePhoto(blob) {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, MAX_INPUT_PX / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale), height = Math.round(bitmap.height * scale);
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return { canvas, width, height };
}

/** PNG of RGBA pixels. */
async function rgbaToPng(data, width, height) {
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0);
  return canvas.convertToBlob({ type: 'image/png' });
}

/** Grey PNG of a depth map, brighter where closer, transparent outside the subject. */
function depthToPng(depth, alpha, width, height) {
  let min = Infinity, max = -Infinity;
  for (const value of depth) { if (value < min) min = value; if (value > max) max = value; }
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const grey = ((depth[p] - min) / (max - min || 1)) * 255;
    rgba.set([grey, grey, grey, alpha[p]], p * 4);
  }
  return rgbaToPng(rgba, width, height);
}

/**
 * photo -> cut-out (MODNet) -> depth (Depth Anything V2) -> face touches -> relief STL.
 * With face landmarks, the face's real shape is added on top of the depth map; the monster figure
 * is also warped into a bobblehead caricature and gets googly eyes, a tongue, fangs and horns.
 */
async function run({ blob, options, faces }) {
  const models = await loadModels();
  report({ stage: 'input', device: models.device });
  const photo = await decodePhoto(blob);
  const face = largestFace(faces, photo.width, photo.height);
  const monster = options.shape === MONSTER_FIGURE;
  const warp = monster && face ? caricatureWarp(photo.width, photo.height, face) : null;
  // The size of the picture the mesher gets: larger than the photo when warped.
  const width = warp?.width ?? photo.width, height = warp?.height ?? photo.height;

  report({ stage: 'cutout' });
  const [cut] = await models.cutout(photo.canvas);
  const photoRgba = cut.rgba().data;
  const rgba = warp ? applyWarp(photoRgba, photo.width, photo.height, 4, warp) : photoRgba;
  const alphaOf = (pixels) => Uint8Array.from({ length: pixels.length / 4 }, (_, p) => pixels[p * 4 + 3]);
  const alpha = alphaOf(rgba);
  const cutoutPng = await rgbaToPng(rgba, width, height);
  send({ type: 'stage', stage: 'cutout', file: cutoutPng });

  report({ stage: 'depth' });
  const { predicted_depth } = await models.depth(photo.canvas);
  let depth = Float32Array.from(predicted_depth.data);
  if (depth.length !== photo.width * photo.height) throw new Error('The depth map does not match the photo size');
  if (warp) depth = applyWarp(depth, photo.width, photo.height, 1, warp);
  const depthPng = await depthToPng(depth, alpha, width, height);
  send({ type: 'stage', stage: 'depth', file: depthPng });

  report({ stage: 'stl' });
  // Landmarks where they are in the picture the mesher gets, warped or not.
  const placed = warp?.face ?? face;
  const lift = placed ? faceLift({ width, height, alpha }, placed) : undefined;
  const parts = warp ? monsterParts(placed, { width, height, alpha }) : [];
  const shape = monster ? 'relief' : options.shape;
  const { stl, triangles } = reliefToStl({ width, height, alpha, depth, lift, parts }, { ...options, shape });
  send({ type: 'stage', stage: 'stl', file: new Blob([stl], { type: 'model/stl' }), triangles });
}

self.addEventListener('message', async (event) => {
  currentRun = event.data.run;
  try {
    await run(event.data);
    send({ type: 'done' });
  } catch (err) {
    send({ type: 'error', message: err?.message ?? String(err) });
  }
});
