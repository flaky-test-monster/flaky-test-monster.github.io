/**
 * Face tracking for the monster scan: MediaPipe Face Landmarker finds the face in every
 * webcam frame, in the browser, and this module also paints the monster's face over the
 * preview: white eyes with small black pupils, and a red tongue in the open mouth.
 */

const TASKS_VISION_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const FACE_MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
/** Most faces tracked at once; more costs speed on every frame. */
const MAX_FACES = 4;
/** Outer and inner corner landmarks of each eye. */
const EYE_CORNERS = [[33, 133], [362, 263]];
/** Circle radius as a share of the corner-to-corner eye width. */
const EYE_RADIUS = 0.8;
/** Pupil radius as a share of the white circle's radius. */
const PUPIL_RADIUS = 0.3;
/** Inner lip contours from mouth corner to mouth corner, left to right. */
const UPPER_INNER_LIP = [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308];
const LOWER_INNER_LIP = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308];
const TONGUE_COLOR = '#e0182d';
/** The preview's poster look at full strength (--poster: 1 in style.css): contrast and brightness. */
const POSTER_CONTRAST = 7;
const POSTER_BRIGHTNESS = 1.15;
/** The green tint over a monster's preview, as in style.css. */
const MONSTER_GREEN = [0x2f, 0xd1, 0x2f];

const $ = (id) => document.getElementById(id);

/** Landmarkers by running mode, loaded once per page, since the model is a few megabytes. */
const landmarkerPromises = {};

/** Loads a face landmarker for 'VIDEO' (follows a face across frames) or 'IMAGE' (single photos). */
function loadLandmarker(runningMode) {
  landmarkerPromises[runningMode] ??= (async () => {
    const { FilesetResolver, FaceLandmarker } = await import(`${TASKS_VISION_URL}/vision_bundle.mjs`);
    const fileset = await FilesetResolver.forVisionTasks(`${TASKS_VISION_URL}/wasm`);
    return FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: FACE_MODEL_URL, delegate: 'GPU' },
      runningMode,
      numFaces: MAX_FACES,
    });
  })().catch((err) => {
    // A failed download should not stick: the next attempt loads again.
    delete landmarkerPromises[runningMode];
    throw err;
  });
  return landmarkerPromises[runningMode];
}

/**
 * Loads the face landmarker for the webcam, or returns the one already loaded.
 * @returns {Promise<{ detectForVideo(video: HTMLVideoElement, time: number): { faceLandmarks: { x: number, y: number }[][] } }>}
 */
export function loadFaceTracker() {
  return loadLandmarker('VIDEO');
}

/**
 * Face landmarks of every face in a photo, for the in-browser figure. It has its own landmarker
 * in image mode: the webcam's follows faces from frame to frame, which would carry over to the
 * photo. A failure (no network, no WebGL) gives no faces: the figure is then made without
 * the face touches.
 * @param {Blob} blob
 * @returns {Promise<{ x: number, y: number, z: number }[][]>} landmarks per face, normalized 0..1
 */
export async function findFaces(blob) {
  try {
    const landmarker = await loadLandmarker('IMAGE');
    const bitmap = await createImageBitmap(blob);
    try {
      return landmarker.detect(bitmap).faceLandmarks.map((face) => face.map(({ x, y, z }) => ({ x, y, z })));
    } finally {
      bitmap.close();
    }
  } catch (err) {
    console.warn('Face landmarks unavailable, making the figure without them:', err);
    return [];
  }
}

/**
 * Paints the monster's face over every face in the preview; an empty list clears them.
 * The canvas matches the video's own size and is fitted and mirrored by the same CSS, so
 * landmark coordinates map straight onto it.
 * @param {HTMLVideoElement} video
 * @param {{ x: number, y: number }[][]} faces landmarks per face, normalized 0..1
 */
export function drawFaces(video, faces) {
  const canvas = $('eyes');
  if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
  }
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (const landmarks of faces) {
    const point = (i) => ({ x: landmarks[i].x * canvas.width, y: landmarks[i].y * canvas.height });
    drawEyes(ctx, point);
    drawMouth(ctx, point);
  }
}

/** One white circle with a black pupil in its middle per eye. */
function drawEyes(ctx, point) {
  for (const [outer, inner] of EYE_CORNERS) {
    const a = point(outer);
    const b = point(inner);
    const radius = Math.hypot(a.x - b.x, a.y - b.y) * EYE_RADIUS;
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc((a.x + b.x) / 2, (a.y + b.y) / 2, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.arc((a.x + b.x) / 2, (a.y + b.y) / 2, radius * PUPIL_RADIUS, 0, Math.PI * 2);
    ctx.fill();
  }
}

/**
 * A red tongue at the bottom of the open mouth, clipped to the inside of the lips.
 */
function drawMouth(ctx, point) {
  const upper = UPPER_INNER_LIP.map(point);
  const lower = LOWER_INNER_LIP.map(point);
  const top = point(13);
  const bottom = point(14);
  const left = upper[0];
  const right = upper.at(-1);
  const gap = Math.hypot(top.x - bottom.x, top.y - bottom.y);

  ctx.save();
  ctx.beginPath();
  for (const p of [...upper, ...lower.toReversed()]) ctx.lineTo(p.x, p.y);
  ctx.closePath();
  ctx.clip();

  ctx.fillStyle = TONGUE_COLOR;
  ctx.beginPath();
  ctx.ellipse(bottom.x, bottom.y, Math.hypot(right.x - left.x, right.y - left.y) * 0.35, gap * 0.45, Math.atan2(right.y - left.y, right.x - left.x), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/**
 * A photo of the preview as it looks at a score of 100: cropped and mirrored like the
 * preview, in the green poster look, with the monster faces painted on.
 * @param {HTMLVideoElement} video
 * @returns {Promise<Blob | null>} a PNG
 */
export function snapshotMonster(video) {
  // The preview fills its frame, cutting off whatever does not fit, so crop the same way.
  const frame = video.parentElement;
  const aspect = frame.clientWidth / frame.clientHeight || 4 / 3;
  let width = video.videoWidth;
  let height = video.videoHeight;
  if (width / height > aspect) width = height * aspect;
  else height = width / aspect;
  const x = (video.videoWidth - width) / 2;
  const y = (video.videoHeight - height) / 2;

  const canvas = Object.assign(document.createElement('canvas'), { width: Math.round(width), height: Math.round(height) });
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.translate(canvas.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(video, x, y, width, height, 0, 0, canvas.width, canvas.height);
  posterize(ctx, canvas.width, canvas.height, { strength: 1, green: true });
  ctx.drawImage($('eyes'), x, y, width, height, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

/**
 * A photo of the whole webcam frame in the look the preview has right now, for Take photo:
 * not cropped or mirrored, like a plain capture, with the poster look at its current
 * strength and the monster faces painted on.
 * @param {HTMLVideoElement} video
 * @param {{ strength: number, green: boolean }} look poster strength 0..1, and the green tint
 * @returns {Promise<Blob | null>} a PNG
 */
export function snapshotPreview(video, look) {
  const canvas = Object.assign(document.createElement('canvas'), { width: video.videoWidth, height: video.videoHeight });
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, 0, 0);
  if (look.strength > 0 || look.green) posterize(ctx, canvas.width, canvas.height, look);
  // The eye canvas has the video's own size, so it lines up unscaled.
  ctx.drawImage($('eyes'), 0, 0);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

/**
 * Turns the picture into the poster like the CSS filters on the preview: grayscale, then
 * contrast and brightness, all by `strength`, then the green multiplied over it.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} width
 * @param {number} height
 * @param {{ strength: number, green: boolean }} look
 */
function posterize(ctx, width, height, { strength, green }) {
  const image = ctx.getImageData(0, 0, width, height);
  const pixels = image.data;
  const clamp = (value) => Math.min(255, Math.max(0, value));
  const contrast = 1 + (POSTER_CONTRAST - 1) * strength;
  const brightness = 1 + (POSTER_BRIGHTNESS - 1) * strength;
  const tint = green ? MONSTER_GREEN.map((c) => c / 255) : [1, 1, 1];
  for (let i = 0; i < pixels.length; i += 4) {
    const gray = 0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2];
    for (let c = 0; c < 3; c++) {
      const value = pixels[i + c] + (gray - pixels[i + c]) * strength;
      pixels[i + c] = clamp(clamp((value - 127.5) * contrast + 127.5) * brightness) * tint[c];
    }
  }
  ctx.putImageData(image, 0, 0);
}
