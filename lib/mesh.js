// Turns the shape list written by the GPT model into a binary STL. Each part is tessellated
// in its own frame, oriented so every face points outward, then rotated and placed. The
// finished model is centered on the build plate and scaled to TARGET_HEIGHT_MM.

const SEGMENTS = 32;
const RINGS = 16;
const MAX_PARTS = 200;
const MIN_SIZE_MM = 0.5;
const MAX_SIZE_MM = 500;
const MAX_TOP_SCALE = 2;
const TARGET_HEIGHT_MM = Number(process.env.TARGET_HEIGHT_MM) || 100;
const DEGENERATE_AREA = 1e-9;
const STL_HEADER_BYTES = 80;
const STL_COUNT_BYTES = 4;
const STL_TRIANGLE_BYTES = 50;
const STL_HEADER_TEXT = 'Flakifier binary STL';
const ORIGIN = [0, 0, 0];

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const centroid = ([a, b, c]) => [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

/**
 * Reads a {x, y, z} object from the model output into an array, replacing junk with 0.
 * @param {unknown} vector
 * @returns {number[]}
 */
function toArray(vector) {
  return ['x', 'y', 'z'].map((axis) => (Number.isFinite(vector?.[axis]) ? vector[axis] : 0));
}

/**
 * Splits a grid of points into triangles. grid[i][j] wraps around in j.
 * @param {number[][][]} grid
 * @returns {number[][][]}
 */
function gridTriangles(grid) {
  const triangles = [];
  for (let i = 0; i + 1 < grid.length; i++) {
    for (let j = 0; j < SEGMENTS; j++) {
      const k = (j + 1) % SEGMENTS;
      triangles.push([grid[i][j], grid[i + 1][j], grid[i + 1][k]], [grid[i][j], grid[i + 1][k], grid[i][k]]);
    }
  }
  return triangles;
}

/** Ellipsoid with the given radii, centered on the origin. */
function ellipsoid([rx, ry, rz]) {
  const grid = [];
  for (let i = 0; i <= RINGS; i++) {
    const theta = (Math.PI * i) / RINGS;
    grid.push(Array.from({ length: SEGMENTS }, (_, j) => {
      const phi = (2 * Math.PI * j) / SEGMENTS;
      return [rx * Math.sin(theta) * Math.cos(phi), ry * Math.sin(theta) * Math.sin(phi), rz * Math.cos(theta)];
    }));
  }
  return gridTriangles(grid);
}

/** Axis-aligned box with the given half extents, centered on the origin. */
function box([hx, hy, hz]) {
  const v = (x, y, z) => [x * hx, y * hy, z * hz];
  const faces = [
    [v(-1, -1, -1), v(1, -1, -1), v(1, 1, -1), v(-1, 1, -1)],
    [v(-1, -1, 1), v(1, -1, 1), v(1, 1, 1), v(-1, 1, 1)],
    [v(-1, -1, -1), v(1, -1, -1), v(1, -1, 1), v(-1, -1, 1)],
    [v(-1, 1, -1), v(1, 1, -1), v(1, 1, 1), v(-1, 1, 1)],
    [v(-1, -1, -1), v(-1, 1, -1), v(-1, 1, 1), v(-1, -1, 1)],
    [v(1, -1, -1), v(1, 1, -1), v(1, 1, 1), v(1, -1, 1)],
  ];
  return faces.flatMap(([a, b, c, d]) => [[a, b, c], [a, c, d]]);
}

/** Z-axis cylinder or frustum with bottom radii rx, ry, height 2 * hz, top scaled by topScale. */
function cylinder([rx, ry, hz], topScale) {
  const ring = (scale, z) => Array.from({ length: SEGMENTS }, (_, j) => {
    const phi = (2 * Math.PI * j) / SEGMENTS;
    return [rx * scale * Math.cos(phi), ry * scale * Math.sin(phi), z];
  });
  const bottom = ring(1, -hz);
  const top = ring(topScale, hz);
  const triangles = gridTriangles([bottom, top]);
  for (let j = 0; j < SEGMENTS; j++) {
    const k = (j + 1) % SEGMENTS;
    triangles.push([[0, 0, -hz], bottom[j], bottom[k]], [[0, 0, hz], top[j], top[k]]);
  }
  return triangles;
}

/** Torus in the XY plane with outer radii ox, oy and tube radius r. */
function torus([ox, oy, r]) {
  const tube = Math.min(r, ox * 0.9, oy * 0.9);
  const ringX = ox - tube;
  const ringY = oy - tube;
  const grid = [];
  for (let i = 0; i <= RINGS; i++) {
    const v = (2 * Math.PI * i) / RINGS;
    grid.push(Array.from({ length: SEGMENTS }, (_, j) => {
      const u = (2 * Math.PI * j) / SEGMENTS;
      return [(ringX + tube * Math.cos(v)) * Math.cos(u), (ringY + tube * Math.cos(v)) * Math.sin(u), tube * Math.sin(v)];
    }));
  }
  const inside = (point) => {
    const u = Math.atan2(point[1] / ringY, point[0] / ringX);
    return [ringX * Math.cos(u), ringY * Math.sin(u), 0];
  };
  return { triangles: gridTriangles(grid), inside };
}

/**
 * Builds one part in its own frame. Returns the triangles and a function giving a point
 * inside the solid near a surface point, used to orient faces outward.
 * @param {object} part
 * @returns {{ triangles: number[][][], inside: (point: number[]) => number[] }}
 */
function buildLocal(part) {
  const half = toArray(part.size).map((value) => clamp(Math.abs(value), MIN_SIZE_MM, MAX_SIZE_MM) / 2);
  const convex = (triangles) => ({ triangles, inside: () => ORIGIN });
  switch (part.shape) {
    case 'ellipsoid': return convex(ellipsoid(half));
    case 'box': return convex(box(half));
    case 'cylinder': {
      const topScale = clamp(Number.isFinite(part.top_scale) ? part.top_scale : 1, 0, MAX_TOP_SCALE);
      return convex(cylinder(half, topScale));
    }
    case 'torus': return torus(half);
    default: throw new Error(`Unknown shape: ${part.shape}`);
  }
}

/**
 * Returns a function applying rotation (degrees, X then Y then Z) and translation.
 * @param {number[]} rotation
 * @param {number[]} center
 * @returns {(point: number[]) => number[]}
 */
function placement(rotation, center) {
  const [cx, cy, cz] = rotation.map((deg) => Math.cos((deg * Math.PI) / 180));
  const [sx, sy, sz] = rotation.map((deg) => Math.sin((deg * Math.PI) / 180));
  return ([x0, y0, z0]) => {
    const [x1, y1, z1] = [x0, y0 * cx - z0 * sx, y0 * sx + z0 * cx];
    const [x2, y2, z2] = [x1 * cy + z1 * sy, y1, -x1 * sy + z1 * cy];
    return [x2 * cz - y2 * sz + center[0], x2 * sz + y2 * cz + center[1], z2 + center[2]];
  };
}

/**
 * Tessellates one part into world-space triangles wound counter-clockwise from outside.
 * @param {object} part
 * @returns {number[][][]}
 */
function partTriangles(part) {
  const { triangles, inside } = buildLocal(part);
  const place = placement(toArray(part.rotation), toArray(part.center));
  const out = [];
  for (const triangle of triangles) {
    const [a, b, c] = triangle;
    const normal = cross(sub(b, a), sub(c, a));
    if (dot(normal, normal) < DEGENERATE_AREA) continue;
    const middle = centroid(triangle);
    const oriented = dot(normal, sub(middle, inside(middle))) >= 0 ? triangle : [a, c, b];
    out.push(oriented.map(place));
  }
  return out;
}

/**
 * Centers the model on x/y, puts its lowest point on z = 0 and scales it to the target height.
 * @param {number[][][]} triangles modified in place
 */
function normalize(triangles) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const point of triangles.flat()) {
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], point[axis]);
      max[axis] = Math.max(max[axis], point[axis]);
    }
  }
  const scale = TARGET_HEIGHT_MM / (max[2] - min[2] || 1);
  const offset = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, min[2]];
  for (const triangle of triangles) {
    for (let v = 0; v < 3; v++) triangle[v] = sub(triangle[v], offset).map((value) => value * scale);
  }
}

/**
 * Computes the unit normal of a triangle.
 * @param {number[][]} triangle
 * @returns {number[]}
 */
function normalOf([a, b, c]) {
  const n = cross(sub(b, a), sub(c, a));
  const length = Math.hypot(n[0], n[1], n[2]) || 1;
  return [n[0] / length, n[1] / length, n[2] / length];
}

/**
 * Converts the model's shape list into a binary STL buffer. Overlapping parts are kept as
 * separate shells; slicers merge them when printing.
 * @param {{ parts: object[] }} scene
 * @returns {Buffer}
 */
export function sceneToStl(scene) {
  const parts = Array.isArray(scene?.parts) ? scene.parts.slice(0, MAX_PARTS) : [];
  const triangles = parts.flatMap(partTriangles);
  if (triangles.length === 0) throw new Error('The generated model contains no shapes');
  normalize(triangles);
  const stl = Buffer.alloc(STL_HEADER_BYTES + STL_COUNT_BYTES + triangles.length * STL_TRIANGLE_BYTES);
  stl.write(STL_HEADER_TEXT, 0, 'ascii');
  stl.writeUInt32LE(triangles.length, STL_HEADER_BYTES);
  let offset = STL_HEADER_BYTES + STL_COUNT_BYTES;
  for (const triangle of triangles) {
    for (const value of [...normalOf(triangle), ...triangle.flat()]) {
      stl.writeFloatLE(value, offset);
      offset += 4;
    }
    stl.writeUInt16LE(0, offset);
    offset += 2;
  }
  return stl;
}
