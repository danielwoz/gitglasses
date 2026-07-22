// Pure logic behind "Suggest Change for Pull Request": selection-to-line
// mapping and suggestion-comment body construction. No vscode imports.

/** A vscode.Selection-shaped range: 0-based lines and characters. */
export interface SelectionLike {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
}

/** 1-based inclusive line range the suggestion replaces. */
export interface SuggestionRange {
  startLine: number;
  endLine: number;
}

/**
 * Map an editor selection to the 1-based line range a suggestion replaces.
 * A selection ending at character 0 of a later line (the common shift-down
 * selection shape) does not include that line's content, so it is excluded.
 */
export function selectionToRange(selection: SelectionLike): SuggestionRange {
  let endLine = selection.endLine;
  if (endLine > selection.startLine && selection.endCharacter === 0) {
    endLine -= 1;
  }
  return { startLine: selection.startLine + 1, endLine: endLine + 1 };
}

export interface SuggestionBodyOptions {
  /** Replacement text for the selected lines. */
  replacement: string;
  /** Optional prose shown above the suggestion block. */
  comment?: string;
  /**
   * GitLab offset syntax: how many lines above the anchor line the suggestion
   * also replaces (```suggestion:-N+0). Omit for GitHub's plain fence, where
   * multi-line ranges are expressed via the API's start_line/line instead.
   */
  gitlabLinesAbove?: number;
}

/** Build the review-comment body containing the ```suggestion fenced block. */
export function buildSuggestionBody(options: SuggestionBodyOptions): string {
  const info =
    options.gitlabLinesAbove !== undefined
      ? `suggestion:-${options.gitlabLinesAbove}+0`
      : 'suggestion';
  // Grow the fence beyond any backtick run inside the replacement.
  let fence = '```';
  while (options.replacement.includes(fence)) {
    fence += '`';
  }
  const replacement = options.replacement.replace(/\n$/, '');
  const block = `${fence}${info}\n${replacement}\n${fence}`;
  const comment = options.comment?.trim();
  return comment ? `${comment}\n\n${block}` : block;
}

/**
 * True when a provider error status means the comment anchor was rejected —
 * i.e. the selected lines are not part of the PR head diff (GitHub 422,
 * GitLab 400).
 */
export function isAnchorRejection(status: number | undefined): boolean {
  return status === 422 || status === 400;
}

/** Grow a backtick fence until it exceeds any run inside the content. */
function fenceFor(content: string): string {
  let fence = '```';
  while (content.includes(fence)) fence += '`';
  return fence;
}

export interface PatchCommentOptions {
  /** File path relative to the repository root. */
  path: string;
  /** 1-based inclusive line range the suggestion targets. */
  startLine: number;
  endLine: number;
  /** Proposed replacement text for the selected lines. */
  replacement: string;
  /** Optional prose explaining the suggestion. */
  comment?: string;
  /** Browser URL of the shared patch (gist/snippet), when shared by link. */
  patchUrl?: string;
  /** Patch file name, when the envelope was saved to a file instead. */
  patchFileName?: string;
}

/**
 * Build the top-level PR comment posted when a suggestion cannot anchor to
 * the diff: describes the targeted lines, carries the prose and the proposed
 * replacement, and links the GitGlasses patch that applies the change.
 */
export function buildPatchCommentBody(options: PatchCommentOptions): string {
  const lines =
    options.startLine === options.endLine
      ? `line ${options.startLine}`
      : `lines ${options.startLine}-${options.endLine}`;
  const parts: string[] = [
    `**Suggested change** for \`${options.path}\` (${lines}) — outside the PR diff, so it is shared as a GitGlasses patch instead of an inline suggestion.`,
  ];
  const comment = options.comment?.trim();
  if (comment) parts.push(comment);
  const fence = fenceFor(options.replacement);
  parts.push(`Proposed replacement:\n${fence}\n${options.replacement.replace(/\n$/, '')}\n${fence}`);
  if (options.patchUrl) {
    parts.push(
      `Apply it with GitGlasses **Apply Patch** from this URL: ${options.patchUrl}`,
    );
  } else {
    const name = options.patchFileName ?? 'the shared .ggpatch file';
    parts.push(
      `Apply it with GitGlasses **Apply Patch** using \`${name}\` (shared separately).`,
    );
  }
  return parts.join('\n\n');
}
