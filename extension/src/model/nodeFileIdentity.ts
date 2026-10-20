// File identity read from the local filesystem. Node host only: the web host
// has no real filesystem, and its bundle must not pull in node:fs.

import * as fs from 'node:fs';
import type { FileIdentity } from './pathAliases';

/** The path's device and inode (volume serial and file index on Windows),
 *  following symlinks and junctions, or undefined when it cannot be read. */
export function nodeFileIdentity(fsPath: string): FileIdentity | undefined {
  try {
    const stats = fs.statSync(fsPath, { bigint: true, throwIfNoEntry: false });
    // Filesystems without stable file numbers report 0, which would make
    // every directory on them look like the same one.
    if (!stats || stats.ino === 0n) return undefined;
    return { dev: stats.dev, ino: stats.ino };
  } catch {
    return undefined;
  }
}
