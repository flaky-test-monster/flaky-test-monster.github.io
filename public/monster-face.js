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

const $ = (id) => document.getElementById(id);

/** Loaded once per page, since the model is a few megabytes. */
let landmarkerPromise = null;

/**
 * Loads the face landmarker, or returns the one already loaded.
 * @returns {Promise<{ detectForVideo(video: HTMLVideoElement, time: number): { faceLandmarks: { x: number, y: number }[][] } }>}
 */
export function loadFaceTracker() {
  landmarkerPromise ??= (async () => {
    const { FilesetResolver, FaceLandmarker } = await import(`${TASKS_VISION_URL}/vision_bundle.mjs`);
    const fileset = await FilesetResolver.forVisionTasks(`${TASKS_VISION_URL}/wasm`);
    return FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: FACE_MODEL_URL, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numFaces: MAX_FACES,
    });
  })().catch((err) => {
    // A failed download should not stick: the next attempt loads again.
    landmarkerPromise = null;
    throw err;
  });
  return landmarkerPromise;
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
