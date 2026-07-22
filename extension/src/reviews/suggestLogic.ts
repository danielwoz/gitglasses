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
