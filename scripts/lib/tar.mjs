// Minimal reader for the gzipped ustar archives `npm pack` writes.

import { gunzipSync } from 'node:zlib';

const BLOCK = 512;

/** Maps each regular file's path in a .tgz to its contents and mode. */
export function readTarGz(data) {
  const tar = gunzipSync(data);
  const files = new Map();
  for (let offset = 0; offset + BLOCK <= tar.length;) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const field = (start, length) =>
      header.toString('utf8', start, start + length).replace(/\0[\s\S]*$/, '');
    const mode = parseInt(field(100, 8).trim() || '0', 8);
    const size = parseInt(field(124, 12).trim() || '0', 8);
    const type = field(156, 1);
    const prefix = field(257, 6) === 'ustar' ? field(345, 155) : '';
    const name = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100);
    const start = offset + BLOCK;
    if (type === '' || type === '0')
      files.set(name, { data: tar.subarray(start, start + size), mode });
    offset = start + Math.ceil(size / BLOCK) * BLOCK;
  }
  return files;
}
