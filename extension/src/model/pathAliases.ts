// Matching the engine's repository roots against the editor's paths when the
// two spell one directory differently. The engine reports a root the way
// libgit2 resolved it: symlinks followed on POSIX (realpath), 8.3 short names
// expanded on Windows (GetLongPathName), and the on-disk letter case on macOS.
// The editor keeps whatever spelling the workspace was opened with, so one
// directory can carry two names no text comparison reconciles. File identity
// does, and it also covers junctions and subst drives on Windows.
//
// Nothing here touches the filesystem: the identity lookup is injected, so the
// web host (which has no real filesystem) never pulls in node:fs, and tests can
// describe Windows layouts on any platform.

import * as path from 'node:path';

/** Device and inode of a file: the volume serial number and file index on
 *  Windows. Two paths with equal identities name the same directory. */
export interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

/** Reads a path's identity, or undefined when it cannot be read. */
export type IdentifyPath = (fsPath: string) => FileIdentity | undefined;

/** The path operations the walk needs; path.win32 or path.posix. */
export interface PathFlavor {
  dirname(fsPath: string): string;
}

/** Maps a directory the editor asked about onto its own spelling of the
 *  repository root the engine reported, or undefined when no ancestor of the
 *  directory is that root. */
export type AliasResolver = (dir: string, root: string) => string | undefined;

/**
 * The ancestor of `dir` (inclusive) that is the same directory as `root`,
 * compared by identity rather than by spelling, or undefined when none is.
 * The walk stats one path per level and runs once per repository spelling;
 * its answer is cached by the caller.
 */
export function sameDirectoryAncestor(
  dir: string,
  root: string,
  identify: IdentifyPath,
  flavor: PathFlavor = path,
): string | undefined {
  const target = identify(root);
  if (!target) return undefined;
  for (let current = dir; ; ) {
    const identity = identify(current);
    if (identity && identity.dev === target.dev && identity.ino === target.ino) return current;
    const parent = flavor.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** An alias resolver over the given identity lookup. */
export function identityAliasResolver(
  identify: IdentifyPath,
  flavor: PathFlavor = path,
): AliasResolver {
  return (dir, root) => sameDirectoryAncestor(dir, root, identify, flavor);
}
