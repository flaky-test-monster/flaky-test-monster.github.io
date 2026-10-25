/**
 * A small QR code encoder (ISO/IEC 18004), for the links the admin page prints: byte mode,
 * versions 1 to 40, any of the four error correction levels, and the mask with the lowest
 * penalty. It returns the modules as rows of booleans and turns them into SVG. No DOM, so it
 * also runs in Node.
 */

/** Error correction levels: the bits they have in the format information, and their table row. */
const LEVELS = { L: { bits: 1, row: 0 }, M: { bits: 0, row: 1 }, Q: { bits: 3, row: 2 }, H: { bits: 2, row: 3 } };

// Error correction codewords per block, and the number of blocks, by level row and version
// (index 0 unused), from the tables of the standard.
const ECC_PER_BLOCK = [
  [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [0, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [0, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const BLOCKS = [
  [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [0, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [0, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

const MAX_VERSION = 40;
/** The light border around the code that scanners need, in modules. */
const QUIET_ZONE = 4;
// Penalty weights of the standard, for choosing the mask.
const PENALTY_RUN = 3;
const PENALTY_BLOCK = 3;
const PENALTY_FINDER = 40;
const PENALTY_BALANCE = 10;

/** Multiplies in GF(256) with the QR polynomial x^8 + x^4 + x^3 + x^2 + 1. */
function gfMultiply(a, b) {
  let result = 0;
  for (let i = 7; i >= 0; i--) {
    result = (result << 1) ^ ((result >>> 7) * 0x11d);
    result ^= ((b >>> i) & 1) * a;
  }
  return result;
}

/** The Reed-Solomon generator polynomial of a degree, highest term left out. */
function rsDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

/** The error correction codewords of a block: the remainder of the data by the divisor. */
function rsRemainder(data, divisor) {
  const result = new Array(divisor.length).fill(0);
  for (const byte of data) {
    const factor = byte ^ result.shift();
    result.push(0);
    divisor.forEach((coefficient, i) => { result[i] ^= gfMultiply(coefficient, factor); });
  }
  return result;
}

/** How many modules of a version hold data and error correction, the rest being patterns. */
function rawModules(version) {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    result -= (25 * align - 10) * align - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

const dataCodewords = (version, level) =>
  Math.floor(rawModules(version) / 8) - ECC_PER_BLOCK[level.row][version] * BLOCKS[level.row][version];

/** The centres of the alignment patterns, the same along both axes. */
function alignmentPositions(version) {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const size = version * 4 + 17;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < count; pos -= step) result.splice(1, 0, pos);
  return result;
}

/** The smallest version the bytes fit in, and the data codewords, padded as the standard says. */
function encodeData(bytes, level) {
  for (let version = 1; version <= MAX_VERSION; version++) {
    const capacity = dataCodewords(version, level) * 8;
    const countBits = version < 10 ? 8 : 16;
    if (4 + countBits + bytes.length * 8 > capacity) continue;
    const bits = [];
    const push = (value, length) => { for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
    push(0b0100, 4);
    push(bytes.length, countBits);
    for (const byte of bytes) push(byte, 8);
    push(0, Math.min(4, capacity - bits.length));
    push(0, (8 - (bits.length % 8)) % 8);
    for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
    const codewords = [];
    for (let i = 0; i < bits.length; i += 8) codewords.push(bits.slice(i, i + 8).reduce((byte, bit) => (byte << 1) | bit, 0));
    return { version, codewords };
  }
  throw new Error('The text is too long for a QR code.');
}

/** Splits the data into blocks, adds their error correction, and interleaves them. */
function withErrorCorrection(codewords, version, level) {
  const blockCount = BLOCKS[level.row][version];
  const eccLength = ECC_PER_BLOCK[level.row][version];
  const raw = Math.floor(rawModules(version) / 8);
  const shortBlocks = blockCount - (raw % blockCount);
  const shortLength = Math.floor(raw / blockCount);
  const divisor = rsDivisor(eccLength);
  const blocks = [];
  for (let i = 0, k = 0; i < blockCount; i++) {
    const data = codewords.slice(k, k + shortLength - eccLength + (i < shortBlocks ? 0 : 1));
    k += data.length;
    const ecc = rsRemainder(data, divisor);
    // A short block gets a placeholder, so all blocks line up; it is skipped below.
    if (i < shortBlocks) data.push(0);
    blocks.push([...data, ...ecc]);
  }
  const result = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortLength - eccLength || j >= shortBlocks) result.push(block[i]);
    });
  }
  return result;
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** A grid of modules, with the patterns drawn and marked so data and masks leave them alone. */
function patternGrid(version) {
  const size = version * 4 + 17;
  const dark = Array.from({ length: size }, () => new Array(size).fill(false));
  const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, value) => { dark[y][x] = value; fixed[y][x] = true; };

  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  // The three finder patterns, with their light separators.
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        const ring = Math.max(Math.abs(dx), Math.abs(dy));
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, ring !== 2 && ring !== 4);
      }
    }
  }
  const align = alignmentPositions(version);
  const last = align.length - 1;
  align.forEach((cy, i) => align.forEach((cx, j) => {
    // Not where the finder patterns are.
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }));
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const bit = ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, bit);
      set(b, a, bit);
    }
  }
  // Reserves the format information; drawFormat fills it in once the mask is chosen.
  drawFormat(set, size, 0);
  return { size, dark, fixed };
}

/** Draws the 15 format bits (level and mask) in both places, and the one always dark module. */
function drawFormat(set, size, format) {
  let rem = format;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((format << 10) | rem) ^ 0x5412;
  const bit = (i) => ((bits >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) set(8, i, bit(i));
  set(8, 7, bit(6));
  set(8, 8, bit(7));
  set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
  set(8, size - 8, true);
}

/** Places the codewords in the zigzag of two-module columns, from the bottom right. */
function drawCodewords({ size, dark, fixed }, codewords) {
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    // The vertical timing pattern takes column 6.
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
        if (fixed[y][x] || i >= codewords.length * 8) continue;
        dark[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
        i++;
      }
    }
  }
}

/** The standard's penalty for a grid: long runs, 2x2 blocks, finder look-alikes, imbalance. */
function penalty(dark) {
  const size = dark.length;
  let result = 0;
  const lines = [...dark, ...dark.map((_, x) => dark.map((row) => row[x]))];
  // 1:1:3:1:1 with four light modules on one side.
  const finder = [true, false, true, true, true, false, true];
  const light = [false, false, false, false];
  const matches = (line, at, pattern) => pattern.every((value, k) => line[at + k] === value);
  for (const line of lines) {
    let run = 1;
    for (let i = 1; i <= size; i++) {
      if (i < size && line[i] === line[i - 1]) {
        run++;
      } else {
        if (run >= 5) result += PENALTY_RUN + run - 5;
        run = 1;
      }
    }
    for (let i = 0; i + 11 <= size; i++) {
      if (matches(line, i, [...finder, ...light]) || matches(line, i, [...light, ...finder])) result += PENALTY_FINDER;
    }
  }
  for (let y = 0; y + 1 < size; y++) {
    for (let x = 0; x + 1 < size; x++) {
      const v = dark[y][x];
      if (dark[y][x + 1] === v && dark[y + 1][x] === v && dark[y + 1][x + 1] === v) result += PENALTY_BLOCK;
    }
  }
  const total = size * size;
  const darkCount = dark.reduce((sum, row) => sum + row.filter(Boolean).length, 0);
  result += (Math.ceil(Math.abs(darkCount * 20 - total * 10) / total) - 1) * PENALTY_BALANCE;
  return result;
}

/**
 * Encodes text (UTF-8, byte mode) as a QR code.
 * @param {string} text
 * @param {'L' | 'M' | 'Q' | 'H'} [levelName] error correction: M, the default, survives about 15% damage
 * @returns {boolean[][]} rows of modules, true for dark, without the quiet zone
 */
export function encodeQr(text, levelName = 'M') {
  const level = LEVELS[levelName];
  if (!level) throw new Error(`Unknown error correction level: ${levelName}`);
  const { version, codewords } = encodeData([...new TextEncoder().encode(text)], level);
  const all = withErrorCorrection(codewords, version, level);
  let best;
  for (let mask = 0; mask < MASKS.length; mask++) {
    const grid = patternGrid(version);
    drawCodewords(grid, all);
    const { size, dark, fixed } = grid;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) if (!fixed[y][x] && MASKS[mask](x, y)) dark[y][x] = !dark[y][x];
    }
    drawFormat((x, y, value) => { dark[y][x] = value; }, size, (level.bits << 3) | mask);
    const score = penalty(dark);
    if (!best || score < best.score) best = { score, dark };
  }
  return best.dark;
}

/**
 * The code as an SVG document: one path of dark squares on a light background, with the quiet
 * zone, so it prints sharp at any size.
 * @param {boolean[][]} modules from encodeQr
 * @param {{ dark?: string, light?: string, title?: string }} [options]
 * @returns {string}
 */
export function qrSvg(modules, { dark = '#000', light = '#fff', title = '' } = {}) {
  const size = modules.length + QUIET_ZONE * 2;
  let path = '';
  modules.forEach((row, y) => row.forEach((on, x) => {
    if (on) path += `M${x + QUIET_ZONE} ${y + QUIET_ZONE}h1v1h-1z`;
  }));
  const escape = (value) => value.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">`
    + (title ? `<title>${escape(title)}</title>` : '')
    + `<rect width="${size}" height="${size}" fill="${escape(light)}"/><path d="${path}" fill="${escape(dark)}"/></svg>`;
}

/** The light border qrSvg adds on each side, in modules, for anyone drawing the code themselves. */
export { QUIET_ZONE };
