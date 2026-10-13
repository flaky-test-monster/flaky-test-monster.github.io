// Turns a cut-out mask and a depth map into a closed, printable STL. The subject's outline
// becomes a grid of square cells; each cell gets a front face lifted by the depth map, a back
// face, and side walls along the outline, so the mesh is watertight. The 'bricks' shape builds
// the same relief from LEGO-style bricks instead: one column per stud, stacked in plate-height
// steps, with a stud on top. The outline is smoothed so it does not show the grid's stair
// steps, and monster parts (googly eyes, tongue, fangs, horns, placed by caricature.js) can be
// added as separate solids that sink into the relief. Runs in the browser and in Node (no
// DOM): the in-browser pipeline calls it from its worker.

const STL_HEADER_BYTES = 80;
const STL_COUNT_BYTES = 4;
const STL_TRIANGLE_BYTES = 50;
const STL_HEADER_TEXT = 'Flakifier binary STL (browser)';
const NO_SUBJECT_MESSAGE = 'No subject found in the photo: try a photo with one person, facing the camera, against a plain background';
const ALPHA_THRESHOLD = 128;
const DEPTH_LOW_PERCENTILE = 0.02;
const DEPTH_HIGH_PERCENTILE = 0.98;
/** Share of the relief that follows the depth map; the rest is a rounded dome from the outline. */
const DEPTH_WEIGHT = 0.7;
/** Back of a rounded figure, as a share of the front dome. */
const ROUNDED_BACK_RATIO = 0.6;
/** LEGO proportions as a share of the stud pitch (8 mm): plate 3.2, stud 4.8 wide, 1.7 high. */
const PLATE_RATIO = 0.4;
const STUD_RADIUS_RATIO = 0.3;
const STUD_HEIGHT_RATIO = 0.2125;
/** How far a stud reaches into its brick, so the two shells overlap and slicers merge them. */
const STUD_OVERLAP_RATIO = 0.05;
const STUD_SEGMENTS = 16;
/** Grid cells per stud: the bricks shape uses resolution / this many studs. */
const CELLS_PER_STUD = 5;
/** Empty pockets inside the outline smaller than this share of all cells are filled. */
const HOLE_FILL_RATIO = 0.02;
/** Outline smoothing: passes, and how far a corner may move, in cells (under half, so two sides of a one-cell strip never cross). */
const OUTLINE_SMOOTHING_PASSES = 6;
const OUTLINE_MAX_SHIFT = 0.45;
/** Segments around the monster parts' round solids. */
const PART_SEGMENTS = 20;

export const RELIEF_DEFAULTS = {
  // 'relief': flat back, prints lying down; 'rounded': domed on both sides;
  // 'bricks': flat back, built from LEGO-style bricks with studs on the front
  shape: 'relief',
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
 * @property {Float32Array} [lift] one value per pixel: how far the face stands out, in pixels,
 *   added after the depth map is scaled, from caricature.js faceLift()
 * @property {object[]} [parts] monster parts in pixels, from caricature.js monsterParts()
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
  if (!box) throw new Error(NO_SUBJECT_MESSAGE);
  if (opts.shape === 'bricks') {
    const grid = sampleGrid(input, box, Math.max(4, Math.round(opts.resolution / CELLS_PER_STUD)));
    return writeBricks(grid, opts);
  }
  const grid = sampleGrid(input, box, opts.resolution);
  const cells = selectCells(grid);
  // A subject thinner than one cell everywhere leaves nothing to build.
  if (!cells.includes(1)) throw new Error(NO_SUBJECT_MESSAGE);
  const heights = vertexHeights(grid, cells, opts);
  return writeStl(grid, cells, heights, opts.heightMm, input.parts ?? []);
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
  const lift = new Float32Array(cols * rows);
  for (let j = 1; j < rows - 1; j++) {
    for (let i = 1; i < cols - 1; i++) {
      const x = Math.min(box.x0 + (i - 1) * step, input.width - 1);
      const y = Math.min(box.y0 + (j - 1) * step, input.height - 1);
      inside[j * cols + i] = sample(input.alpha, input.width, input.height, x, y) >= ALPHA_THRESHOLD ? 1 : 0;
      depth[j * cols + i] = sample(input.depth, input.width, input.height, x, y);
      if (input.lift) lift[j * cols + i] = sample(input.lift, input.width, input.height, x, y);
    }
  }
  return { cols, rows, inside, depth, lift, subjectPx: Math.max(box.y1 - box.y0, 1), box, step };
}

/**
 * Picks the cells to build: those whose four corners are inside the subject, reduced to the
 * largest edge-connected piece, with corner-only contacts bridged.
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
  return bridgePinches(fillHoles(largestComponent(cells, cw, ch), cw, ch), cw, ch);
}

/**
 * Fills small empty pockets inside the outline, such as gaps the cut-out leaves in hair:
 * empty cells that cannot reach the grid's edge and form a group smaller than HOLE_FILL_RATIO.
 * Modifies and returns `cells`.
 */
function fillHoles(cells, cw, ch) {
  const empty = Uint8Array.from(cells, (c) => 1 - c);
  const label = new Int32Array(cells.length).fill(-1);
  const limit = HOLE_FILL_RATIO * cells.length;
  for (let start = 0; start < cells.length; start++) {
    if (!empty[start] || label[start] !== -1) continue;
    const group = [start];
    let open = false;
    label[start] = start;
    for (let k = 0; k < group.length; k++) {
      const c = group[k];
      const i = c % cw, j = (c - i) / cw;
      if (i === 0 || j === 0 || i === cw - 1 || j === ch - 1) open = true;
      for (const [ni, nj] of [[i - 1, j], [i + 1, j], [i, j - 1], [i, j + 1]]) {
        if (ni < 0 || nj < 0 || ni >= cw || nj >= ch) continue;
        const n = nj * cw + ni;
        if (empty[n] && label[n] === -1) { label[n] = start; group.push(n); }
      }
    }
    if (!open && group.length < limit) for (const c of group) cells[c] = 1;
  }
  return cells;
}

/**
 * Cells that touch only at a corner would share a wall edge between four faces, so each such
 * pinch is bridged with one extra cell. A bridge can expose a new pinch, so passes repeat
 * until none is left; every pass that changes something adds a cell, so this ends.
 * Modifies and returns `kept`.
 */
function bridgePinches(kept, cw, ch) {
  for (let changed = true; changed; ) {
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

/** Front and back offsets in mm for every vertex used by a kept cell. */
function vertexHeights({ cols, rows, inside, depth, lift, subjectPx }, cells, opts) {
  const cw = cols - 1;
  const used = new Uint8Array(cols * rows);
  cells.forEach((kept, c) => {
    if (!kept) return;
    const v = Math.floor(c / cw) * cols + (c % cw);
    used[v] = used[v + 1] = used[v + cols] = used[v + cols + 1] = 1;
  });
  // Filled holes and bridges use points outside the subject, where the depth is the background's.
  const fill = (values) => fillFromSubject(values, used, inside, cols, rows);
  return surfaceHeights({ depth: fill(depth), lift: fill(lift), mmPerPx: opts.heightMm / subjectPx }, used, cols, rows, opts);
}

/**
 * Gives every used point outside the subject the mean of its neighbours that have a value,
 * spreading inward from the subject, so filled holes match what is around them.
 * @returns {Float32Array} a copy of `values`
 */
function fillFromSubject(values, used, inside, cols, rows) {
  const out = Float32Array.from(values);
  const known = Uint8Array.from(inside);
  let open = [];
  used.forEach((u, v) => { if (u && !known[v]) open.push(v); });
  while (open.length) {
    const reached = [];
    for (const v of open) {
      const i = v % cols, j = (v - i) / cols;
      let sum = 0, count = 0;
      for (const [ni, nj] of [[i - 1, j], [i + 1, j], [i, j - 1], [i, j + 1]]) {
        if (ni < 0 || nj < 0 || ni >= cols || nj >= rows || !known[nj * cols + ni]) continue;
        sum += out[nj * cols + ni];
        count++;
      }
      if (count) reached.push([v, sum / count]);
    }
    // Nothing reachable is left: the rest keep their own values.
    if (!reached.length) break;
    for (const [v, value] of reached) { out[v] = value; known[v] = 1; }
    open = open.filter((v) => !known[v]);
  }
  return out;
}

/**
 * Front and back offsets in mm for the grid points flagged in `used`. The front combines the
 * normalised depth map with a dome that rounds the outline, plus the face lift; the back is
 * flat or a lower dome.
 */
/** `mmPerPx` turns the lift from picture pixels into millimetres: the figure's height over the subject's. */
function surfaceHeights({ depth, lift, mmPerPx }, used, cols, rows, opts) {
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
    const raise = opts.reliefMm * (DEPTH_WEIGHT * near + (1 - DEPTH_WEIGHT) * dome) + lift[v] * mmPerPx;
    if (opts.shape === 'rounded') {
      front[v] = opts.baseMm / 2 + raise;
      back[v] = opts.baseMm / 2 + opts.reliefMm * ROUNDED_BACK_RATIO * dome;
    } else {
      front[v] = opts.baseMm + raise;
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
 * scaled to `heightMm` tall and centered on x, then adds the monster parts.
 */
function writeStl(grid, cells, { front, back }, heightMm, parts) {
  const { cols, rows } = grid;
  const cw = cols - 1, ch = rows - 1;
  const isCell = (i, j) => i >= 0 && j >= 0 && i < cw && j < ch && cells[j * cw + i] === 1;
  const { left, right, top, bottom } = extent(cw, ch, isCell);
  const cellMm = heightMm / (bottom + 1 - top);
  const x = (i) => (i - (left + right + 1) / 2) * cellMm;
  const z = (j) => (bottom + 1 - j) * cellMm;
  const { gi, gj } = smoothOutline(cols, rows, cw, ch, isCell);
  // Points carry their vertex number, so the mesh can wind each triangle on the regular grid
  // and only then move it to the smoothed outline: a squeezed cell cannot flip its winding.
  const frontPoint = (i, j) => [x(i), -front[j * cols + i], z(j), j * cols + i];
  const backPoint = (i, j) => [x(i), back[j * cols + i], z(j), j * cols + i];
  const smoothed = ([, y, , v]) => [x(gi[v]), y, z(gj[v])];

  const mesh = createMesh(smoothed);
  for (let j = 0; j < ch; j++) {
    for (let i = 0; i < cw; i++) {
      if (!isCell(i, j)) continue;
      const corners = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]];
      mesh.quad(...corners.map(([ci, cj]) => frontPoint(ci, cj)), [0, -1, 0]);
      mesh.quad(...corners.map(([ci, cj]) => backPoint(ci, cj)), [0, 1, 0]);
      for (const [di, dj, [pi, pj], [qi, qj], outward] of cellSides(corners)) {
        if (isCell(i + di, j + dj)) continue;
        mesh.quad(frontPoint(pi, pj), frontPoint(qi, qj), backPoint(qi, qj), backPoint(pi, pj), outward);
      }
    }
  }

  // Parts are placed in picture pixels; this turns them into grid and then millimetre units.
  const { box, step } = grid;
  const toGrid = (px, py) => [(px - box.x0) / step + 1, (py - box.y0) / step + 1];
  const mm = (px) => (px / step) * cellMm;
  const isUsed = (i, j) => isCell(i - 1, j - 1) || isCell(i, j - 1) || isCell(i - 1, j) || isCell(i, j);
  /** Front surface height at a grid point: the nearest used vertex's, or the base. */
  const surfaceAt = (fi, fj) => {
    const ci = Math.round(fi), cj = Math.round(fj);
    for (let d = 0; d <= 3; d++) {
      for (let j = cj - d; j <= cj + d; j++) {
        for (let i = ci - d; i <= ci + d; i++) {
          if (i >= 0 && j >= 0 && i < cols && j < rows && isUsed(i, j)) return front[j * cols + i];
        }
      }
    }
    return 0;
  };
  for (const part of parts) {
    const [fi, fj] = toGrid(part.x, part.y);
    addPart(mesh, part, { x: x(fi), z: z(fj), surface: surfaceAt(fi, fj), mm });
  }
  return mesh.toStl();
}

/**
 * Positions of every grid vertex in grid units, with the outline smoothed: each vertex on the
 * outline moves toward the middle of its two outline neighbours (Taubin smoothing, which does
 * not shrink the shape), by less than half a cell, and any cell that folds is put back on the
 * grid. Only positions change, not which faces exist, so the mesh stays watertight.
 */
function smoothOutline(cols, rows, cw, ch, isCell) {
  const gi = new Float32Array(cols * rows), gj = new Float32Array(cols * rows);
  for (let v = 0; v < gi.length; v++) { gi[v] = v % cols; gj[v] = Math.floor(v / cols); }
  /** Outline neighbours of each outline vertex, from the walls the mesh gets. */
  const links = new Map();
  const link = (a, b) => {
    if (!links.has(a)) links.set(a, []);
    links.get(a).push(b);
  };
  for (let j = 0; j < ch; j++) {
    for (let i = 0; i < cw; i++) {
      if (!isCell(i, j)) continue;
      const corners = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]];
      for (const [di, dj, [pi, pj], [qi, qj]] of cellSides(corners)) {
        if (isCell(i + di, j + dj)) continue;
        const p = pj * cols + pi, q = qj * cols + qi;
        link(p, q);
        link(q, p);
      }
    }
  }
  const outline = [...links.keys()];
  const home = outline.map((v) => [gi[v], gj[v]]);
  for (let pass = 0; pass < OUTLINE_SMOOTHING_PASSES * 2; pass++) {
    const factor = pass % 2 === 0 ? 0.5 : -0.53;
    const moves = outline.map((v) => {
      const near = links.get(v);
      const mi = near.reduce((sum, n) => sum + gi[n], 0) / near.length;
      const mj = near.reduce((sum, n) => sum + gj[n], 0) / near.length;
      return [gi[v] + factor * (mi - gi[v]), gj[v] + factor * (mj - gj[v])];
    });
    outline.forEach((v, k) => {
      const [hi, hj] = home[k];
      const di = moves[k][0] - hi, dj = moves[k][1] - hj;
      const shrink = Math.min(1, OUTLINE_MAX_SHIFT / (Math.hypot(di, dj) || 1));
      gi[v] = hi + di * shrink;
      gj[v] = hj + dj * shrink;
    });
  }
  // The shift limit alone does not stop a cell folding when its neighbouring corners move
  // toward each other on a ragged outline: put the corners of any folded cell back on the
  // grid, until no cell is folded (all corners home is never folded, so this ends).
  const area = (a, b, c) => (gi[b] - gi[a]) * (gj[c] - gj[a]) - (gj[b] - gj[a]) * (gi[c] - gi[a]);
  for (let changed = true; changed; ) {
    changed = false;
    for (let j = 0; j < ch; j++) {
      for (let i = 0; i < cw; i++) {
        if (!isCell(i, j)) continue;
        const p = j * cols + i, q = p + 1, r = q + cols, s = p + cols;
        if (area(p, q, r) > 0 && area(p, r, s) > 0) continue;
        for (const v of [p, q, r, s]) {
          if (gi[v] === v % cols && gj[v] === Math.floor(v / cols)) continue;
          gi[v] = v % cols;
          gj[v] = Math.floor(v / cols);
          changed = true;
        }
      }
    }
  }
  return { gi, gj };
}

/**
 * Adds one monster part as closed solids that sink into the front of the relief. Nothing
 * reaches behind the back (y > 0), so the figure still prints lying on its back.
 * @param {{ x: number, z: number, surface: number, mm: (px: number) => number }} at the part's
 *   position in mm, the relief's front height there, and a pixel-to-mm conversion
 */
function addPart(mesh, part, { x, z, surface, mm }) {
  const front = (sink, depth) => Math.min(-surface + sink, -depth);
  if (part.type === 'eye') {
    const r = mm(part.r);
    const y = front(0.3 * r, r);
    addEllipsoid(mesh, [x, y, z], [r, r, r]);
    const [lx, lz] = part.look;
    const length = Math.hypot(lx, 1.2, lz);
    const pupil = [lx / length, -1.2 / length, -lz / length].map((d) => d * r * 0.85);
    addEllipsoid(mesh, [x + pupil[0], y + pupil[1], z + pupil[2]], [0.4 * r, 0.4 * r, 0.4 * r]);
  } else if (part.type === 'tongue') {
    const w = mm(part.w), l = mm(part.l), thick = 0.4 * w;
    addEllipsoid(mesh, [x, front(0.1 * thick, thick), z], [w, thick, l]);
  } else if (part.type === 'fang') {
    const r = mm(part.r);
    addCone(mesh, [x, front(0, r), z + r], [0, 0, -1], r, mm(part.l));
  } else if (part.type === 'horn') {
    const r = mm(part.r);
    const length = Math.hypot(part.lean, 1);
    addCone(mesh, [x, -r, z], [part.lean / length, 0, 1 / length], r, mm(part.l));
  }
}

/** Closed ellipsoid around `center` with radii along x, y and z. */
function addEllipsoid(mesh, center, radii) {
  const rings = PART_SEGMENTS / 2;
  const point = (a, b) => {
    const theta = (Math.PI * a) / rings, phi = (2 * Math.PI * b) / PART_SEGMENTS;
    return [
      center[0] + radii[0] * Math.sin(theta) * Math.cos(phi),
      center[1] + radii[1] * Math.sin(theta) * Math.sin(phi),
      center[2] + radii[2] * Math.cos(theta),
    ];
  };
  for (let a = 0; a < rings; a++) {
    for (let b = 0; b < PART_SEGMENTS; b++) {
      const p = point(a, b), q = point(a, b + 1), r = point(a + 1, b + 1), s = point(a + 1, b);
      // The poles collapse a ring to one point; skip the zero-area triangle there.
      if (a > 0) emitAround(mesh, center, p, q, r);
      if (a < rings - 1) emitAround(mesh, center, p, r, s);
    }
  }
}

/** Closed cone from a round base at `base`, pointing along the unit vector `axis`. */
function addCone(mesh, base, axis, radius, length) {
  const apex = base.map((c, k) => c + axis[k] * length);
  // Two unit vectors at right angles to the axis span the base circle.
  const helper = Math.abs(axis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = normalize(cross(axis, helper)), w = cross(axis, u);
  const ring = Array.from({ length: PART_SEGMENTS }, (_, k) => {
    const angle = (2 * Math.PI * k) / PART_SEGMENTS;
    return base.map((c, d) => c + radius * (Math.cos(angle) * u[d] + Math.sin(angle) * w[d]));
  });
  const inside = base.map((c, k) => c + axis[k] * length * 0.25);
  for (let k = 0; k < PART_SEGMENTS; k++) {
    const next = ring[(k + 1) % PART_SEGMENTS];
    emitAround(mesh, inside, ring[k], next, apex);
    emitAround(mesh, inside, ring[k], next, base);
  }
}

/** Emits a triangle of a convex solid, facing away from a point inside it. */
function emitAround(mesh, inside, a, b, c) {
  const centroid = [0, 1, 2].map((k) => (a[k] + b[k] + c[k]) / 3);
  mesh.emit(a, b, c, sub(centroid, inside));
}

function normalize(v) {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}

/**
 * Builds the relief from bricks: every grid point inside the subject is one stud-wide column,
 * as thick as the relief there rounded to whole plates, with a stud on its front. The back is
 * flat, so it prints lying down with the studs up. Neighbouring columns of different height
 * share the step between them; studs are separate shells sunk slightly into their column.
 * Walls are split at every column height meeting at their corners, so no edge ends in the
 * middle of another and the mesh stays manifold.
 */
function writeBricks({ cols, rows, inside, depth, lift, subjectPx }, opts) {
  const kept = bridgePinches(largestComponent(inside, cols, rows), cols, rows);
  if (!kept.includes(1)) throw new Error(NO_SUBJECT_MESSAGE);
  const fill = (values) => fillFromSubject(values, kept, inside, cols, rows);
  const { front } = surfaceHeights({ depth: fill(depth), lift: fill(lift), mmPerPx: opts.heightMm / subjectPx }, kept, cols, rows, { ...opts, shape: 'relief' });
  const isBrick = (i, j) => i >= 0 && j >= 0 && i < cols && j < rows && kept[j * cols + i] === 1;
  const { left, right, top, bottom } = extent(cols, rows, isBrick);
  const studMm = opts.heightMm / (bottom + 1 - top);
  const plateMm = studMm * PLATE_RATIO;
  const thickness = Float32Array.from(front, (t, b) => (kept[b] ? Math.max(1, Math.round(t / plateMm)) * plateMm : 0));
  const x = (i) => (i - (left + right + 1) / 2) * studMm;
  const z = (j) => (bottom + 1 - j) * studMm;
  const heightAt = (i, j) => (isBrick(i, j) ? thickness[j * cols + i] : 0);
  /** Every column height meeting at corner (ci, cj), which sits between columns ci-1..ci, cj-1..cj. */
  const levelsAt = ([ci, cj]) => [heightAt(ci - 1, cj - 1), heightAt(ci, cj - 1), heightAt(ci - 1, cj), heightAt(ci, cj)];

  const mesh = createMesh();
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      if (!isBrick(i, j)) continue;
      const t = thickness[j * cols + i];
      // The brick spans the square from corner (i, j) to (i + 1, j + 1) in this numbering.
      const corners = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]];
      const point = ([ci, cj], y) => [x(ci), y, z(cj)];
      mesh.quad(...corners.map((c) => point(c, -t)), [0, -1, 0]);
      mesh.quad(...corners.map((c) => point(c, 0)), [0, 1, 0]);
      for (const [di, dj, p, q, outward] of cellSides(corners)) {
        const neighbour = heightAt(i + di, j + dj);
        if (neighbour >= t) continue;
        const chain = (c) => [neighbour, ...levelsAt(c).filter((l) => l > neighbour && l < t).sort((a, b) => a - b), t]
          .filter((l, k, all) => k === 0 || l !== all[k - 1]).map((l) => point(c, -l));
        mesh.strip(chain(p), chain(q), outward);
      }
      addStud(mesh, [x(i + 0.5), -t, z(j + 0.5)], studMm);
    }
  }
  return mesh.toStl();
}

/** Closed cylinder pointing along -Y from `base`, sunk a little into the surface below it. */
function addStud(mesh, [cx, y, cz], studMm) {
  const r = studMm * STUD_RADIUS_RATIO;
  const yBack = y + studMm * STUD_OVERLAP_RATIO;
  const yFront = y - studMm * STUD_HEIGHT_RATIO;
  const ring = (yy) => Array.from({ length: STUD_SEGMENTS }, (_, k) => {
    const angle = (2 * Math.PI * k) / STUD_SEGMENTS;
    return [cx + r * Math.cos(angle), yy, cz + r * Math.sin(angle)];
  });
  const back = ring(yBack), front = ring(yFront);
  for (let k = 0; k < STUD_SEGMENTS; k++) {
    const n = (k + 1) % STUD_SEGMENTS;
    const mid = (2 * Math.PI * (k + 0.5)) / STUD_SEGMENTS;
    mesh.quad(back[k], back[n], front[n], front[k], [Math.cos(mid), 0, Math.sin(mid)]);
    mesh.emit([cx, yFront, cz], front[k], front[n], [0, -1, 0]);
    mesh.emit([cx, yBack, cz], back[k], back[n], [0, 1, 0]);
  }
}

/** Bounding box, in grid indices, of the cells for which `isSet` holds. */
function extent(cw, ch, isSet) {
  let left = cw, right = 0, top = ch, bottom = 0;
  for (let j = 0; j < ch; j++) {
    for (let i = 0; i < cw; i++) {
      if (!isSet(i, j)) continue;
      left = Math.min(left, i); right = Math.max(right, i);
      top = Math.min(top, j); bottom = Math.max(bottom, j);
    }
  }
  return { left, right, top, bottom };
}

/**
 * The four sides of a cell given its corners (top-left, top-right, bottom-right, bottom-left):
 * neighbour offset, the side's two corners, and its outward direction (Z is up, rows go down).
 */
function cellSides(corners) {
  return [
    [-1, 0, corners[3], corners[0], [-1, 0, 0]],
    [1, 0, corners[1], corners[2], [1, 0, 0]],
    [0, -1, corners[0], corners[1], [0, 0, 1]],
    [0, 1, corners[2], corners[3], [0, 0, -1]],
  ];
}

/**
 * Collects triangles, each wound so its normal points along a given outward direction.
 * Points with a fourth value (a vertex number) are passed through `move` once wound.
 */
function createMesh(move = (p) => p) {
  const coords = [];
  const emit = (a, b, c, outward) => {
    const n = cross(sub(b, a), sub(c, a));
    if (n[0] * outward[0] + n[1] * outward[1] + n[2] * outward[2] < 0) [b, c] = [c, b];
    for (const p of [a, b, c]) coords.push(...(p.length > 3 ? move(p) : p));
  };
  const quad = (p, q, r, s, outward) => { emit(p, q, r, outward); emit(p, r, s, outward); };
  /** Triangulates the band between two point chains that run side by side in the same direction. */
  const strip = (a, b, outward) => {
    for (let i = 0, j = 0; i < a.length - 1 || j < b.length - 1; ) {
      const advanceA = j === b.length - 1 || (i < a.length - 1 && Math.abs(a[i + 1][1]) <= Math.abs(b[j + 1][1]));
      if (advanceA) emit(a[i], a[++i], b[j], outward);
      else emit(a[i], b[++j], b[j - 1], outward);
    }
  };
  /** Encodes the triangles as binary STL. */
  const toStl = () => {
    const triangles = coords.length / 9;
    const stl = new ArrayBuffer(STL_HEADER_BYTES + STL_COUNT_BYTES + triangles * STL_TRIANGLE_BYTES);
    const view = new DataView(stl);
    for (let k = 0; k < STL_HEADER_TEXT.length; k++) view.setUint8(k, STL_HEADER_TEXT.charCodeAt(k));
    view.setUint32(STL_HEADER_BYTES, triangles, true);
    let offset = STL_HEADER_BYTES + STL_COUNT_BYTES;
    for (let t = 0; t < triangles; t++) {
      const v = coords.slice(t * 9, t * 9 + 9);
      const n = cross(sub(v.slice(3, 6), v), sub(v.slice(6, 9), v));
      const length = Math.hypot(n[0], n[1], n[2]) || 1;
      for (const value of [n[0] / length, n[1] / length, n[2] / length, ...v]) {
        view.setFloat32(offset, value, true);
        offset += 4;
      }
      view.setUint16(offset, 0, true);
      offset += 2;
    }
    return { stl, triangles };
  };
  return { emit, quad, strip, toStl };
}

function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
