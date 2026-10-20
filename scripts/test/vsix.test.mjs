import { describe, expect, it } from 'vitest';
import { inspectVsix } from '../lib/vsix.mjs';
import { readZipEntries, readZipEntry } from '../lib/zip.mjs';
import {
  elfHeader,
  importLibrary,
  makeZip,
  peHeader,
  pngHeader,
  vsixFiles,
  vsixManifest,
} from './fixtures.mjs';

const linuxEngine = { name: 'extension/bin/gitglasses-engine', data: elfHeader(), mode: 0o755 };
const windowsEngine = { name: 'extension/bin/gitglasses-engine.exe', data: peHeader() };

function replace(files, name, change) {
  return files
    .map((file) => (file.name === name ? { ...file, ...change } : file))
    .filter((file) => file.data !== null);
}

describe('zip reader', () => {
  it('round-trips names, contents and modes', () => {
    const archive = makeZip([
      { name: 'a.txt', data: 'hello' },
      { name: 'bin/tool', data: Buffer.alloc(5000, 7), mode: 0o755 },
    ]);
    const entries = readZipEntries(archive);
    expect([...entries.keys()]).toEqual(['a.txt', 'bin/tool']);
    expect(readZipEntry(archive, entries.get('a.txt')).toString()).toBe('hello');
    expect(readZipEntry(archive, entries.get('bin/tool')).equals(Buffer.alloc(5000, 7))).toBe(true);
    expect(entries.get('bin/tool').mode).toBe(0o755);
  });

  it('rejects something that is not a zip', () => {
    expect(() => readZipEntries(Buffer.from('not a zip at all, just text'))).toThrow(
      /not a zip archive/,
    );
  });
});

describe('inspectVsix', () => {
  it('passes a complete native package and returns its engine', () => {
    const result = inspectVsix(makeZip(vsixFiles('linux-x64', { engine: linuxEngine })), {
      target: 'linux-x64',
      version: '0.2.0',
    });
    expect(result.problems).toEqual([]);
    expect(result.engine.name).toBe('extension/bin/gitglasses-engine');
  });

  it('passes a complete web package', () => {
    expect(
      inspectVsix(makeZip(vsixFiles('web')), { target: 'web', version: '0.2.0' }).problems,
    ).toEqual([]);
  });

  it('fails a Windows package whose engine is the import library', () => {
    const files = vsixFiles('win32-x64', { engine: { ...windowsEngine, data: importLibrary() } });
    expect(inspectVsix(makeZip(files), { target: 'win32-x64' }).problems).toEqual([
      'engine is not a win32-x64 executable: missing MZ header (found an ar archive or import library)',
    ]);
  });

  it('fails a package for the wrong target platform', () => {
    const files = replace(
      vsixFiles('win32-x64', { engine: windowsEngine }),
      'extension.vsixmanifest',
      {
        data: vsixManifest('win32-arm64'),
      },
    );
    expect(inspectVsix(makeZip(files), { target: 'win32-x64' }).problems).toEqual([
      'target platform is win32-arm64, expected win32-x64',
    ]);
  });

  it('fails a native package without its engine, with extra binaries, or with a non-executable engine', () => {
    const missing = inspectVsix(makeZip(vsixFiles('linux-x64')), { target: 'linux-x64' }).problems;
    expect(missing).toEqual(['extension/bin/gitglasses-engine is missing']);

    const extra = vsixFiles('win32-x64', {
      engine: windowsEngine,
    }).concat([{ name: 'extension/bin/gitglasses-engine.pdb', data: 'pdb' }]);
    expect(inspectVsix(makeZip(extra), { target: 'win32-x64' }).problems).toEqual([
      'unexpected files next to the engine: extension/bin/gitglasses-engine.pdb',
    ]);

    const noExec = vsixFiles('linux-x64', { engine: { ...linuxEngine, mode: 0o644 } });
    expect(inspectVsix(makeZip(noExec), { target: 'linux-x64' }).problems).toEqual([
      'engine is not marked executable',
    ]);
  });

  it('fails a web package that carries a native engine or lacks the wasm engine', () => {
    const withBin = vsixFiles('web', { engine: linuxEngine });
    expect(inspectVsix(makeZip(withBin), { target: 'web' }).problems).toEqual([
      'web package carries native files: extension/bin/gitglasses-engine',
    ]);
    const noWasm = replace(vsixFiles('web'), 'extension/dist/web/gitglasses-engine-wasm.wasm', {
      data: null,
    });
    expect(inspectVsix(makeZip(noWasm), { target: 'web' }).problems).toEqual([
      'extension/dist/web/gitglasses-engine-wasm.wasm is missing',
    ]);
  });

  it('fails a package without license, notices, changelog entry or a usable icon', () => {
    let files = vsixFiles('linux-x64', { engine: linuxEngine });
    files = replace(files, 'extension/LICENSE.txt', { data: null });
    files = replace(files, 'extension/NOTICE', { data: null });
    files = replace(files, 'extension/changelog.md', { data: '# Changelog\n\n## [0.1.2]\n' });
    files = replace(files, 'extension/media/icon.png', { data: pngHeader(64, 64) });
    expect(inspectVsix(makeZip(files), { target: 'linux-x64', version: '0.2.0' }).problems).toEqual(
      [
        'icon media/icon.png is 64x64; it must be square and at least 128px',
        'LICENSE is missing',
        'NOTICE is missing',
        'CHANGELOG.md has no entry for 0.2.0',
      ],
    );
  });

  it('fails a package whose version is not the release version', () => {
    const files = vsixFiles('linux-x64', { engine: linuxEngine, version: '0.1.2' });
    expect(inspectVsix(makeZip(files), { target: 'linux-x64', version: '0.2.0' }).problems).toEqual(
      ['package.json version is 0.1.2, expected 0.2.0', 'CHANGELOG.md has no entry for 0.2.0'],
    );
  });
});
