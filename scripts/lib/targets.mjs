// VSIX targets and the executable format each one's engine must have.
//
// Native targets bundle the engine binary in extension/bin/; the `web` target
// carries only the browser bundle and the wasm engine. The engine's header is
// checked against the target before packaging and again in the finished VSIX,
// so an import library, debug database, shared library or a binary for
// another OS or CPU can never ship as the engine.

export const NATIVE_TARGETS = Object.freeze([
  'win32-x64',
  'win32-arm64',
  'linux-x64',
  'linux-arm64',
  'linux-armhf',
  'alpine-x64',
  'alpine-arm64',
  'darwin-x64',
  'darwin-arm64',
]);

export const WEB_TARGET = 'web';

export function isNativeTarget(target) {
  return NATIVE_TARGETS.includes(target);
}

export function engineBinaryName(target) {
  return target.startsWith('win32-') ? 'gitglasses-engine.exe' : 'gitglasses-engine';
}

/** Bytes of the file's start that engineFormatProblem needs to see. */
export const ENGINE_HEADER_BYTES = 4096;

// ELF: e_machine values, and the EI_CLASS each CPU uses (1 = 32-bit).
const ELF_MACHINE = { x64: 0x3e, arm64: 0xb7, armhf: 0x28 };
const ELF_CLASS = { x64: 2, arm64: 2, armhf: 1 };
const ELF_TYPE_EXEC = 2;
const ELF_TYPE_DYN = 3; // position-independent executables

// Mach-O (64-bit, little-endian): cputype values and MH_EXECUTE.
const MACHO_MAGIC_64 = 0xfeedfacf;
const MACHO_CPU = { x64: 0x01000007, arm64: 0x0100000c };
const MACHO_EXECUTE = 2;

// PE/COFF: machine values, characteristics bits and the console subsystem.
const PE_MACHINE = { x64: 0x8664, arm64: 0xaa64 };
const PE_EXECUTABLE_IMAGE = 0x0002;
const PE_DLL = 0x2000;
const PE32_PLUS = 0x20b;
const PE_SUBSYSTEM_CONSOLE = 3;

/**
 * Explains why `header` (the first ENGINE_HEADER_BYTES of a file) is not an
 * engine executable for `target`, or returns undefined when it is one.
 */
export function engineFormatProblem(header, target) {
  if (!isNativeTarget(target)) return `${target} is not a native target`;
  const [os, arch] = target.split('-');
  if (os === 'linux' || os === 'alpine') return elfProblem(header, arch);
  if (os === 'darwin') return machOProblem(header, arch);
  return peProblem(header, arch);
}

function elfProblem(header, arch) {
  if (header.length < 20 || header.readUInt32BE(0) !== 0x7f454c46) {
    return describeUnknown(header, 'missing ELF magic');
  }
  if (header[4] !== ELF_CLASS[arch]) return `ELF class ${header[4]} is wrong for ${arch}`;
  if (header[5] !== 1) return 'ELF file is not little-endian';
  const type = header.readUInt16LE(16);
  if (type !== ELF_TYPE_EXEC && type !== ELF_TYPE_DYN)
    return `ELF type ${type} is not an executable`;
  const machine = header.readUInt16LE(18);
  if (machine !== ELF_MACHINE[arch]) return `ELF machine 0x${machine.toString(16)} is not ${arch}`;
  return undefined;
}

function machOProblem(header, arch) {
  if (header.length >= 4 && header.readUInt32BE(0) === 0xcafebabe) {
    return 'universal (fat) Mach-O; package one architecture per target';
  }
  if (header.length < 16 || header.readUInt32LE(0) !== MACHO_MAGIC_64) {
    return describeUnknown(header, 'missing 64-bit Mach-O magic');
  }
  const cpu = header.readUInt32LE(4);
  if (cpu !== MACHO_CPU[arch]) return `Mach-O cputype 0x${cpu.toString(16)} is not ${arch}`;
  const fileType = header.readUInt32LE(12);
  if (fileType !== MACHO_EXECUTE) return `Mach-O filetype ${fileType} is not MH_EXECUTE`;
  return undefined;
}

function peProblem(header, arch) {
  if (header.length < 0x40 || header.toString('latin1', 0, 2) !== 'MZ') {
    return describeUnknown(header, 'missing MZ header');
  }
  const pe = header.readUInt32LE(0x3c);
  // Signature (4) + COFF header (20) + PE32+ optional header up to Subsystem (70).
  if (pe + 94 > header.length) return 'PE header lies outside the file start';
  if (header.toString('latin1', pe, pe + 4) !== 'PE\0\0') return 'missing PE signature';
  const machine = header.readUInt16LE(pe + 4);
  if (machine !== PE_MACHINE[arch]) return `PE machine 0x${machine.toString(16)} is not ${arch}`;
  const characteristics = header.readUInt16LE(pe + 22);
  if ((characteristics & PE_DLL) !== 0) return 'PE image is a DLL';
  if ((characteristics & PE_EXECUTABLE_IMAGE) === 0) return 'PE image is not executable';
  const optional = pe + 24;
  if (header.readUInt16LE(optional) !== PE32_PLUS) return 'PE image is not 64-bit (PE32+)';
  const subsystem = header.readUInt16LE(optional + 68);
  if (subsystem !== PE_SUBSYSTEM_CONSOLE)
    return `PE subsystem ${subsystem} is not a console application`;
  return undefined;
}

// Names the file types most likely to be picked up by mistake from a build
// directory, so the error says what was found instead.
function describeUnknown(header, problem) {
  if (header.toString('latin1', 0, 8) === '!<arch>\n')
    return `${problem} (found an ar archive or import library)`;
  if (header.toString('latin1', 0, 19) === 'Microsoft C/C++ MSF')
    return `${problem} (found a PDB debug database)`;
  if (header.length >= 4 && header.readUInt32BE(0) === 0x7f454c46)
    return `${problem} (found an ELF file)`;
  if (header.length >= 2 && header.toString('latin1', 0, 2) === 'MZ')
    return `${problem} (found a PE file)`;
  if (header.length >= 4 && header.readUInt32LE(0) === MACHO_MAGIC_64)
    return `${problem} (found a Mach-O file)`;
  return problem;
}

/** Explains why `header` is not a WebAssembly (version 1) module, or returns undefined. */
export function wasmProblem(header) {
  if (header.length < 8 || header.toString('latin1', 0, 4) !== '\0asm') return 'missing wasm magic';
  const version = header.readUInt32LE(4);
  if (version !== 1) return `wasm version ${version} is not 1`;
  return undefined;
}
