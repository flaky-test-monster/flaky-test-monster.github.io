// Turns a cut-out mask and a depth map into a closed, printable STL. The subject's outline
// becomes a grid of square cells; each cell gets a front face lifted by the depth map, a back
// face, and side walls along the outline, so the mesh is watertight. Runs in the browser and
// in Node (no DOM): the in-browser pipeline calls it from its worker.

const STL_HEADER_BYTES = 80;
const STL_COUNT_BYTES = 4;
const STL_TRIANGLE_BYTES = 50;
const STL_HEADER_TEXT = 'Flakifier binary STL (browser)';
const ALPHA_THRESHOLD = 128;
const DEPTH_LOW_PERCENTILE = 0.02;
const DEPTH_HIGH_PERCENTILE = 0.98;
/** Share of the relief that follows the depth map; the rest is a rounded dome from the outline. */
const DEPTH_WEIGHT = 0.7;
/** Back of a rounded figure, as a share of the front dome. */
const ROUNDED_BACK_RATIO = 0.6;
const MAX_PINCH_PASSES = 8;

export const RELIEF_DEFAULTS = {
  shape: 'relief', // 'relief': flat back, prints lying down; 'rounded': domed on both sides
  resolution: 160, // cells along the subject's longer side
  heightMm: 100,
  reliefMm: 14,
  baseMm: 3,
};

/**
 * @typedef {object} ReliefInput
 * @property {number} width image width in pixels
 * @property {number} height image height in pixels
 * @property {Uint8Array | Uint8ClampedArray} alpha one value per pixel, 0 background to 255 subject
 * @property {Float32Array} depth one value per pixel, larger is closer to the camera
 */

/**
 * Builds the STL. The figure stands upright (Z up), facing -Y, its lowest point on z = 0.
 * @param {ReliefInput} input
 * @param {Partial<typeof RELIEF_DEFAULTS>} [options]
 * @returns {{ stl: ArrayBuffer, triangles: number }}
 */
export function reliefToStl(input, options = {}) {
  const opts = { ...RELIEF_DEFAULTS, ...options };
  const box = subjectBounds(input);
  if (!box) throw new Error('No subject found in the photo');
  const grid = sampleGrid(input, box, opts.resolution);
  const cells = selectCells(grid);
  const heights = vertexHeights(grid, cells, opts);
  return writeStl(grid, cells, heights, opts.heightMm);
}

/** Pixel bounding box of the subject, or null when the mask is empty. */
function subjectBounds({ width, height, alpha }) {
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (alpha[y * width + x] < ALPHA_THRESHOLD) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

/** Bilinear sample of a per-pixel array. */
function sample(values, width, height, x, y) {
  const xa = Math.min(Math.floor(x), width - 1), ya = Math.min(Math.floor(y), height - 1);
  const xb = Math.min(xa + 1, width - 1), yb = Math.min(ya + 1, height - 1);
  const fx = x - xa, fy = y - ya;
  const top = values[ya * width + xa] * (1 - fx) + values[ya * width + xb] * fx;
  const bottom = values[yb * width + xa] * (1 - fx) + values[yb * width + xb] * fx;
  return top * (1 - fy) + bottom * fy;
}

/**
 * Samples mask and depth on a vertex grid over the subject's bounding box, with a one-vertex
 * empty border so every outline edge gets a wall.
 */
function sampleGrid(input, box, resolution) {
  const span = Math.max(box.x1 - box.x0, box.y1 - box.y0, 1);
  const step = span / resolution;
  const cols = Math.ceil((box.x1 - box.x0) / step) + 3;
  const rows = Math.ceil((box.y1 - box.y0) / step) + 3;
  const inside = new Uint8Array(cols * rows);
  const depth = new Float32Array(cols * rows);
  for (let j = 1; j < rows - 1; j++) {
    for (let i = 1; i < cols - 1; i++) {
      const x = Math.min(box.x0 + (i - 1) * step, input.width - 1);
      const y = Math.min(box.y0 + (j - 1) * step, input.height - 1);
      inside[j * cols + i] = sample(input.alpha, input.width, input.height, x, y) >= ALPHA_THRESHOLD ? 1 : 0;
      depth[j * cols + i] = sample(input.depth, input.width, input.height, x, y);
    }
  }
  return { cols, rows, inside, depth };
}

/**
 * Picks the cells to build: those whose four corners are inside the subject, reduced to the
 * largest edge-connected piece. Cells that touch only at a corner would share a wall edge
 * between four faces, so such pinches are bridged with one extra cell.
 * @returns {Uint8Array} one flag per cell, (cols - 1) x (rows - 1)
 */
function selectCells({ cols, rows, inside }) {
  const cw = cols - 1, ch = rows - 1;
  const cells = new Uint8Array(cw * ch);
  for (let j = 0; j < ch; j++) {
    for (let i = 0; i < cw; i++) {
      const v = j * cols + i;
      cells[j * cw + i] = inside[v] & inside[v + 1] & inside[v + cols] & inside[v + cols + 1];
    }
  }
  const kept = largestComponent(cells, cw, ch);
  for (let pass = 0, changed = true; changed && pass < MAX_PINCH_PASSES; pass++) {
    changed = false;
    for (let j = 1; j < ch - 2; j++) {
      for (let i = 1; i < cw - 2; i++) {
        const a = kept[j * cw + i], b = kept[j * cw + i + 1];
        const c = kept[(j + 1) * cw + i], d = kept[(j + 1) * cw + i + 1];
        if (a && d && !b && !c) kept[j * cw + i + 1] = 1;
        else if (b && c && !a && !d) kept[j * cw + i] = 1;
        else continue;
        changed = true;
      }
    }
  }
  return kept;
}

/** Keeps only the largest 4-connected group of set cells. */
function largestComponent(cells, cw, ch) {
  const label = new Int32Array(cells.length).fill(-1);
  const stack = [];
  let best = -1, bestSize = 0;
  for (let start = 0; start < cells.length; start++) {
    if (!cells[start] || label[start] !== -1) continue;
    let size = 0;
    label[start] = start;
    stack.push(start);
    while (stack.length) {
      const c = stack.pop();
      size++;
      const i = c % cw, j = (c - i) / cw;
      for (const [ni, nj] of [[i - 1, j], [i + 1, j], [i, j - 1], [i, j + 1]]) {
        if (ni < 0 || nj < 0 || ni >= cw || nj >= ch) continue;
        const n = nj * cw + ni;
        if (cells[n] && label[n] === -1) { label[n] = start; stack.push(n); }
      }
    }
    if (size > bestSize) { best = start; bestSize = size; }
  }
  return Uint8Array.from(label, (l) => (l === best && best !== -1 ? 1 : 0));
}

/**
 * Front and back offsets in mm for every vertex used by a kept cell. The front combines the
 * normalised depth map with a dome that rounds the outline; the back is flat or a lower dome.
 */
function vertexHeights({ cols, rows, depth }, cells, opts) {
  const cw = cols - 1;
  const used = new Uint8Array(cols * rows);
  cells.forEach((kept, c) => {
    if (!kept) return;
    const v = Math.floor(c / cw) * cols + (c % cw);
    used[v] = used[v + 1] = used[v + cols] = used[v + cols + 1] = 1;
  });

  const smooth = boxBlur(depth, used, cols, rows);
  const values = [];
  used.forEach((u, v) => { if (u) values.push(smooth[v]); });
  values.sort((a, b) => a - b);
  const low = values[Math.floor(DEPTH_LOW_PERCENTILE * (values.length - 1))];
  const high = values[Math.floor(DEPTH_HIGH_PERCENTILE * (values.length - 1))];
  const range = high - low || 1;

  const distance = outlineDistance(used, cols, rows);
  const roundCells = Math.max(2, (opts.reliefMm / opts.heightMm) * (rows - 1));
  const front = new Float32Array(cols * rows);
  const back = new Float32Array(cols * rows);
  for (let v = 0; v < used.length; v++) {
    if (!used[v]) continue;
    const near = Math.min(Math.max((smooth[v] - low) / range, 0), 1);
    const r = 1 - Math.min(distance[v] / roundCells, 1);
    const dome = Math.sqrt(1 - r * r);
    const lift = opts.reliefMm * (DEPTH_WEIGHT * near + (1 - DEPTH_WEIGHT) * dome);
    if (opts.shape === 'rounded') {
      front[v] = opts.baseMm / 2 + lift;
      back[v] = opts.baseMm / 2 + opts.reliefMm * ROUNDED_BACK_RATIO * dome;
    } else {
      front[v] = opts.baseMm + lift;
      back[v] = 0;
    }
  }
  return { front, back };
}

/** 3x3 mean of `values` over the vertices flagged in `used`. */
function boxBlur(values, used, cols, rows) {
  const out = new Float32Array(values.length);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const v = j * cols + i;
      if (!used[v]) continue;
      let sum = 0, count = 0;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const ni = i + di, nj = j + dj;
          if (ni < 0 || nj < 0 || ni >= cols || nj >= rows || !used[nj * cols + ni]) continue;
          sum += values[nj * cols + ni];
          count++;
        }
      }
      out[v] = sum / count;
    }
  }
  return out;
}

/** Approximate distance in cells from each used vertex to the nearest unused one (chamfer). */
function outlineDistance(used, cols, rows) {
  const far = cols + rows;
  const d = Float32Array.from(used, (u) => (u ? far : 0));
  const relax = (v, n, cost) => { if (d[n] + cost < d[v]) d[v] = d[n] + cost; };
  for (let j = 1; j < rows; j++) {
    for (let i = 1; i < cols - 1; i++) {
      const v = j * cols + i;
      relax(v, v - 1, 1); relax(v, v - cols, 1); relax(v, v - cols - 1, Math.SQRT2); relax(v, v - cols + 1, Math.SQRT2);
    }
  }
  for (let j = rows - 2; j >= 0; j--) {
    for (let i = cols - 2; i >= 1; i--) {
      const v = j * cols + i;
      relax(v, v + 1, 1); relax(v, v + cols, 1); relax(v, v + cols + 1, Math.SQRT2); relax(v, v + cols - 1, Math.SQRT2);
    }
  }
  return d;
}

/**
 * Writes front and back faces of every kept cell and walls along the outline as binary STL,
 * scaled to `heightMm` tall and centered on x.
 */
function writeStl({ cols, rows }, cells, { front, back }, heightMm) {
  const cw = cols - 1, ch = rows - 1;
  const isCell = (i, j) => i >= 0 && j >= 0 && i < cw && j < ch && cells[j * cw + i] === 1;
  let walls = 0, faces = 0;
  for (let j = 0; j < ch; j++) {
    for (let i = 0; i < cw; i++) {
      if (!isCell(i, j)) continue;
      faces++;
      walls += !isCell(i - 1, j) + !isCell(i + 1, j) + !isCell(i, j - 1) + !isCell(i, j + 1);
    }
  }
  const triangles = faces * 4 + walls * 2;
  const stl = new ArrayBuffer(STL_HEADER_BYTES + STL_COUNT_BYTES + triangles * STL_TRIANGLE_BYTES);
  const view = new DataView(stl);
  for (let k = 0; k < STL_HEADER_TEXT.length; k++) view.setUint8(k, STL_HEADER_TEXT.charCodeAt(k));
  view.setUint32(STL_HEADER_BYTES, triangles, true);

  let left = cw, right = 0, top = ch, bottom = 0;
  for (let j = 0; j < ch; j++) {
    for (let i = 0; i < cw; i++) {
      if (!isCell(i, j)) continue;
      left = Math.min(left, i); right = Math.max(right, i + 1);
      top = Math.min(top, j); bottom = Math.max(bottom, j + 1);
    }
  }
  const cellMm = heightMm / (bottom - top);
  const x = (i) => (i - (left + right) / 2) * cellMm;
  const z = (j) => (bottom - j) * cellMm;
  const frontPoint = (i, j) => [x(i), -front[j * cols + i], z(j)];
  const backPoint = (i, j) => [x(i), back[j * cols + i], z(j)];

  let offset = STL_HEADER_BYTES + STL_COUNT_BYTES;
  /** Writes a triangle wound so its normal points along `outward`. */
  const emit = (a, b, c, outward) => {
    let n = cross(sub(b, a), sub(c, a));
    if (n[0] * outward[0] + n[1] * outward[1] + n[2] * outward[2] < 0) {
      [b, c] = [c, b];
      n = n.map((value) => -value);
    }
    const length = Math.hypot(n[0], n[1], n[2]) || 1;
    for (const value of [n[0] / length, n[1] / length, n[2] / length, ...a, ...b, ...c]) {
      view.setFloat32(offset, value, true);
      offset += 4;
    }
    view.setUint16(offset, 0, true);
    offset += 2;
  };
  const quad = (p, q, r, s, outward) => { emit(p, q, r, outward); emit(p, r, s, outward); };

  for (let j = 0; j < ch; j++) {
    for (let i = 0; i < cw; i++) {
      if (!isCell(i, j)) continue;
      const corners = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]];
      quad(...corners.map(([ci, cj]) => frontPoint(ci, cj)), [0, -1, 0]);
      quad(...corners.map(([ci, cj]) => backPoint(ci, cj)), [0, 1, 0]);
      // Each side: neighbour cell offset, the side's two corners, outward direction (Z is up, rows go down).
      const sides = [
        [-1, 0, corners[3], corners[0], [-1, 0, 0]],
        [1, 0, corners[1], corners[2], [1, 0, 0]],
        [0, -1, corners[0], corners[1], [0, 0, 1]],
        [0, 1, corners[2], corners[3], [0, 0, -1]],
      ];
      for (const [di, dj, [pi, pj], [qi, qj], outward] of sides) {
        if (isCell(i + di, j + dj)) continue;
        quad(frontPoint(pi, pj), frontPoint(qi, qj), backPoint(qi, qj), backPoint(pi, pj), outward);
      }
    }
  }
  return { stl, triangles };
}

function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
