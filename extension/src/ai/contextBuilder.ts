// Pure prompt-context assembly: ranks changed files, drops generated noise,
// and fits patches into a token budget by truncating the biggest first.

export interface DiffFile {
  path: string;
  /** Patch/diff text (or a content excerpt when no patch is available). */
  patch: string;
}

export type FileCategory = 'source' | 'config' | 'docs';

const GENERATED_PATTERNS: RegExp[] = [
  /\.lock$/i,
  /(^|\/)package-lock\.json$/i,
  /(^|\/)pnpm-lock\.yaml$/i,
  /(^|\/)yarn\.lock$/i,
  /\.min\.(js|css)$/i,
  /(^|\/)dist\//,
  /(^|\/)out\//,
  /(^|\/)node_modules\//,
  /(^|\/)generated(\/|$)/i,
  /\.generated\./i,
  /\.snap$/,
];

/** Lockfiles, bundles, vendored and generated output — noise for a model. */
export function isGeneratedPath(path: string): boolean {
  return GENERATED_PATTERNS.some((pattern) => pattern.test(path));
}

const DOC_PATTERNS: RegExp[] = [/\.(md|markdown|rst|txt|adoc)$/i, /(^|\/)(docs?|documentation)\//i];

const CONFIG_PATTERNS: RegExp[] = [
  /\.(json|jsonc|ya?ml|toml|ini|cfg|conf|properties|env)$/i,
  /(^|\/)\.[^/]+rc([.][^/]*)?$/,
  /(^|\/)(Dockerfile|Makefile|CMakeLists\.txt)$/,
];

export function categorizeFile(path: string): FileCategory {
  if (DOC_PATTERNS.some((pattern) => pattern.test(path))) return 'docs';
  if (CONFIG_PATTERNS.some((pattern) => pattern.test(path))) return 'config';
  return 'source';
}

const CATEGORY_WEIGHT: Record<FileCategory, number> = { source: 0, config: 1, docs: 2 };

/** Stable sort: source before config before docs; original order within. */
export function rankFiles<T extends { path: string }>(files: readonly T[]): T[] {
  return files
    .map((file, index) => ({ file, index }))
    .sort(
      (a, b) =>
        CATEGORY_WEIGHT[categorizeFile(a.file.path)] -
          CATEGORY_WEIGHT[categorizeFile(b.file.path)] || a.index - b.index,
    )
    .map((entry) => entry.file);
}

/** The `max` files most worth showing a model: ranked source > config >
 *  docs, with generated files last so they are only named, never read. */
export function pickFilesToShow<T extends { path: string }>(files: readonly T[], max: number): T[] {
  const generated = files.filter((file) => isGeneratedPath(file.path));
  const kept = files.filter((file) => !isGeneratedPath(file.path));
  return [...rankFiles(kept), ...generated].slice(0, max);
}

/** Largest commit whose whole patch is read for a model. A bigger one (a
 *  vendor drop, an initial import) would mostly be cut from the context, so
 *  only the files that can fit are read instead. */
export const WHOLE_PATCH_MAX_FILES = 300;
export const WHOLE_PATCH_MAX_LINES = 30_000;

export function wholePatchFits(commit: {
  truncated: boolean;
  files: readonly unknown[];
  stats: { additions: number; deletions: number };
}): boolean {
  return (
    !commit.truncated &&
    commit.files.length <= WHOLE_PATCH_MAX_FILES &&
    commit.stats.additions + commit.stats.deletions <= WHOLE_PATCH_MAX_LINES
  );
}

export const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

const TRUNCATION_MARKER = '\n… [truncated]';
/** A patch allocation below this is useless; drop the file instead. */
const MIN_PATCH_CHARS = 160;

/** Largest per-file cap so that sum(min(len, cap)) fits the budget, or
 *  undefined when even the smallest files cannot all fit. Exported for tests:
 *  this is what makes truncation take from the biggest files first. */
export function biggestFirstCap(lengths: readonly number[], budgetChars: number): number | undefined {
  const sorted = [...lengths].sort((a, b) => a - b);
  const total = sorted.reduce((sum, length) => sum + length, 0);
  if (total <= budgetChars) return Number.MAX_SAFE_INTEGER;
  let prefix = 0;
  for (let i = 0; i < sorted.length; i++) {
    const remainingFiles = sorted.length - i;
    // All files from i onward would be capped; does an equal share fit?
    if (prefix + remainingFiles * sorted[i] > budgetChars) {
      const cap = Math.floor((budgetChars - prefix) / remainingFiles);
      return cap >= MIN_PATCH_CHARS ? cap : undefined;
    }
    prefix += sorted[i];
  }
  return Number.MAX_SAFE_INTEGER;
}

export interface DiffContext {
  text: string;
  includedPaths: string[];
  omittedPaths: string[];
  truncated: boolean;
}

function sectionHeader(path: string): string {
  return `=== ${path} ===\n`;
}

function omissionNote(omitted: readonly string[]): string {
  const shown = omitted.slice(0, 8).join(', ');
  const suffix = omitted.length > 8 ? ', …' : '';
  return `\n… and ${omitted.length} more file${omitted.length === 1 ? '' : 's'} omitted: ${shown}${suffix}\n`;
}

/** Assembles diff sections into a budget of ~budgetTokens tokens. Generated
 *  files are dropped, remaining files ranked source > config > docs, and when
 *  the budget is exceeded the biggest patches are truncated first; files that
 *  still don't fit are omitted lowest-ranked first, with a note. */
export function buildDiffContext(files: readonly DiffFile[], budgetTokens: number): DiffContext {
  const kept = files.filter((file) => !isGeneratedPath(file.path));
  const generated = files.filter((file) => isGeneratedPath(file.path)).map((file) => file.path);
  if (kept.length === 0) {
    return {
      text: generated.length === 0 ? '(no changes)' : `(no changes)${omissionNote(generated)}`,
      includedPaths: [],
      omittedPaths: generated,
      truncated: false,
    };
  }

  const ranked = rankFiles(kept);
  const budgetChars = Math.max(0, budgetTokens * CHARS_PER_TOKEN);

  // Keep the longest run of top-ranked files whose per-file cap still gives
  // each a useful allocation within the budget (headers and markers reserved
  // up front). Dropping a file only frees budget for the rest, so whether the
  // first k fit is monotone in k and a binary search finds the longest run.
  // No more files can fit than their reserved overhead alone allows.
  const overheads = [0];
  for (const file of ranked) {
    const next =
      overheads[overheads.length - 1] +
      sectionHeader(file.path).length +
      TRUNCATION_MARKER.length +
      1;
    if (next > budgetChars) break;
    overheads.push(next);
  }
  const capFor = (count: number): number | undefined =>
    count === 0
      ? undefined
      : biggestFirstCap(
          ranked.slice(0, count).map((file) => file.patch.length),
          budgetChars - overheads[count],
        );
  let low = 0;
  let high = overheads.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (capFor(middle) !== undefined) low = middle;
    else high = middle - 1;
  }
  const included = ranked.slice(0, low);
  const cap = capFor(low);

  const omitted = [...ranked.slice(included.length).map((file) => file.path), ...generated];
  let truncated = false;
  const sections = included.map((file) => {
    if (file.patch.length <= (cap ?? 0)) return `${sectionHeader(file.path)}${file.patch}\n`;
    truncated = true;
    return `${sectionHeader(file.path)}${file.patch.slice(0, cap)}${TRUNCATION_MARKER}\n`;
  });

  let text = sections.join('');
  if (included.length === 0) text = '(diff too large for the configured context budget)';
  if (omitted.length > 0) text += omissionNote(omitted);

  return {
    text,
    includedPaths: included.map((file) => file.path),
    omittedPaths: omitted,
    truncated,
  };
}

// --- Patch text → per-file sections ------------------------------------------

/** Undoes git's C-style quoting of a path ("a/t\303\244st \"x\""). */
export function unquoteGitPath(text: string): string {
  if (!(text.startsWith('"') && text.endsWith('"') && text.length >= 2)) return text;
  const bytes: number[] = [];
  const inner = text.slice(1, -1);
  const escapes: Record<string, number> = { n: 10, t: 9, r: 13, b: 8, f: 12, a: 7, v: 11 };
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch !== '\\' || i + 1 >= inner.length) {
      bytes.push(...new TextEncoder().encode(ch));
      continue;
    }
    const next = inner[++i];
    if (/[0-7]/.test(next) && /^[0-7]{3}$/.test(inner.slice(i, i + 3))) {
      bytes.push(parseInt(inner.slice(i, i + 3), 8));
      i += 2;
    } else if (escapes[next] !== undefined) {
      bytes.push(escapes[next]);
    } else {
      bytes.push(...new TextEncoder().encode(next));
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function stripSidePrefix(path: string, side: 'a/' | 'b/'): string {
  return path.startsWith(side) ? path.slice(2) : path;
}

/** The file a `diff --git` section is about: its post-image path from the
 *  `+++` line, the pre-image path for a deletion, or the header otherwise. */
function sectionPath(lines: readonly string[]): string {
  const plus = lines.find((line) => line.startsWith('+++ '));
  const minus = lines.find((line) => line.startsWith('--- '));
  const field = (line: string): string => unquoteGitPath(line.slice(4).replace(/\t.*$/, ''));
  if (plus && field(plus) !== '/dev/null') return stripSidePrefix(field(plus), 'b/');
  if (minus && field(minus) !== '/dev/null') return stripSidePrefix(field(minus), 'a/');
  const rename = lines.find((line) => line.startsWith('rename to '));
  if (rename) return unquoteGitPath(rename.slice('rename to '.length));
  const header = lines[0].slice('diff --git '.length);
  const quoted = /^"(?:[^"\\]|\\.)*" ("(?:[^"\\]|\\.)*")$/.exec(header);
  if (quoted) return stripSidePrefix(unquoteGitPath(quoted[1]), 'b/');
  // Unquoted "a/x b/x": both halves are the same length when unrenamed.
  const half = (header.length - 1) / 2;
  if (Number.isInteger(half) && header[half] === ' ') {
    return stripSidePrefix(header.slice(half + 1), 'b/');
  }
  return header;
}

/** Splits `git diff` output into one DiffFile per file. */
export function splitPatch(patch: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: string[] | undefined;
  const flush = (): void => {
    if (!current) return;
    files.push({ path: sectionPath(current), patch: current.join('\n').trimEnd() });
  };
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush();
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  flush();
  return files;
}
