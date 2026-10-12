/**
 * A minimal ZIP writer: files are stored as they are, not compressed, which suits PNGs that
 * are compressed already. Enough to hand over several files in one download.
 */

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

/** CRC-32 of the bytes, as ZIP wants it. */
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Time and date in the MS-DOS format of ZIP headers, to the even second. */
function dosDateTime(date) {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** Little-endian header fields: [value, size in bytes] pairs. */
function header(fields) {
  const view = new DataView(new ArrayBuffer(fields.reduce((sum, [, size]) => sum + size, 0)));
  let offset = 0;
  for (const [value, size] of fields) {
    if (size === 2) view.setUint16(offset, value, true);
    else view.setUint32(offset, value, true);
    offset += size;
  }
  return new Uint8Array(view.buffer);
}

/**
 * Packs files into a ZIP archive.
 * @param {{ name: string, blob: Blob, date: Date }[]} files
 * @returns {Promise<Blob>}
 */
export async function zip(files) {
  const parts = [];
  const directory = [];
  let offset = 0;
  for (const file of files) {
    const data = new Uint8Array(await file.blob.arrayBuffer());
    const name = new TextEncoder().encode(file.name);
    const crc = crc32(data);
    const { time, date } = dosDateTime(file.date);
    // Version 2.0, flag 0x800: the name is UTF-8, method 0: stored.
    const common = [[20, 2], [0x800, 2], [0, 2], [time, 2], [date, 2], [crc, 4], [data.length, 4], [data.length, 4], [name.length, 2], [0, 2]];
    const local = header([[0x04034b50, 4], ...common]);
    parts.push(local, name, data);
    directory.push(header([[0x02014b50, 4], [20, 2], ...common, [0, 2], [0, 2], [0, 2], [0, 4], [offset, 4]]), name);
    offset += local.length + name.length + data.length;
  }
  const directorySize = directory.reduce((sum, part) => sum + part.length, 0);
  const end = header([[0x06054b50, 4], [0, 2], [0, 2], [files.length, 2], [files.length, 2], [directorySize, 4], [offset, 4], [0, 2]]);
  return new Blob([...parts, ...directory, end], { type: 'application/zip' });
}
