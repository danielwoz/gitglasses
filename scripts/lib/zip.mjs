// Minimal reader for the zip archives vsce writes (stored and deflated
// entries, no zip64), so a VSIX can be inspected on every runner without an
// unzip tool or a dependency.

import { inflateRawSync } from 'node:zlib';

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;

/**
 * Lists the archive's entries by name. Each entry carries its POSIX mode
 * (0 when the archive was written without one).
 */
export function readZipEntries(archive) {
  const end = findEndOfCentralDirectory(archive);
  const count = archive.readUInt16LE(end + 10);
  let offset = archive.readUInt32LE(end + 16);
  if (count === 0xffff || offset === 0xffffffff)
    throw new Error('zip64 archives are not supported');

  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (archive.readUInt32LE(offset) !== CENTRAL_FILE_HEADER) {
      throw new Error(`corrupt zip: bad central directory entry ${i}`);
    }
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const name = archive.toString('utf8', offset + 46, offset + 46 + nameLength);
    entries.set(name, {
      name,
      method: archive.readUInt16LE(offset + 10),
      compressedSize: archive.readUInt32LE(offset + 20),
      size: archive.readUInt32LE(offset + 24),
      mode: (archive.readUInt32LE(offset + 38) >>> 16) & 0o7777,
      localHeaderOffset: archive.readUInt32LE(offset + 42),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Returns the uncompressed contents of one entry from readZipEntries. */
export function readZipEntry(archive, entry) {
  const local = entry.localHeaderOffset;
  if (archive.readUInt32LE(local) !== LOCAL_FILE_HEADER) {
    throw new Error(`corrupt zip: bad local header for ${entry.name}`);
  }
  const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
  const data = archive.subarray(start, start + entry.compressedSize);
  let contents;
  if (entry.method === 0) contents = Buffer.from(data);
  else if (entry.method === 8) contents = inflateRawSync(data);
  else throw new Error(`unsupported compression method ${entry.method} for ${entry.name}`);
  if (contents.length !== entry.size)
    throw new Error(`corrupt zip: size mismatch for ${entry.name}`);
  return contents;
}

function findEndOfCentralDirectory(archive) {
  // The record is 22 bytes plus a comment of at most 65535 bytes.
  const earliest = Math.max(0, archive.length - 22 - 0xffff);
  for (let offset = archive.length - 22; offset >= earliest; offset--) {
    if (archive.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) return offset;
  }
  throw new Error('not a zip archive: no end of central directory record');
}
