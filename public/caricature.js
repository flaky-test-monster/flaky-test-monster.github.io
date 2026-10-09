// Makes the in-browser figure funnier with the face landmarks MediaPipe finds in the photo:
// it measures how far the real face stands out, for the flat depth map, warps the picture into a caricature
// (a bobblehead with bigger eyes, nose and mouth), and says where the monster parts go:
// googly eyes, a tongue, fangs and horns, which public/relief.js builds into the STL.
// Pure functions on pixel arrays, no DOM, so it runs in the worker and in Node.

/** Landmarks of MediaPipe Face Landmarker (478 points, normalised 0..1, z smaller is closer). */
const EYES = [[33, 133], [362, 263]];
const NOSE_TIP = 1;
const MOUTH_LEFT = 61;
const MOUTH_RIGHT = 291;
const UPPER_LIP = 13;
const LOWER_LIP = 14;
const FOREHEAD = 10;
const CHIN = 152;
const CHEEKS = [234, 454];

/** Share of the face's real depth it stands out by: a relief is flatter than the real thing. */
const FACE_LIFT = 0.3;
/** Spread of each landmark's influence on the face depth, as a share of the face height. */
const FACE_DEPTH_SIGMA = 0.05;

/** Bobblehead: how much bigger the head gets, and its radius as a share of the face height. */
const HEAD_ZOOM = 1.5;
const HEAD_RADIUS = 0.8;
/** How far above the face middle the head's middle sits, for the hair, as a share of the face height. */
const HEAD_LIFT = 0.15;
/** Width of the band where the zoom fades out to the untouched body, as a share of the face height. */
const HEAD_FADE = 0.9;
/** Feature zooms, and their radius as a share of the eye width, face width or mouth width. */
const EYE_ZOOM = 1.6;
const EYE_RADIUS = 0.6;
const NOSE_ZOOM = 1.5;
const NOSE_RADIUS = 0.16;
const MOUTH_ZOOM = 1.4;
const MOUTH_RADIUS = 0.5;
/** Each feature zoom fades out over this many times its radius. */
const FEATURE_FADE = 1.2;

/**
 * The largest face of a detection, as pixel coordinates.
 * @param {{ x: number, y: number, z: number }[][]} faces landmarks per face, normalised 0..1
 * @returns {{ x: number, y: number, z: number }[] | null} z is in pixels too, smaller is closer
 */
export function largestFace(faces, width, height) {
  let best = null, bestWidth = 0;
  for (const face of faces ?? []) {
    const [a, b] = CHEEKS.map((i) => face[i]);
    if (!a || !b) continue;
    const faceWidth = Math.abs(a.x - b.x) * width;
    if (faceWidth > bestWidth) { best = face; bestWidth = faceWidth; }
  }
  return best && best.map(({ x, y, z }) => ({ x: x * width, y: y * height, z: z * width }));
}

/**
 * How far the face stands out, from the landmarks' own depth. Depth models make faces nearly
 * flat; the landmarks know where the nose and chin are. The mesher adds this on top of the
 * scaled depth map, so it is never cut off by the depth map's range.
 * @param {{ width: number, height: number, alpha: ArrayLike<number> }} mask
 * @param {{ x: number, y: number, z: number }[]} face pixel landmarks
 * @returns {Float32Array} one value per pixel, in pixels: 0 at the face's back edge
 */
export function faceLift({ width, height, alpha }, face) {
  const { faceHeight } = measure(face);
  const sigma = Math.max(1, FACE_DEPTH_SIGMA * faceHeight);
  const reach = Math.ceil(3 * sigma);
  let zFar = -Infinity;
  for (const { z } of face) zFar = Math.max(zFar, z);

  // Gaussian-weighted mean of the landmark depths, faded out where few landmarks are near.
  const weightSum = new Float32Array(width * height);
  const valueSum = new Float32Array(width * height);
  for (const { x, y, z } of face) {
    const x0 = Math.max(0, Math.floor(x - reach)), x1 = Math.min(width - 1, Math.ceil(x + reach));
    const y0 = Math.max(0, Math.floor(y - reach)), y1 = Math.min(height - 1, Math.ceil(y + reach));
    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        const w = Math.exp(-((px - x) ** 2 + (py - y) ** 2) / (2 * sigma * sigma));
        const p = py * width + px;
        weightSum[p] += w;
        valueSum[p] += w * (zFar - z);
      }
    }
  }
  const lift = new Float32Array(width * height);
  for (let p = 0; p < lift.length; p++) {
    if (!weightSum[p] || alpha[p] < 128) continue;
    const confidence = 1 - Math.exp(-weightSum[p]);
    lift[p] = FACE_LIFT * confidence * (valueSum[p] / weightSum[p]);
  }
  return lift;
}

/** Sizes and key points of a face, in pixels. */
function measure(face) {
  const mid = (a, b) => ({ x: (face[a].x + face[b].x) / 2, y: (face[a].y + face[b].y) / 2 });
  const dist = (a, b) => Math.hypot(face[a].x - face[b].x, face[a].y - face[b].y);
  return {
    faceHeight: dist(FOREHEAD, CHIN),
    faceWidth: dist(...CHEEKS),
    faceMiddle: mid(FOREHEAD, CHIN),
    eyes: EYES.map(([a, b]) => ({ ...mid(a, b), width: dist(a, b) })),
    mouth: { ...mid(MOUTH_LEFT, MOUTH_RIGHT), width: dist(MOUTH_LEFT, MOUTH_RIGHT), gap: dist(UPPER_LIP, LOWER_LIP) },
  };
}

/**
 * A round magnifying lens: inside `inner` (in output pixels) everything is `zoom` times
 * bigger, past `outer` nothing changes, and in between the zoom fades smoothly. The map from
 * output to source distance, r * g(r) with g rising from 1/zoom to 1, only ever grows, so the
 * picture never folds over itself.
 */
function lens(cx, cy, zoom, radius, fade) {
  const inner = radius * zoom;
  const outer = inner + fade;
  const scale = (r) => {
    if (r <= inner) return 1 / zoom;
    if (r >= outer) return 1;
    const t = (r - inner) / (outer - inner);
    return 1 / zoom + (1 - 1 / zoom) * t * t * (3 - 2 * t);
  };
  return {
    /** Output point to source point. */
    back([x, y]) {
      const dx = x - cx, dy = y - cy;
      const s = scale(Math.hypot(dx, dy));
      return [cx + dx * s, cy + dy * s];
    },
    /** Source point to output point, by bisection on the growing distance map. */
    forth([x, y]) {
      const dx = x - cx, dy = y - cy;
      const d = Math.hypot(dx, dy);
      if (d === 0 || d >= outer) return [x, y];
      let lo = 0, hi = outer;
      for (let k = 0; k < 40; k++) {
        const r = (lo + hi) / 2;
        if (r * scale(r) < d) lo = r; else hi = r;
      }
      const r = (lo + hi) / 2;
      return [cx + (dx / d) * r, cy + (dy / d) * r];
    },
  };
}

/**
 * Plans the caricature: the lenses, in the order an output point passes them on its way back
 * to the photo, and the margin the bigger head needs around the picture.
 */
function planWarp(face) {
  const { faceHeight, faceWidth, faceMiddle, eyes, mouth } = measure(face);
  const head = lens(faceMiddle.x, faceMiddle.y - HEAD_LIFT * faceHeight, HEAD_ZOOM, HEAD_RADIUS * faceHeight, HEAD_FADE * faceHeight);
  const features = [
    ...eyes.map((eye) => lens(eye.x, eye.y, EYE_ZOOM, EYE_RADIUS * eye.width, FEATURE_FADE * EYE_RADIUS * eye.width)),
    lens(face[NOSE_TIP].x, face[NOSE_TIP].y, NOSE_ZOOM, NOSE_RADIUS * faceWidth, FEATURE_FADE * NOSE_RADIUS * faceWidth),
    lens(mouth.x, mouth.y, MOUTH_ZOOM, MOUTH_RADIUS * mouth.width, FEATURE_FADE * MOUTH_RADIUS * mouth.width),
  ];
  const margin = Math.ceil((HEAD_ZOOM - 1) * (HEAD_RADIUS + HEAD_LIFT) * faceHeight);
  return { lenses: [head, ...features], margin };
}

/**
 * Plans the caricature warp of a photo; applyWarp() then moves any per-pixel data through it.
 * The output is `margin` pixels larger on every side, so the bigger head is not cut off.
 * @param {number} width photo width in pixels
 * @param {number} height photo height in pixels
 * @param {{ x: number, y: number, z: number }[]} face pixel landmarks
 * @returns {{ width: number, height: number, map: Float32Array, face: { x: number, y: number, z: number }[] }}
 *   the output size, the source point of every output pixel, and the landmarks where they end up
 */
export function caricatureWarp(width, height, face) {
  const { lenses, margin } = planWarp(face);
  const outWidth = width + 2 * margin, outHeight = height + 2 * margin;
  const map = new Float32Array(outWidth * outHeight * 2);
  for (let y = 0; y < outHeight; y++) {
    for (let x = 0; x < outWidth; x++) {
      let point = [x - margin, y - margin];
      for (const l of lenses) point = l.back(point);
      map.set(point, (y * outWidth + x) * 2);
    }
  }
  const moved = face.map(({ x, y, z }) => {
    let point = [x, y];
    for (let k = lenses.length - 1; k >= 0; k--) point = lenses[k].forth(point);
    return { x: point[0] + margin, y: point[1] + margin, z: z * HEAD_ZOOM };
  });
  return { width: outWidth, height: outHeight, map, face: moved };
}

/**
 * Resamples per-pixel values through a warp map, bilinearly; points outside the photo get 0.
 * @template {Float32Array | Uint8ClampedArray} T
 * @param {T} values `channels` values per pixel
 * @returns {T}
 */
export function applyWarp(values, width, height, channels, warp) {
  const out = new values.constructor(warp.width * warp.height * channels);
  for (let p = 0; p < warp.width * warp.height; p++) {
    const sx = warp.map[2 * p], sy = warp.map[2 * p + 1];
    if (sx < 0 || sy < 0 || sx > width - 1 || sy > height - 1) continue;
    const xa = Math.floor(sx), ya = Math.floor(sy);
    const xb = Math.min(xa + 1, width - 1), yb = Math.min(ya + 1, height - 1);
    const fx = sx - xa, fy = sy - ya;
    for (let c = 0; c < channels; c++) {
      const at = (xx, yy) => values[(yy * width + xx) * channels + c];
      out[p * channels + c] = (at(xa, ya) * (1 - fx) + at(xb, ya) * fx) * (1 - fy) + (at(xa, yb) * (1 - fx) + at(xb, yb) * fx) * fy;
    }
  }
  return out;
}

/**
 * Where the monster parts go on the figure, in pixels of the (warped) picture. Sizes are radii
 * or lengths in pixels; relief.js turns them into millimetres and solids.
 * @param {{ x: number, y: number }[]} face pixel landmarks
 * @param {{ width: number, height: number, alpha: ArrayLike<number> }} mask to find the top of the hair
 */
export function monsterParts(face, { width, height, alpha }) {
  const { faceHeight, faceWidth, eyes, mouth } = measure(face);
  const parts = [];
  // Googly eyes, with the pupils looking two different ways.
  const looks = [[-0.45, -0.35], [0.4, 0.3]];
  eyes.forEach((eye, k) => parts.push({ type: 'eye', x: eye.x, y: eye.y, r: eye.width * 0.75, look: looks[k] }));
  // The tongue hangs out of the mouth over the chin, longer the wider the mouth is open.
  const length = Math.max(0.9 * mouth.width, 0.4 * mouth.width + 1.5 * mouth.gap);
  parts.push({ type: 'tongue', x: face[LOWER_LIP].x, y: face[LOWER_LIP].y + length * 0.55, w: mouth.width * 0.3, l: length * 0.75 });
  // Two fangs from the upper lip.
  for (const side of [-1, 1]) {
    parts.push({ type: 'fang', x: face[UPPER_LIP].x + side * mouth.width * 0.28, y: face[UPPER_LIP].y, r: mouth.width * 0.09, l: mouth.width * 0.3 });
  }
  // Horns on top of the hair, leaning outward.
  for (const side of [-1, 1]) {
    const x = Math.round(face[FOREHEAD].x + side * faceWidth * 0.3);
    let top = Math.round(face[FOREHEAD].y);
    while (top > 0 && alpha[(top - 1) * width + Math.min(Math.max(x, 0), width - 1)] >= 128) top--;
    parts.push({ type: 'horn', x, y: top + faceHeight * 0.08, r: faceHeight * 0.1, l: faceHeight * 0.38, lean: side * 0.45 });
  }
  return parts;
}
