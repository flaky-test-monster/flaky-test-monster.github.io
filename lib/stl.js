// Minimal GLB -> binary STL converter. Reads every triangle primitive in the default
// scene, applies node transforms, and writes flat-shaded triangles. glTF is Y-up while
// slicers expect Z-up, so the model is rotated to stand upright on the build plate.

const GLB_MAGIC = 0x46546c67; // "glTF"
const GLB_HEADER_BYTES = 12;
const CHUNK_HEADER_BYTES = 8;
const CHUNK_TYPE_JSON = 0x4e4f534a; // "JSON"
const CHUNK_TYPE_BIN = 0x004e4942; // "BIN\0"
const MODE_TRIANGLES = 4;
const STL_HEADER_BYTES = 80;
const STL_COUNT_BYTES = 4;
const STL_TRIANGLE_BYTES = 50;
const STL_HEADER_TEXT = 'Flakifier binary STL';

const COMPONENT_SIZE = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const COMPONENT_READ = {
  5120: (view, offset) => view.getInt8(offset),
  5121: (view, offset) => view.getUint8(offset),
  5122: (view, offset) => view.getInt16(offset, true),
  5123: (view, offset) => view.getUint16(offset, true),
  5125: (view, offset) => view.getUint32(offset, true),
  5126: (view, offset) => view.getFloat32(offset, true),
};
const TYPE_COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
// Column-major rotation of +90 degrees around X: (x, y, z) -> (x, -z, y).
const Y_UP_TO_Z_UP = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1];

/**
 * Splits a GLB container into its glTF JSON document and binary chunk.
 * @param {Buffer} glb
 * @returns {{ gltf: object, bin: DataView }}
 */
export function parseGlb(glb) {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) throw new Error('Not a GLB file');
  let gltf = null;
  let bin = null;
  for (let offset = GLB_HEADER_BYTES; offset < view.byteLength; ) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const start = offset + CHUNK_HEADER_BYTES;
    if (type === CHUNK_TYPE_JSON) {
      gltf = JSON.parse(glb.toString('utf8', start, start + length));
    } else if (type === CHUNK_TYPE_BIN) {
      bin = new DataView(glb.buffer, glb.byteOffset + start, length);
    }
    offset = start + length;
  }
  if (!gltf || !bin) throw new Error('GLB is missing its JSON or binary chunk');
  return { gltf, bin };
}

/**
 * Reads an accessor into a flat array of numbers, honouring byteStride.
 * @param {object} gltf
 * @param {DataView} bin
 * @param {number} index accessor index
 * @returns {number[]}
 */
function readAccessor(gltf, bin, index) {
  const accessor = gltf.accessors[index];
  const bufferView = gltf.bufferViews[accessor.bufferView];
  const components = TYPE_COMPONENTS[accessor.type];
  const size = COMPONENT_SIZE[accessor.componentType];
  const read = COMPONENT_READ[accessor.componentType];
  const stride = bufferView.byteStride ?? components * size;
  const base = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const out = new Array(accessor.count * components);
  for (let i = 0; i < accessor.count; i++) {
    for (let c = 0; c < components; c++) {
      out[i * components + c] = read(bin, base + i * stride + c * size);
    }
  }
  return out;
}

/**
 * Multiplies two column-major 4x4 matrices (a * b).
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number[]}
 */
function multiply(a, b) {
  const out = new Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[col * 4 + k];
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

/**
 * Builds a node's local matrix from its matrix or translation/rotation/scale.
 * @param {object} node
 * @returns {number[]}
 */
function localMatrix(node) {
  if (node.matrix) return node.matrix;
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

/**
 * Applies a column-major matrix to a point.
 * @param {number[]} m
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @returns {number[]}
 */
function transform(m, x, y, z) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

/**
 * Appends the world-space triangles of one mesh to `triangles`. Appending in place
 * avoids spreading the result into push(), which overflows the stack on large meshes.
 * @param {object} gltf
 * @param {DataView} bin
 * @param {object} mesh
 * @param {number[]} world
 * @param {number[][][]} triangles receives [[x,y,z],[x,y,z],[x,y,z]] entries
 */
function meshTriangles(gltf, bin, mesh, world, triangles) {
  for (const primitive of mesh.primitives) {
    if ((primitive.mode ?? MODE_TRIANGLES) !== MODE_TRIANGLES) continue;
    if (primitive.attributes.POSITION === undefined) continue;
    const positions = readAccessor(gltf, bin, primitive.attributes.POSITION);
    const vertexCount = positions.length / 3;
    const indices = primitive.indices === undefined
      ? Array.from({ length: vertexCount }, (_, i) => i)
      : readAccessor(gltf, bin, primitive.indices);
    const vertex = (i) => transform(world, positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
    for (let i = 0; i + 2 < indices.length; i += 3) {
      triangles.push([vertex(indices[i]), vertex(indices[i + 1]), vertex(indices[i + 2])]);
    }
  }
}

/**
 * Walks the node tree and gathers all triangles in world space.
 * @param {object} gltf
 * @param {DataView} bin
 * @returns {number[][][]}
 */
function collectTriangles(gltf, bin) {
  const scene = gltf.scenes?.[gltf.scene ?? 0];
  const roots = scene?.nodes ?? gltf.nodes?.map((_, i) => i) ?? [];
  const triangles = [];
  const visit = (index, parent) => {
    const node = gltf.nodes[index];
    const world = multiply(parent, localMatrix(node));
    if (node.mesh !== undefined) meshTriangles(gltf, bin, gltf.meshes[node.mesh], world, triangles);
    for (const child of node.children ?? []) visit(child, world);
  };
  for (const root of roots) visit(root, Y_UP_TO_Z_UP);
  return triangles;
}

/**
 * Computes the unit normal of a triangle.
 * @param {number[][]} triangle
 * @returns {number[]}
 */
function normalOf([a, b, c]) {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const length = Math.hypot(n[0], n[1], n[2]) || 1;
  return [n[0] / length, n[1] / length, n[2] / length];
}

/**
 * Converts a GLB model into a binary STL buffer.
 * @param {Buffer} glb
 * @returns {Buffer}
 */
export function glbToStl(glb) {
  const { gltf, bin } = parseGlb(glb);
  const triangles = collectTriangles(gltf, bin);
  if (triangles.length === 0) throw new Error('GLB contains no triangles');
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
