// Builders for the binary headers and zip archives the tests feed to the
// release scripts.

import { crc32, deflateRawSync } from 'node:zlib';

export function elfHeader({ elfClass = 2, type = 2, machine = 0x3e } = {}) {
  const header = Buffer.alloc(64);
  header.write('\x7fELF', 0, 'latin1');
  header[4] = elfClass;
  header[5] = 1; // little-endian
  header[6] = 1;
  header.writeUInt16LE(type, 16);
  header.writeUInt16LE(machine, 18);
  return header;
}

export function machOHeader({ cpu = 0x0100000c, fileType = 2 } = {}) {
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(cpu, 4);
  header.writeUInt32LE(fileType, 12);
  return header;
}

export function peHeader({
  machine = 0x8664,
  characteristics = 0x0022,
  magic = 0x20b,
  subsystem = 3,
} = {}) {
  const pe = 0x80;
  const header = Buffer.alloc(0x200);
  header.write('MZ', 0, 'latin1');
  header.writeUInt32LE(pe, 0x3c);
  header.write('PE\0\0', pe, 'latin1');
  header.writeUInt16LE(machine, pe + 4);
  header.writeUInt16LE(characteristics, pe + 22);
  header.writeUInt16LE(magic, pe + 24);
  header.writeUInt16LE(subsystem, pe + 24 + 68);
  return header;
}

/** An MSVC import library starts like any ar archive. */
export function importLibrary() {
  return Buffer.concat([Buffer.from('!<arch>\n', 'latin1'), Buffer.alloc(120)]);
}

export function pngHeader(width, height) {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'latin1');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
}

export const WASM_HEADER = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

/**
 * Writes a zip archive the way vsce does: deflated entries, with each
 * entry's POSIX mode in the upper half of its external attributes.
 */
export function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data, mode = 0o644 } of files) {
    const contents = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    const compressed = deflateRawSync(contents);
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(contents);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(contents.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by: UNIX
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(contents.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(((0o100000 | mode) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += local.length + nameBytes.length + compressed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

export function vsixManifest(target) {
  return (
    '<?xml version="1.0" encoding="utf-8"?>\n<PackageManifest Version="2.0.0">' +
    `<Metadata><Identity Language="en-US" Id="gitglasses" Version="0.2.0" Publisher="gitglasses" TargetPlatform="${target}"/>` +
    '<License>extension/LICENSE.txt</License></Metadata></PackageManifest>'
  );
}

/** The entries of a releasable VSIX for `target`; tests then break one. */
export function vsixFiles(target, { engine, version = '0.2.0' } = {}) {
  const files = [
    { name: 'extension.vsixmanifest', data: vsixManifest(target) },
    {
      name: 'extension/package.json',
      data: JSON.stringify({
        name: 'gitglasses',
        version,
        icon: 'media/icon.png',
        browser: './dist/web/extension.js',
      }),
    },
    { name: 'extension/media/icon.png', data: pngHeader(256, 256) },
    { name: 'extension/LICENSE.txt', data: 'MIT License' },
    { name: 'extension/NOTICE', data: 'GitGlasses third-party notices' },
    { name: 'extension/changelog.md', data: `# Changelog\n\n## [${version}]\n\n- Fixes.\n` },
    { name: 'extension/dist/extension.js', data: '' },
    {
      name: 'extension/dist/mcp/cli.js',
      data: `#!/usr/bin/env node\n"use strict";var v="${version}";require("node:fs");\n`,
    },
    { name: 'extension/dist/web/extension.js', data: '' },
    { name: 'extension/dist/web/gitglasses-engine-wasm.wasm', data: WASM_HEADER },
  ];
  if (engine) files.push(engine);
  return files;
}
