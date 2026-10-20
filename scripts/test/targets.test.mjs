import { describe, expect, it } from 'vitest';
import { NATIVE_TARGETS, engineBinaryName, engineFormatProblem, wasmProblem } from '../lib/targets.mjs';
import { WASM_HEADER, elfHeader, importLibrary, machOHeader, peHeader } from './fixtures.mjs';

describe('engineFormatProblem', () => {
  it('accepts an executable of the right format and CPU for every native target', () => {
    const headers = {
      'linux-x64': elfHeader({ machine: 0x3e }),
      'linux-arm64': elfHeader({ machine: 0xb7 }),
      'linux-armhf': elfHeader({ elfClass: 1, machine: 0x28 }),
      'alpine-x64': elfHeader({ machine: 0x3e }),
      'alpine-arm64': elfHeader({ machine: 0xb7, type: 3 }),
      'darwin-x64': machOHeader({ cpu: 0x01000007 }),
      'darwin-arm64': machOHeader({ cpu: 0x0100000c }),
      'win32-x64': peHeader({ machine: 0x8664 }),
      'win32-arm64': peHeader({ machine: 0xaa64 }),
    };
    expect(Object.keys(headers).sort()).toEqual([...NATIVE_TARGETS].sort());
    for (const [target, header] of Object.entries(headers)) {
      expect(engineFormatProblem(header, target), target).toBeUndefined();
    }
  });

  it('rejects an MSVC import library packaged as the Windows engine', () => {
    expect(engineFormatProblem(importLibrary(), 'win32-x64')).toBe(
      'missing MZ header (found an ar archive or import library)',
    );
    expect(engineFormatProblem(importLibrary(), 'win32-arm64')).toMatch(/import library/);
  });

  it('rejects a PDB packaged as the Windows engine', () => {
    const pdb = Buffer.from('Microsoft C/C++ MSF 7.00\r\n\x1aDS\0\0\0', 'latin1');
    expect(engineFormatProblem(pdb, 'win32-x64')).toMatch(/PDB/);
  });

  it('rejects a binary built for the other CPU', () => {
    expect(engineFormatProblem(peHeader({ machine: 0xaa64 }), 'win32-x64')).toMatch(/PE machine 0xaa64 is not x64/);
    expect(engineFormatProblem(elfHeader({ machine: 0x3e }), 'linux-arm64')).toMatch(/ELF machine 0x3e is not arm64/);
    expect(engineFormatProblem(machOHeader({ cpu: 0x0100000c }), 'darwin-x64')).toMatch(/not x64/);
  });

  it('rejects a binary for another operating system', () => {
    expect(engineFormatProblem(elfHeader(), 'win32-x64')).toMatch(/missing MZ header \(found an ELF file\)/);
    expect(engineFormatProblem(peHeader(), 'linux-x64')).toMatch(/missing ELF magic \(found a PE file\)/);
    expect(engineFormatProblem(elfHeader(), 'darwin-arm64')).toMatch(/missing 64-bit Mach-O magic/);
  });

  it('rejects libraries, objects and GUI executables', () => {
    expect(engineFormatProblem(peHeader({ characteristics: 0x2022 }), 'win32-x64')).toBe('PE image is a DLL');
    expect(engineFormatProblem(peHeader({ subsystem: 2 }), 'win32-x64')).toMatch(/not a console application/);
    expect(engineFormatProblem(peHeader({ magic: 0x10b }), 'win32-x64')).toMatch(/not 64-bit/);
    expect(engineFormatProblem(elfHeader({ type: 1 }), 'linux-x64')).toMatch(/ELF type 1 is not an executable/);
    expect(engineFormatProblem(machOHeader({ fileType: 6 }), 'darwin-arm64')).toMatch(/not MH_EXECUTE/);
  });

  it('rejects a universal Mach-O and an empty file', () => {
    expect(engineFormatProblem(Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2]), 'darwin-arm64')).toMatch(/universal/);
    expect(engineFormatProblem(Buffer.alloc(0), 'linux-x64')).toMatch(/missing ELF magic/);
  });

  it('names the engine binary per platform', () => {
    expect(engineBinaryName('win32-arm64')).toBe('gitglasses-engine.exe');
    expect(engineBinaryName('alpine-x64')).toBe('gitglasses-engine');
  });
});

describe('wasmProblem', () => {
  it('accepts a version 1 module and rejects anything else', () => {
    expect(wasmProblem(WASM_HEADER)).toBeUndefined();
    expect(wasmProblem(Buffer.from('<!doctype html>'))).toBe('missing wasm magic');
  });
});
