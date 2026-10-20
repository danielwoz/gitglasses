// git_compare: what one revision changes against another, measured from the
// point where the two diverged, so commits that landed on the base afterwards
// never read as changes the head reverted.

import { z } from 'zod';
import type { FileChange, RequestResult } from '@gitglasses/protocol';
import { shortSha } from '@gitglasses/protocol/sha';
import type { EngineClient } from '@gitglasses/rpc';
import { binaryPathsInPatch, changeLine, formatCommits, truncateText } from '../format.js';

/** Commits listed when the caller does not ask for a specific count. */
export const DEFAULT_COMPARE_COMMITS = 50;
/** Ceiling on the listed commits; the counts always cover all of them. */
export const MAX_COMPARE_COMMITS = 500;

export interface CompareArgs {
  repoPath: string;
  base: string;
  head?: string;
  includeDiff?: boolean;
  limit?: number;
  maxChars?: number;
}

export interface CompareRendering {
  /** The revisions as the caller named them. */
  baseName: string;
  headName: string;
  compared: RequestResult<'log/compare'>;
  /** Files changed between the merge base (or the base, for unrelated
   *  histories) and the head. */
  files: readonly FileChange[];
  /** Paths whose change is binary. */
  binaryPaths?: ReadonlySet<string>;
  /** Unified diff from the same starting point. */
  diff?: string;
  /** Why the diff was asked for but left out. */
  diffOmitted?: string;
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

/**
 * The comparison as text: where the two revisions meet, how far apart they
 * are, head's own commits, and the files (and optionally the diff) head
 * changed since the merge base.
 */
export function formatCompare(rendering: CompareRendering): string {
  const { baseName, headName, compared, files } = rendering;
  const lines = [
    `compare ${baseName}...${headName}`,
    `base: ${baseName} ${shortSha(compared.base)}, head: ${headName} ${shortSha(compared.head)}, ` +
      `merge base: ${compared.mergeBase ? shortSha(compared.mergeBase) : 'none'}`,
  ];
  if (compared.ahead === 0 && compared.behind === 0) {
    lines.push(`${headName} and ${baseName} point at the same commit`);
    return lines.join('\n');
  }
  lines.push(
    `${headName} is ${plural(compared.ahead, 'commit')} ahead of ${baseName} and ` +
      `${compared.behind} behind`,
  );
  if (compared.mergeBase === undefined) {
    lines.push('the histories share no commit, so the files below compare the two trees directly');
  } else if (compared.behind > 0) {
    lines.push(
      `the ${plural(compared.behind, 'commit')} only on ${baseName} are left out of the files ` +
        'below, which start at the merge base',
    );
  }

  lines.push('', `commits on ${headName} not on ${baseName} (${compared.ahead}):`);
  if (compared.commits.length > 0) {
    lines.push(
      ...formatCommits(compared.commits)
        .split('\n')
        .map((line) => `  ${line}`),
    );
  }
  if (compared.commits.length < compared.ahead) {
    lines.push(
      `  (showing the newest ${compared.commits.length}; raise "limit" (max ${MAX_COMPARE_COMMITS}) for more)`,
    );
  }

  const binaryPaths = rendering.binaryPaths ?? new Set<string>();
  const since = compared.mergeBase === undefined ? baseName : 'the merge base';
  lines.push('', `files changed on ${headName} since ${since} (${files.length}):`);
  lines.push(
    ...files.map((file) => `  ${changeLine(file, { binary: binaryPaths.has(file.path) })}`),
  );

  if (rendering.diff !== undefined) {
    lines.push('', 'diff:', rendering.diff.replace(/\n$/, ''));
  } else if (rendering.diffOmitted !== undefined) {
    lines.push('', `(diff omitted: ${rendering.diffOmitted})`);
  }
  return lines.join('\n');
}

export interface CompareContext {
  client: EngineClient;
  repoId: string;
  /** Character limit of the whole result. */
  maxChars: number;
  /** What to suggest when the result is cut at `maxChars`. */
  truncationHint: (narrow: string) => string;
  /** Why the diff is left out when patch/create fails with `error`, or
   *  undefined when the failure should fail the call. */
  diffUnavailable: (error: unknown) => string | undefined;
}

/** git_compare's handler, given the repository it was resolved to. */
export async function compareRevisions(
  args: CompareArgs,
  context: CompareContext,
): Promise<string> {
  const { client, repoId } = context;
  const headName = args.head ?? 'HEAD';
  const compared = await client.request('log/compare', {
    repoId,
    base: args.base,
    head: headName,
    limit: Math.min(args.limit ?? DEFAULT_COMPARE_COMMITS, MAX_COMPARE_COMMITS),
  });
  // From the merge base, the changes are head's alone; unrelated histories
  // have none, so their trees are compared directly.
  const from = compared.mergeBase ?? compared.base;
  const { files } = await client.request('diff/refs', { repoId, base: from, head: compared.head });

  let diff: string | undefined;
  let diffOmitted: string | undefined;
  if (args.includeDiff && files.length > 0) {
    try {
      const { envelope } = await client.request('patch/create', {
        repoId,
        source: { kind: 'range', base: from, head: compared.head },
      });
      diff = envelope.patch;
    } catch (error) {
      diffOmitted = context.diffUnavailable(error);
      if (diffOmitted === undefined) throw error;
    }
  }
  const rendered = formatCompare({
    baseName: args.base,
    headName,
    compared,
    files,
    binaryPaths: diff === undefined ? undefined : binaryPathsInPatch(diff),
    diff,
    diffOmitted,
  });
  return truncateText(
    rendered,
    context.maxChars,
    context.truncationHint(
      args.includeDiff
        ? 'omit "includeDiff" for the commits and files alone, then git_commit_show one commit'
        : 'lower "limit" to list fewer commits',
    ),
  );
}

/** git_compare's input schema, built on the shared repoPath and maxChars. */
export function compareInputSchema(shared: { repoPath: z.ZodString; maxChars: z.ZodTypeAny }) {
  return {
    repoPath: shared.repoPath,
    base: z
      .string()
      .min(1)
      .regex(/^[^-]/, 'a revision cannot start with "-"')
      .describe('Revision compared against, such as main, origin/main or a tag'),
    head: z
      .string()
      .min(1)
      .regex(/^[^-]/, 'a revision cannot start with "-"')
      .optional()
      .describe('Revision compared, such as a feature branch (default HEAD)'),
    includeDiff: z
      .boolean()
      .optional()
      .describe(
        'Append the unified diff from the merge base to head (default false). The diff ' +
          'needs git, so outside the directories the server was started with (--allow) ' +
          'it is omitted with a note.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_COMPARE_COMMITS)
      .optional()
      .describe(
        `Maximum commits to list (default ${DEFAULT_COMPARE_COMMITS}); the ahead and behind counts cover all of them`,
      ),
    maxChars: shared.maxChars,
  };
}

export const COMPARE_DESCRIPTION =
  'What a branch changes compared with another, such as "my branch vs main": the merge base, ' +
  'commits ahead and behind, the commits only on head, and the files head changed since the ' +
  'merge base with +/- counts (commits that landed on base later are not shown as changes). ' +
  'With includeDiff, the unified diff too.';
