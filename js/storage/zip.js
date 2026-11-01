// js/storage/zip.js
//
// Owns: the zip container for a project file (step 7a) — writing and
// reading a plain zip with every entry *stored* (not compressed): the
// project's PNGs and sound files are compressed already, so deflating
// them again would cost time on the iPad for almost nothing. Our own
// code, not a library (no third-party code — PROJECT_NOTES.md).
//
// Only what a project file needs: stored entries, UTF-8 names, no
// zip64 (a file under 4 GB, far beyond any project), no encryption.
// The reader refuses anything else rather than guessing. Pure: no
// IndexedDB, no DOM — unit-tested in Node.

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const LOCAL_HEADER = 30;
const CENTRAL_HEADER = 46;
const END_RECORD = 22;
const MAX_COMMENT = 0xffff;
const FLAG_UTF8 = 0x0800;
const METHOD_STORED = 0;
const VERSION = 20; // 2.0: what readers expect for folders and stored entries
const MAX_32 = 0xffffffff;

let crcTable = null;

// CRC-32 (the zip/PNG one). Every entry carries it, and readers —
// ours included — check it, so a damaged file is caught on opening.
export function crc32(bytes, crc = 0) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

// entries: [{ name, data: Uint8Array }]. Returns a Blob of the zip
// (type `type`). The data arrays are referenced, not copied, until the
// Blob is built.
export function makeZip(entries, { type = 'application/zip', now = new Date() } = {}) {
  const encoder = new TextEncoder();
  const { time, date } = dosDateTime(now);
  const parts = [];
  const central = [];
  let offset = 0;
  const seen = new Set();
  for (const { name, data } of entries) {
    if (seen.has(name)) throw new Error(`Duplicate zip entry: ${name}`);
    seen.add(name);
    const nameBytes = encoder.encode(name);
    const crc = crc32(data);
    const size = data.length;
    if (size > MAX_32 || offset > MAX_32) throw new Error('Too big for a zip without zip64');

    const local = new DataView(new ArrayBuffer(LOCAL_HEADER));
    local.setUint32(0, SIG_LOCAL, true);
    local.setUint16(4, VERSION, true);
    local.setUint16(6, FLAG_UTF8, true);
    local.setUint16(8, METHOD_STORED, true);
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), nameBytes, data);

    const head = new DataView(new ArrayBuffer(CENTRAL_HEADER));
    head.setUint32(0, SIG_CENTRAL, true);
    head.setUint16(4, VERSION, true);
    head.setUint16(6, VERSION, true);
    head.setUint16(8, FLAG_UTF8, true);
    head.setUint16(10, METHOD_STORED, true);
    head.setUint16(12, time, true);
    head.setUint16(14, date, true);
    head.setUint32(16, crc, true);
    head.setUint32(20, size, true);
    head.setUint32(24, size, true);
    head.setUint16(28, nameBytes.length, true);
    // extra, comment, disk, internal attrs, external attrs: 0
    head.setUint32(42, offset, true);
    central.push(new Uint8Array(head.buffer), nameBytes);

    offset += LOCAL_HEADER + nameBytes.length + size;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  if (entries.length > 0xffff || offset > MAX_32) throw new Error('Too big for a zip without zip64');
  const end = new DataView(new ArrayBuffer(END_RECORD));
  end.setUint32(0, SIG_END, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type });
}

export class ZipError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ZipError';
  }
}

async function bytesOf(blob, start, end) {
  return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

// Reads a zip's directory. Returns { names, has(name), read(name) }:
// read resolves the entry's bytes (Uint8Array), checked against its
// CRC. Only the bytes asked for are read, so a big file isn't loaded
// whole just to list it. Throws ZipError for anything that isn't a
// zip this module could have written (compressed, encrypted, zip64,
// damaged).
export async function readZip(blob) {
  const tailStart = Math.max(0, blob.size - (END_RECORD + MAX_COMMENT));
  const tail = await bytesOf(blob, tailStart, blob.size);
  const tailView = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let endAt = -1;
  for (let i = tail.length - END_RECORD; i >= 0; i--) {
    if (tailView.getUint32(i, true) === SIG_END) { endAt = i; break; }
  }
  if (endAt < 0) throw new ZipError('Not a zip file');
  const count = tailView.getUint16(endAt + 10, true);
  const centralSize = tailView.getUint32(endAt + 12, true);
  const centralOffset = tailView.getUint32(endAt + 16, true);
  if (centralOffset === MAX_32 || count === 0xffff) throw new ZipError('zip64 is not supported');
  if (centralOffset + centralSize > blob.size) throw new ZipError('The zip is cut short');

  const dir = await bytesOf(blob, centralOffset, centralOffset + centralSize);
  const view = new DataView(dir.buffer, dir.byteOffset, dir.byteLength);
  const decoder = new TextDecoder();
  const entries = new Map();
  let at = 0;
  for (let n = 0; n < count; n++) {
    if (at + CENTRAL_HEADER > dir.length || view.getUint32(at, true) !== SIG_CENTRAL) {
      throw new ZipError('The zip directory is damaged');
    }
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const compressed = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localOffset = view.getUint32(at + 42, true);
    const name = decoder.decode(dir.subarray(at + CENTRAL_HEADER, at + CENTRAL_HEADER + nameLength));
    if (flags & 0x0001) throw new ZipError('Encrypted zips are not supported');
    if (method !== METHOD_STORED || compressed !== size) throw new ZipError('Compressed zips are not supported');
    entries.set(name, { crc, size, localOffset });
    at += CENTRAL_HEADER + nameLength + extraLength + commentLength;
  }

  async function read(name) {
    const entry = entries.get(name);
    if (!entry) throw new ZipError(`Missing from the zip: ${name}`);
    const header = await bytesOf(blob, entry.localOffset, entry.localOffset + LOCAL_HEADER);
    const local = new DataView(header.buffer, header.byteOffset, header.byteLength);
    if (header.length < LOCAL_HEADER || local.getUint32(0, true) !== SIG_LOCAL) {
      throw new ZipError('The zip is damaged');
    }
    const start = entry.localOffset + LOCAL_HEADER + local.getUint16(26, true) + local.getUint16(28, true);
    if (start + entry.size > blob.size) throw new ZipError('The zip is cut short');
    const data = await bytesOf(blob, start, start + entry.size);
    if (crc32(data) !== entry.crc) throw new ZipError(`Damaged in the zip: ${name}`);
    return data;
  }

  return {
    names: [...entries.keys()],
    has: (name) => entries.has(name),
    read,
  };
}
