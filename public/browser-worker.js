// Runs the in-browser pipeline off the main thread: background removal (MODNet), depth
// estimation (Depth Anything V2 Small) and the relief mesher. Models are downloaded from
// the Hugging Face Hub on first use and cached by the browser for later runs.
import { env, pipeline } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js';
import { reliefToStl } from './relief.js';

const CUTOUT_MODEL = 'Xenova/modnet';
const DEPTH_MODEL = 'onnx-community/depth-anything-v2-small';
/** Longest side the models see; larger photos are scaled down first. */
const MAX_INPUT_PX = 1024;

env.allowLocalModels = false;

/** @type {Promise<{ cutout: Function, depth: Function, device: string }> | null} */
let modelsPromise = null;

/** Posts a progress message to the page. */
const report = (message) => postMessage({ type: 'progress', ...message });

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

/** photo -> cut-out (MODNet) -> depth (Depth Anything V2) -> relief STL. */
async function run({ blob, options }) {
  const models = await loadModels();
  report({ stage: 'input', device: models.device });
  const photo = await decodePhoto(blob);

  report({ stage: 'cutout' });
  const [cut] = await models.cutout(photo.canvas);
  const rgba = cut.rgba().data;
  const alpha = new Uint8Array(photo.width * photo.height);
  for (let p = 0; p < alpha.length; p++) alpha[p] = rgba[p * 4 + 3];
  const cutoutPng = await rgbaToPng(rgba, photo.width, photo.height);
  postMessage({ type: 'stage', stage: 'cutout', file: cutoutPng });

  report({ stage: 'depth' });
  const { predicted_depth } = await models.depth(photo.canvas);
  const depth = Float32Array.from(predicted_depth.data);
  const depthPng = await depthToPng(depth, alpha, photo.width, photo.height);
  postMessage({ type: 'stage', stage: 'depth', file: depthPng });

  report({ stage: 'stl' });
  const { stl, triangles } = reliefToStl({ width: photo.width, height: photo.height, alpha, depth }, options);
  postMessage({ type: 'stage', stage: 'stl', file: new Blob([stl], { type: 'model/stl' }), triangles });
}

self.addEventListener('message', async (event) => {
  try {
    await run(event.data);
    postMessage({ type: 'done' });
  } catch (err) {
    postMessage({ type: 'error', message: err?.message ?? String(err) });
  }
});
